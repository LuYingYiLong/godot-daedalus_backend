import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerEditorConfigTools } from "./editor-config.js";
import { registerProjectFileResources, registerProjectFileTools } from "./project-files.js";
import { registerProjectLogTools } from "./project-logs.js";
import { registerProjectSettingsTools } from "./project-settings.js";
import { registerSceneTools } from "./scene-tools.js";

export function registerGodotToolsAndResources(server: McpServer): void {
	registerProjectFileTools(server);
	registerProjectLogTools(server);
	registerProjectSettingsTools(server);
	registerEditorConfigTools(server);
	registerProjectFileResources(server);
	registerSceneTools(server);
}
