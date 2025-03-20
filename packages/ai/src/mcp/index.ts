// import { URL } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
    StdioClientTransport,
    type StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';
// import {
//     SSEClientTransport,
//     type SSEClientTransportOptions,
// } from '@modelcontextprotocol/sdk/client/sse.js';
// import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

export interface ManagedParameters {
    disabled: boolean;
}

// export interface SSEServerParameters extends ManagedParameters {
//     url: URL;
//     opts?: SSEClientTransportOptions;
// }

// export interface ManagedSSEServerParameters extends ManagedParameters, SSEServerParameters {}

// export interface ManagedWebsocketServerParameters extends ManagedParameters {
//     url: URL;
// }

export interface ManagedStdioServerParameters extends ManagedParameters, StdioServerParameters {}

export interface MCPConfig {
    mcpServers: Record<
        string,
        ManagedStdioServerParameters
        // | ManagedSSEServerParameters | ManagedWebsocketServerParameters
    >;
}

export interface MCPTool {
    name: string;
    description: string;
    input_schema: any;
    server: string;
}

interface ToolDefinition {
    name: string;
    description: string;
    parameters_json_schema: any;
}

export class MCPClientManager {
    private config: MCPConfig;
    private clients: Record<string, Client> = {};
    private tools: MCPTool[] = [];
    private serverToEscapedMap: Record<string, string> = {};
    private escapedToServerMap: Record<string, string> = {};

    constructor(config: MCPConfig) {
        this.config = config;
    }

    public static async create(config: MCPConfig): Promise<MCPClientManager> {
        const manager = new MCPClientManager(config);
        await manager.initializeClients();
        await manager.initializeTools();
        return manager;
    }

    /**
     * Initialize tools from all connected clients
     */
    private async initializeTools(): Promise<void> {
        try {
            await this.listAllTools();
        } catch (e) {
            console.error('Error initializing tools:', e);
        }
    }

    /**
     * Initialize all MCP clients based on configuration
     */
    private async initializeClients(): Promise<void> {
        await Promise.all(
            Object.entries(this.config.mcpServers).map(async ([key, value]) => {
                if (!value.disabled) {
                    await this.initializeStdioClient(key, value as ManagedStdioServerParameters);
                }
            }),
        );

        // if ('url' in value) {
        //     if (value.url.protocol.startsWith('http')) {
        //         this.initializeSSEClient(key, value as ManagedSSEServerParameters);
        //     } else {
        //         this.initializeWebSocketClient(key, value as ManagedWebsocketServerParameters);
        //     }
        // } else {
        //     this.initializeStdioClient(key, value as ManagedStdioServerParameters);
        // }
    }

    /**
     * Initialize an SSE client
     */
    // private initializeSSEClient(key: string, params: ManagedSSEServerParameters): void {
    //     const transport = new SSEClientTransport(params.url, params.opts);
    //     this.createAndConnectClient(key, transport);
    // }

    // /**
    //  * Initialize a WebSocket client
    //  */
    // private initializeWebSocketClient(key: string, params: ManagedWebsocketServerParameters): void {
    //     const transport = new WebSocketClientTransport(params.url);
    //     this.createAndConnectClient(key, transport);
    // }

    /**
     * Initialize a stdio client
     */
    private async initializeStdioClient(
        key: string,
        params: ManagedStdioServerParameters,
    ): Promise<void> {
        const transport = new StdioClientTransport(params);
        await this.createAndConnectClient(key, transport);
    }

    /**
     * Create a client and connect it with the provided transport
     */
    private async createAndConnectClient(
        key: string,
        transport: StdioClientTransport,
        // | SSEClientTransport | WebSocketClientTransport |
    ): Promise<void> {
        const client = new Client({ name: key, version: '1.0.0' });
        const escapedKey = this.escapeServerName(key);

        // Store mapping between original and escaped server names
        this.serverToEscapedMap[key] = escapedKey;
        this.escapedToServerMap[escapedKey] = key;

        // Handle the async connect properly
        try {
            await client.connect(transport);
            this.clients[escapedKey] = client;
        } catch (e) {
            console.error(`Error connecting to server ${key}:`, e);
        }
    }

