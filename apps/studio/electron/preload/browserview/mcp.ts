import { contextBridge, ipcRenderer } from 'electron';

// Define IPC channels for MCP communication directly in the preload script
// These must match the channel names used in the main process
const MCPChannels = {
    CALL_TOOL: 'mcp:call-tool',
    LIST_TOOLS: 'mcp:list-tools',
    REFRESH_TOOLS: 'mcp:refresh-tools',
};

// Expose MCP functionality to the renderer process
contextBridge.exposeInMainWorld('mcpAPI', {
    /**
     * List all available MCP tools
     * @returns Promise resolving to an array of MCP tools
     */
    listTools: () => ipcRenderer.invoke(MCPChannels.LIST_TOOLS),

    /**
     * Refresh the list of available MCP tools
     * @returns Promise resolving to an array of refreshed MCP tools
     */
    refreshTools: () => ipcRenderer.invoke(MCPChannels.REFRESH_TOOLS),

    /**
     * Call an MCP tool by name with arguments
     * @param toolName The name of the tool to call
     * @param args Arguments to pass to the tool
     * @returns Promise resolving to the result of the tool execution
     */
    callTool: (toolName: string, args: any) =>
        ipcRenderer.invoke(MCPChannels.CALL_TOOL, toolName, args),
});

// Update the global Window interface
declare global {
    interface Window {
        mcpAPI: {
            listTools: () => Promise<any[]>;
            refreshTools: () => Promise<any[]>;
            callTool: (toolName: string, args: any) => Promise<any>;
        };
    }
}
