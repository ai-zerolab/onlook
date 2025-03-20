import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { experimental_createMCPClient, type ToolSet } from 'ai';

/**
 * Interface for server parameters with disabled flag
 */
export interface ManagedParameters {
    disabled: boolean;
}

/**
 * Interface for stdio server parameters
 */
export interface StdioServerParameters {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
}

/**
 * Combined interface for managed stdio server parameters
 */
export interface ManagedStdioServerParameters extends ManagedParameters, StdioServerParameters {}

export interface ManagedSseServerParameters extends ManagedParameters {
    url: string;
}

/**
 * Configuration for MCP servers
 */
export interface MCPConfig {
    mcpServers: Record<string, ManagedStdioServerParameters | ManagedSseServerParameters>;
}

/**
 * Interface for MCP tool metadata
 */
export interface MCPTool {
    name: string;
    description: string;
    input_schema: any;
    server: string;
}

/**
 * Manager for MCP clients using the AI package's experimental MCP client
 */
export class MCPClientManager {
    private config: MCPConfig;
    private clients: Record<string, any> = {};
    private tools: MCPTool[] = [];
    private toolsCache: Record<string, any> = {};
    private serverToEscapedMap: Record<string, string> = {};
    private escapedToServerMap: Record<string, string> = {};

    constructor(config: MCPConfig) {
        this.config = config;
    }

    /**
     * Create a new MCPClientManager instance
     */
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
                if (value.disabled) {
                    console.warn(`Server ${key} is disabled, skipping initialization.`);
                    return;
                }
                if ('command' in value) {
                    await this.initializeStdioClient(key, value as ManagedStdioServerParameters);
                } else {
                    await this.initializeSseClient(key, value as ManagedSseServerParameters);
                }
            }),
        );
    }
    private async initializeSseClient(
        key: string,
        params: ManagedSseServerParameters,
    ): Promise<void> {
        const escapedKey = this.escapeServerName(key);

        // Store mapping between original and escaped server names
        this.serverToEscapedMap[key] = escapedKey;
        this.escapedToServerMap[escapedKey] = key;

        try {
            // Create MCP client
            const client = await experimental_createMCPClient({
                transport: {
                    type: 'sse',
                    url: params.url,
                },
            });

            this.clients[escapedKey] = client;
            console.log(`Successfully connected to MCP server: ${key}`);
        } catch (e) {
            console.error(`Error connecting to MCP server ${key}:`, e);
        }
    }

    /**
     * Initialize a stdio client
     */
    private async initializeStdioClient(
        key: string,
        params: ManagedStdioServerParameters,
    ): Promise<void> {
        const escapedKey = this.escapeServerName(key);

        // Store mapping between original and escaped server names
        this.serverToEscapedMap[key] = escapedKey;
        this.escapedToServerMap[escapedKey] = key;

        try {
            // Create transport with the server parameters
            // Combine params.env with process.env, giving priority to params.env
            // Filter out undefined values and ensure all values are strings
            const combinedEnv: Record<string, string> = {};

            // Add process.env values (filtering out undefined)
            for (const [key, value] of Object.entries(process.env)) {
                if (value !== undefined) {
                    combinedEnv[key] = value;
                }
            }

            // Add params.env values (overriding process.env if duplicates)
            if (params.env) {
                for (const [key, value] of Object.entries(params.env)) {
                    if (value !== undefined) {
                        combinedEnv[key] = value;
                    }
                }
            }
            const transport = new StdioClientTransport({
                command: params.command,
                args: params.args || [],
                env: combinedEnv,
                cwd: params.cwd,
            });
            // Create MCP client
            const client = await experimental_createMCPClient({
                transport,
            });

            this.clients[escapedKey] = client;
            console.log(`Successfully connected to MCP server: ${key}`);
        } catch (e) {
            console.error(`Error connecting to MCP server ${key}:`, e);
        }
    }

    /**
     * Call a tool by its definition name
     */
    public async callTool(toolDefinitionName: string, args: any): Promise<any> {
        const [escapedServerName, toolName] = this.dispatchToolDefinitionName(toolDefinitionName);
        const client = this.clients[escapedServerName];

        if (!client) {
            throw new Error(`No client found for server: ${escapedServerName}`);
        }

        try {
            // Get the tool function from cache or fetch it
            let toolFn = this.toolsCache[toolDefinitionName];
            if (!toolFn) {
                const toolSet = await client.tools();
                toolFn = toolSet[toolName];
                if (!toolFn) {
                    throw new Error(`Tool not found: ${toolName}`);
                }
                this.toolsCache[toolDefinitionName] = toolFn;
            }

            // Execute the tool with the provided arguments
            return await toolFn.execute(args);
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
            Object.entries(this.clients).map(async ([key, client]) => {
                try {
                    await client.close();
                } catch (e) {
                    console.error(`Error closing client ${key}:`, e);
                }
            }),
        );
        this.clients = {};
        this.tools = [];
        this.toolsCache = {};
        this.serverToEscapedMap = {};
        this.escapedToServerMap = {};
    }

    /**
     * Escape server name to follow the pattern [a-zA-Z0-9_]+
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
     */
    public async listAllTools(): Promise<MCPTool[]> {
        // If tools are already fetched, return them
        if (this.tools.length > 0) {
            return this.tools;
        }

        const toolPromises = Object.entries(this.clients).map(async ([serverName, client]) => {
            try {
                const toolSet = await client.tools();
                return Object.entries(toolSet).map(([name, toolObj]: [string, any]) => ({
                    name,
                    description: toolObj.description || '',
                    input_schema: toolObj.parameters?._def?.schema || {},
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
     * Parse a tool definition name to extract server name and tool name
     */
    private dispatchToolDefinitionName(toolDefinitionName: string): [string, string] {
        const [escapedServerName, ...toolNameParts] = toolDefinitionName.split('-');
        const toolName = toolNameParts.join('-'); // Handle tool names that might contain hyphens
        return [escapedServerName, toolName];
    }

    /**
     * Get all MCP tools as a ToolSet compatible with the AI SDK
     */
    public async getToolSet(): Promise<ToolSet> {
        const allTools: ToolSet = {};

        // Collect tools from all clients
        for (const [serverName, client] of Object.entries(this.clients)) {
            try {
                const toolSet = await client.tools();

                // Add each tool to the combined toolset with server prefix
                for (const [toolName, toolObj] of Object.entries(toolSet)) {
                    const prefixedName = `${serverName}-${toolName}`;
                    allTools[prefixedName] = toolObj as any;
                }
            } catch (e) {
                console.error(`Failed to get tools for ${serverName}:`, e);
            }
        }

        return allTools;
    }
}
