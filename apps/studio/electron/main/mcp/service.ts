import { MCPClientManager, type MCPConfig, type MCPTool } from '@onlook/ai/src/mcp';
import { ipcMain } from 'electron';
import { existsSync } from 'fs';
import { PersistentStorage } from '../storage';
import { type ToolSet } from 'ai';

// Define IPC channels for MCP communication
export enum MCPChannels {
    CALL_TOOL = 'mcp:call-tool',
    LIST_TOOLS = 'mcp:list-tools',
    REFRESH_TOOLS = 'mcp:refresh-tools',
}

class MCPService {
    private static instance: MCPService;
    private mcpManager: MCPClientManager | null = null;
    private tools: MCPTool[] = [];
    private toolSet: ToolSet = {};
    private isInitialized = false;

    private constructor() {
        this.setupIpcHandlers();
    }

    public static getInstance(): MCPService {
        if (!MCPService.instance) {
            MCPService.instance = new MCPService();
        }
        return MCPService.instance;
    }

    /**
     * Validate server configuration and ensure PATH is included in environment
     * @param config MCP configuration to validate
     * @returns Validated configuration or null if invalid
     */
    private validateConfig(config: MCPConfig): MCPConfig | null {
        if (!config || !config.mcpServers || typeof config.mcpServers !== 'object') {
            console.error('Invalid MCP configuration: missing or invalid mcpServers');
            return null;
        }

        const validatedConfig: MCPConfig = {
            mcpServers: {},
        };

        // Validate each server configuration
        for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
            // Skip disabled servers
            if (serverConfig.disabled) {
                validatedConfig.mcpServers[serverName] = serverConfig;
                continue;
            }

            // Validate command
            if (!serverConfig.command) {
                console.error(`Invalid server configuration for ${serverName}: missing command`);
                continue;
            }

            // Check if command exists and is executable
            try {
                if (!existsSync(serverConfig.command)) {
                    console.warn(
                        `Warning: Command path for ${serverName} may not exist: ${serverConfig.command}`,
                    );
                    // We don't fail here as the command might be in PATH
                }
            } catch (error) {
                console.warn(`Could not verify command path for ${serverName}:`, error);
            }

            // Ensure PATH is included in environment
            const updatedConfig = { ...serverConfig };
            if (!updatedConfig.env) {
                updatedConfig.env = {};
            }

            // Preserve PATH from process.env if it's not already set
            if (!updatedConfig.env.PATH && process.env.PATH) {
                console.log(`Adding PATH environment variable to ${serverName} configuration`);
                updatedConfig.env.PATH = process.env.PATH;
            }

            // Add other important environment variables if needed
            if (process.platform === 'darwin' && !updatedConfig.env.HOME && process.env.HOME) {
                updatedConfig.env.HOME = process.env.HOME;
            }

            // Add validated server config
            validatedConfig.mcpServers[serverName] = updatedConfig;
        }

