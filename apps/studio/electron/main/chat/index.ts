import { PromptProvider } from '@onlook/ai/src/prompt/provider';
import { chatToolSet } from '@onlook/ai/src/tools';
import { LLMProvider, BEDROCK_MODELS } from '@onlook/models';
import MCPService from '../mcp/service';
import {
    ChatSuggestionSchema,
    ChatSummarySchema,
    StreamRequestType,
    type ChatSuggestion,
    type CompletedStreamResponse,
    type PartialStreamResponse,
    type UsageCheckResult,
} from '@onlook/models/chat';
import { MainChannels } from '@onlook/models/constants';
import {
    generateObject,
    streamText,
    tool,
    type CoreMessage,
    type CoreSystemMessage,
    type TextStreamPart,
    type ToolSet,
} from 'ai';
import { z } from 'zod';
import { mainWindow } from '..';
import { PersistentStorage } from '../storage';
import { initModel } from './llmProvider';

class LlmManager {
    private static instance: LlmManager;
    private abortController: AbortController | null = null;
    private useAnalytics: boolean = true;
    private promptProvider: PromptProvider;

    private constructor() {
        this.restoreSettings();
        this.promptProvider = new PromptProvider();
    }

    private restoreSettings() {
        const settings = PersistentStorage.USER_SETTINGS.read() || {};
        const enable = settings.enableAnalytics !== undefined ? settings.enableAnalytics : true;

        if (enable) {
            this.useAnalytics = true;
        } else {
            this.useAnalytics = false;
        }
    }

    public toggleAnalytics(enable: boolean) {
        this.useAnalytics = enable;
    }

    public static getInstance(): LlmManager {
        if (!LlmManager.instance) {
            LlmManager.instance = new LlmManager();
        }
        return LlmManager.instance;
    }

    public async stream(
        messages: CoreMessage[],
        requestType: StreamRequestType,
        options?: {
            abortController?: AbortController;
            skipSystemPrompt?: boolean;
        },
    ): Promise<CompletedStreamResponse> {
        const { abortController, skipSystemPrompt } = options || {};
        this.abortController = abortController || new AbortController();
        try {
            if (!skipSystemPrompt) {
                const systemMessage = {
                    role: 'system',
                    content: this.promptProvider.getSystemPrompt(process.platform),
                    experimental_providerMetadata: {
                        anthropic: { cacheControl: { type: 'ephemeral' } },
                    },
                } as CoreSystemMessage;
                messages = [systemMessage, ...messages];
            }
            const model = await initModel(LLMProvider.BEDROCK_MODELS, BEDROCK_MODELS.SONNET, {
                requestType,
            });

            // Get MCP tools from the service
            let mcpTools: ToolSet = {};
            try {
                mcpTools = await MCPService.getToolSet();
            } catch (error) {
                console.error('Failed to get MCP tools:', error);
            }

            const tools: ToolSet = { ...chatToolSet, ...mcpTools };

            const { usage, fullStream, text, response } = await streamText({
                model,
                messages,
                abortSignal: this.abortController?.signal,
                onError: (error) => {
                    console.error('Error', JSON.stringify(error, null, 2));
                    throw error;
                },
                maxSteps: 10,
                tools: tools,
                maxTokens: 64000,
                headers: {
                    'anthropic-beta': 'output-128k-2025-02-19',
                },
            });
            const streamParts: TextStreamPart<ToolSet>[] = [];
            for await (const partialStream of fullStream) {
                this.emitMessagePart(partialStream);
                streamParts.push(partialStream);
            }
            return {
                payload: (await response).messages,
                type: 'full',
                usage: await usage,
                text: await text,
            };
        } catch (error: any) {
            try {
                console.error('Error', error);
                if (error?.error?.statusCode) {
                    if (error?.error?.statusCode === 403) {
                        const rateLimitError = JSON.parse(
                            error.error.responseBody,
                        ) as UsageCheckResult;
                        return {
                            type: 'rate-limited',
                            rateLimitResult: rateLimitError,
                        };
                    } else {
                        return {
                            type: 'error',
                            message: error.error.responseBody,
                        };
                    }
                }
                const errorMessage = this.getErrorMessage(error);
                return { message: errorMessage, type: 'error' };
            } catch (error) {
                console.error('Error parsing error', error);
                return { message: 'An unknown error occurred', type: 'error' };
            } finally {
                this.abortController = null;
            }
        }
    }

    public abortStream(): boolean {
        if (this.abortController) {
            this.abortController.abort();
            return true;
        }
        return false;
    }

    private emitMessagePart(streamPart: TextStreamPart<ToolSet>) {
        const res: PartialStreamResponse = {
            type: 'partial',
            payload: streamPart,
        };
        mainWindow?.webContents.send(MainChannels.CHAT_STREAM_PARTIAL, res);
    }

