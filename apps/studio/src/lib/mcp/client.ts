import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

/**
 * Interface for MCP tool metadata
 */
interface MCPTool {
    name: string;
    description: string;
    input_schema: any;
    server: string;
}

/**
 * Client for interacting with MCP tools from the renderer process
 */
export class MCPClient {
    private static instance: MCPClient;
    private tools: MCPTool[] = [];

    private constructor() {}

    public static getInstance(): MCPClient {
        if (!MCPClient.instance) {
            MCPClient.instance = new MCPClient();
        }
        return MCPClient.instance;
    }

    /**
     * Initialize the client by fetching available tools
     */
    public async initialize(): Promise<void> {
        try {
            if (!window.mcpAPI) {
                console.warn('MCP API not available in renderer process');
                return;
            }

            this.tools = await window.mcpAPI.listTools();
        } catch (error) {
            console.error('Failed to initialize MCP client:', error);
            this.tools = [];
        }
    }

    /**
     * Refresh the list of available tools
     */
    public async refreshTools(): Promise<void> {
        try {
            if (!window.mcpAPI) {
                console.warn('MCP API not available in renderer process');
                return;
            }

            this.tools = await window.mcpAPI.refreshTools();
        } catch (error) {
            console.error('Failed to refresh MCP tools:', error);
        }
    }

    /**
     * Call an MCP tool by name with arguments
     */
    public async callTool(toolName: string, args: any): Promise<any> {
        try {
            if (!window.mcpAPI) {
                throw new Error('MCP API not available in renderer process');
            }

            return await window.mcpAPI.callTool(toolName, args);
        } catch (error) {
            console.error(`Error calling MCP tool ${toolName}:`, error);
            throw error;
        }
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

    /**
     * Get all MCP tools as a ToolSet compatible with the Vercel AI SDK
     */
    public async getToolSet(): Promise<ToolSet> {
        if (this.tools.length === 0) {
            await this.initialize();
        }

        const toolSet: ToolSet = {};

        for (const mcpTool of this.tools) {
            const toolName = `${mcpTool.server}-${mcpTool.name}`;

            toolSet[toolName] = tool({
                description: mcpTool.description,
                parameters: this.convertJsonSchemaToZod(mcpTool.input_schema),
                execute: async (args) => {
                    try {
                        const result = await this.callTool(toolName, args);
                        return result;
                    } catch (error) {
                        return `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
                    }
                },
            });
        }

        return toolSet;
    }
}

export default MCPClient.getInstance();