        return validatedConfig;
    }

    /**
     * Initialize the MCP service with the current configuration
     */
    public async initialize(): Promise<void> {
        try {
            // Clear any existing state
            if (this.mcpManager) {
                await this.dispose();
            }

            // Read and validate configuration
            const mcpConfig = PersistentStorage.MCP.read();
            if (!mcpConfig) {
                console.log('No MCP configuration found');
                return;
            }

            // Validate configuration
            const validatedConfig = this.validateConfig(mcpConfig);
            if (!validatedConfig) {
                console.error('MCP configuration validation failed');
                return;
            }

            console.log('Creating MCP client manager...');

            // Log environment variables for debugging
            for (const [serverName, serverConfig] of Object.entries(validatedConfig.mcpServers)) {
                if (!serverConfig.disabled) {
                    console.log(`Server ${serverName} environment:`, {
                        PATH: serverConfig.env?.PATH
                            ? `${serverConfig.env.PATH.substring(0, 50)}...`
                            : 'undefined',
                        HOME: serverConfig.env?.HOME || 'undefined',
                        command: serverConfig.command,
                        args: serverConfig.args,
                    });
                }
            }

            this.mcpManager = await MCPClientManager.create(validatedConfig);

            console.log('Fetching MCP tools...');
            this.tools = await this.mcpManager.listAllTools();

            // Get the tool set for direct use with streamText
            this.toolSet = await this.mcpManager.getToolSet();

            this.isInitialized = true;
            console.log(`MCP initialized with ${this.tools.length} tools`);
        } catch (error) {
            console.error('Failed to initialize MCP:', error);
            // Clean up resources on failure
            if (this.mcpManager) {
                try {
                    await this.mcpManager.close();
                } catch (closeError) {
                    console.error(
                        'Error closing MCP manager during initialization failure:',
                        closeError,
                    );
                }
            }
            this.mcpManager = null;
            this.tools = [];
            this.toolSet = {};
            this.isInitialized = false;
        }
    }

    /**
     * Set up IPC handlers for renderer process communication
     */
    // Store IPC handler references for cleanup
    private ipcHandlers: Map<string, (...args: any[]) => Promise<any>> = new Map();

    private setupIpcHandlers(): void {
        // Handle tool calls from renderer
        const callToolHandler = async (_event: any, toolName: string, args: any) => {
            if (!this.mcpManager) {
                try {
                    await this.initialize();
                    if (!this.mcpManager) {
                        throw new Error('MCP not initialized');
                    }
                } catch (error) {
                    console.error('Failed to initialize MCP for tool call:', error);
                    throw new Error('Failed to initialize MCP');
                }
            }

            try {
                const result = await this.mcpManager.callTool(toolName, args);
                return result;
            } catch (error) {
                console.error(`Error calling MCP tool ${toolName}:`, error);
                throw error;
            }
        };

        // Handle tool listing requests from renderer
        const listToolsHandler = async () => {
            if (!this.isInitialized) {
                try {
                    await this.initialize();
                } catch (error) {
                    console.error('Failed to initialize MCP for tool listing:', error);
                    return [];
                }
            }
            return this.tools;
        };

        // Handle refresh requests from renderer
        const refreshToolsHandler = async () => {
            try {
                await this.initialize();
                return this.tools;
            } catch (error) {
                console.error('Failed to refresh MCP tools:', error);
                return [];
            }
        };

        // Register handlers and store references
        ipcMain.handle(MCPChannels.CALL_TOOL, callToolHandler);
        ipcMain.handle(MCPChannels.LIST_TOOLS, listToolsHandler);
        ipcMain.handle(MCPChannels.REFRESH_TOOLS, refreshToolsHandler);

        // Store handler references for cleanup
        this.ipcHandlers.set(MCPChannels.CALL_TOOL, callToolHandler);
        this.ipcHandlers.set(MCPChannels.LIST_TOOLS, listToolsHandler);
        this.ipcHandlers.set(MCPChannels.REFRESH_TOOLS, refreshToolsHandler);
    }

    /**
     * Get all available MCP tools
     */
    public async getTools(): Promise<MCPTool[]> {
        if (!this.isInitialized) {
            await this.initialize();
        }
        return this.tools;
    }

    /**
     * Get the tool set for direct use with streamText
     */
    public async getToolSet(): Promise<ToolSet> {
        if (!this.isInitialized) {
            await this.initialize();
        }
        return this.toolSet;
    }

    /**
     * Call an MCP tool by name with arguments
     */
    public async callTool(toolName: string, args: any): Promise<any> {
        if (!this.mcpManager) {
            await this.initialize();
            if (!this.mcpManager) {
                throw new Error('MCP not initialized');
            }
        }

        return this.mcpManager.callTool(toolName, args);
    }

    /**
     * Clean up resources when the app is closing
     */
    public async dispose(): Promise<void> {
        try {
            // Remove all IPC handlers first
            for (const [channel] of this.ipcHandlers) {
                try {
                    ipcMain.removeHandler(channel);
                } catch (error) {
                    console.error(`Error removing IPC handler for ${channel}:`, error);
                }
            }
            this.ipcHandlers.clear();

            // Then close the MCP manager if it exists
            if (this.mcpManager) {
                try {
                    await this.mcpManager.close();
                } catch (error) {
                    console.error('Error closing MCP manager:', error);
                }
                this.mcpManager = null;
            }

            this.tools = [];
            this.toolSet = {};
            this.isInitialized = false;
            console.log('MCP service disposed successfully');
        } catch (error) {
            console.error('Error during MCP service disposal:', error);
        }
    }
}

export default MCPService.getInstance();