    private getErrorMessage(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }
        if (typeof error === 'string') {
            return error;
        }
        if (error instanceof Response) {
            return error.statusText;
        }
        if (error && typeof error === 'object' && 'message' in error) {
            return String(error.message);
        }
        return 'An unknown error occurred';
    }

    /**
     * Convert MCP tools to ToolSet format for the AI SDK
     */
    private async convertMCPToolsToToolSet(mcpTools: any[]): Promise<ToolSet> {
        const toolSet: ToolSet = {};

        for (const mcpTool of mcpTools) {
            const toolName = `${mcpTool.server}-${mcpTool.name}`;

            toolSet[toolName] = tool({
                description: mcpTool.description || '',
                parameters: this.convertJsonSchemaToZod(mcpTool.input_schema),
                execute: async (args: Record<string, unknown>) => {
                    try {
                        const result = await MCPService.callTool(toolName, args);
                        return result;
                    } catch (error) {
                        return `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
                    }
                },
            });
        }

        return toolSet;
    }

    /**
     * Convert JSON Schema to Zod schema
     */
    private convertJsonSchemaToZod(schema: any): z.ZodTypeAny {
        if (!schema || !schema.properties) {
            return z.object({});
        }

        const zodSchema: Record<string, z.ZodTypeAny> = {};
        const required = schema.required || [];

        for (const [key, prop] of Object.entries<any>(schema.properties)) {
            let zodProp;

            switch (prop.type) {
                case 'string':
                    zodProp = z.string();
                    if (prop.enum) {
                        zodProp = z.enum(prop.enum);
                    }
                    break;
                case 'number':
                    zodProp = z.number();
                    break;
                case 'integer':
                    zodProp = z.number().int();
                    break;
                case 'boolean':
                    zodProp = z.boolean();
                    break;
                case 'array':
                    if (prop.items) {
                        zodProp = z.array(this.convertJsonSchemaToZod(prop.items));
                    } else {
                        zodProp = z.array(z.any());
                    }
                    break;
                case 'object':
                    zodProp = this.convertJsonSchemaToZod(prop);
                    break;
                default:
                    zodProp = z.any();
            }

            if (prop.description) {
                zodProp = zodProp.describe(prop.description);
            }

            if (!required.includes(key)) {
                zodProp = zodProp.optional();
            }

            zodSchema[key] = zodProp;
        }

        return z.object(zodSchema);
    }

    public async generateSuggestions(messages: CoreMessage[]): Promise<ChatSuggestion[]> {
        try {
            const model = await initModel(LLMProvider.BEDROCK_MODELS, BEDROCK_MODELS.SONNET, {
                requestType: StreamRequestType.SUGGESTIONS,
            });

            const { object } = await generateObject({
                model,
                output: 'array',
                schema: ChatSuggestionSchema,
                messages,
            });
            return object as ChatSuggestion[];
        } catch (error) {
            console.error(error);
            return [];
        }
    }

    public async generateChatSummary(messages: CoreMessage[]): Promise<string | null> {
        try {
            const model = await initModel(LLMProvider.BEDROCK_MODELS, BEDROCK_MODELS.SONNET, {
                requestType: StreamRequestType.SUMMARY,
            });

            const systemMessage: CoreSystemMessage = {
                role: 'system',
                content: this.promptProvider.getSummaryPrompt(),
                experimental_providerMetadata: {
                    anthropic: { cacheControl: { type: 'ephemeral' } },
                },
            };

            // Transform messages to emphasize they are historical content
            const conversationMessages = messages
                .filter((msg) => msg.role !== 'tool')
                .map((msg) => {
                    const prefix = '[HISTORICAL CONTENT] ';
                    const content =
                        typeof msg.content === 'string' ? prefix + msg.content : msg.content;

                    return {
                        ...msg,
                        content,
                    };
                });

            const { object } = await generateObject({
                model,
                schema: ChatSummarySchema,
                messages: [
                    { role: 'system', content: systemMessage.content as string },
                    ...conversationMessages.map((msg) => ({
                        role: msg.role,
                        content: msg.content as string,
                    })),
                ],
            });

            const {
                filesDiscussed,
                projectContext,
                implementationDetails,
                userPreferences,
                currentStatus,
            } = object as z.infer<typeof ChatSummarySchema>;

            // Formats the structured object into the desired text format
            const summary = `# Files Discussed
${filesDiscussed.join('\n')}

# Project Context
${projectContext}

# Implementation Details
${implementationDetails}

# User Preferences
${userPreferences}

# Current Status
${currentStatus}`;

            return summary;
        } catch (error) {
            console.error('Error generating summary:', error);
            return null;
        }
    }
}

export default LlmManager.getInstance();
