import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerEditorConfigTools } from "./tools/editor-config.js";
import { registerProjectFileResources, registerProjectFileTools } from "./tools/project-files.js";
import { registerProjectLogTools } from "./tools/project-logs.js";
import { registerProjectSettingsTools } from "./tools/project-settings.js";
import { registerSceneTools } from "./tools/scene-tools.js";

export function registerGodotToolsAndResources(server: McpServer): void {
	registerProjectFileTools(server);
	registerProjectLogTools(server);
	registerProjectSettingsTools(server);
	registerEditorConfigTools(server);
	registerProjectFileResources(server);
	registerSceneTools(server);
}