    /**
     * Call a tool by its definition name
     * @param toolDefinitionName The prefixed tool name (e.g., "server-toolname")
     * @param args Arguments to pass to the tool
     * @returns Result of the tool execution
     */
    public async callTool(toolDefinitionName: string, args: any): Promise<any> {
        const [escapedServerName, toolName] = this.dispatchToolDefinitionName(toolDefinitionName);
        const client = this.clients[escapedServerName];

        if (!client) {
            throw new Error(`No client found for server: ${escapedServerName}`);
        }

        try {
            const result = await client.callTool({
                name: toolName,
                arguments: args,
            });
            return result;
        } catch (e) {
            console.error(`Error calling tool ${toolName} on server ${escapedServerName}:`, e);
            throw e;
        }
    }

    /**
     * Close all MCP clients
     */
    public async close(): Promise<void> {
        await Promise.all(
            Object.values(this.clients).map((client) =>
                client.close().catch((e) => console.error('Error closing client:', e)),
            ),
        );
        this.clients = {};
        this.tools = [];
        this.serverToEscapedMap = {};
        this.escapedToServerMap = {};
    }

    /**
     * Escape server name to follow the pattern [a-zA-Z0-9_]+
     * Convert invalid characters to their ASCII code with prefix '_'
     * @param serverName The server name to escape
     * @returns Escaped server name
     */
    private escapeServerName(serverName: string): string {
        return serverName
            .split('')
            .map((c) => {
                if (/[a-zA-Z0-9_]/.test(c)) {
                    return c;
                } else {
                    return `_${c.charCodeAt(0).toString(16)}`;
                }
            })
            .join('');
    }

    /**
     * List all available tools from all connected MCP clients
     * @returns Promise resolving to an array of MCPTool objects
     */
    public async listAllTools(): Promise<MCPTool[]> {
        // If tools are already fetched, return them
        if (this.tools.length > 0) {
            return this.tools;
        }

        const toolPromises = Object.entries(this.clients).map(async ([serverName, client]) => {
            try {
                const toolsResult = await client.listTools();
                return toolsResult.tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description || '',
                    input_schema: tool.inputSchema,
                    server: serverName,
                }));
            } catch (e) {
                console.error(`Failed to list tools for ${serverName}:`, e);
                return [];
            }
        });

        const toolsArrays = await Promise.all(toolPromises);
        this.tools = toolsArrays.flat();

        console.log(
            'Available MCP tools:',
            this.tools.map(({ name, server }) => `${name} (${server})`),
        );

        return this.tools;
    }

    /**
     * Get tool definitions with server name prefixes
     * @param serverName The name of the server
     * @param tools The list of tools from the server
     * @returns List of tool definitions with prefixed names
     */
    private getToolDefinitions(serverName: string, tools: any[]): ToolDefinition[] {
        const escapedServerName = this.escapeServerName(serverName);
        return tools.map((tool) => ({
            name: `${escapedServerName}-${tool.name}`,
            description: tool.description || '',
            parameters_json_schema: tool.inputSchema,
        }));
    }

    /**
     * Parse a tool definition name to extract server name and tool name
     * @param toolDefinitionName The prefixed tool name (e.g., "server-toolname")
     * @returns A tuple of [serverName, toolName]
     */
    private dispatchToolDefinitionName(toolDefinitionName: string): [string, string] {
        const [escapedServerName, ...toolNameParts] = toolDefinitionName.split('-');
        const toolName = toolNameParts.join('-'); // Handle tool names that might contain hyphens

        // Note: We can't reliably convert the escaped server name back to the original
        // since multiple server names could escape to the same value
        // The caller would need to maintain a mapping of escaped to original names

        return [escapedServerName, toolName];
    }

    /**
     * Get all MCP tools as a ToolSet compatible with the Vercel AI SDK
     * @returns A ToolSet object containing all MCP tools
     */
    public async getToolSet(): Promise<ToolSet> {
        const mcpTools = await this.listAllTools();
        const toolSet: ToolSet = {};

        for (const mcpTool of mcpTools) {
            const escapedServerName = this.escapeServerName(mcpTool.server);
            const toolName = `${escapedServerName}-${mcpTool.name}`;

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

    /**
     * Helper method to convert JSON Schema to Zod schema
     * @param schema JSON Schema object
     * @returns Zod schema
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
}
