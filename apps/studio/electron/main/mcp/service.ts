import { MCPClientManager, type MCPConfig, type MCPTool } from '@onlook/ai/src/mcp';
import { ipcMain } from 'electron';
import { PersistentStorage } from '../storage';

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
     * Initialize the MCP service with the current configuration
     */
    public async initialize(): Promise<void> {
        try {
            const mcpConfig = PersistentStorage.MCP.read();
            if (!mcpConfig) {
                console.log('No MCP configuration found');
                return;
            }

            this.mcpManager = await MCPClientManager.create(mcpConfig);
            this.tools = await this.mcpManager.listAllTools();
            this.isInitialized = true;
            console.log(`MCP initialized with ${this.tools.length} tools`);
        } catch (error) {
            console.error('Failed to initialize MCP:', error);
            this.mcpManager = null;
            this.tools = [];
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
            this.isInitialized = false;
            console.log('MCP service disposed successfully');
        } catch (error) {
            console.error('Error during MCP service disposal:', error);
        }
    }
}

export default MCPService.getInstance();
