import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

type FakeMcpServer = {
	tools: Map<string, ToolHandler>;
	resources: Map<string, unknown>;
	registerTool(name: string, _config: unknown, handler: ToolHandler): void;
	registerResource(name: string, ...rest: unknown[]): void;
};

function createFakeServer(): FakeMcpServer {
	return {
		tools: new Map(),
		resources: new Map(),
		registerTool(name: string, _config: unknown, handler: ToolHandler): void {
			this.tools.set(name, handler);
		},
		registerResource(name: string, ...rest: unknown[]): void {
			this.resources.set(name, rest);
		}
	};
}

async function callTool(server: FakeMcpServer, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
	const handler: ToolHandler | undefined = server.tools.get(name);
	assert.notEqual(handler, undefined);
	const result = await handler!(args);
	return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

test("Godot domain modules preserve file, log, and editor config behavior", async (): Promise<void> => {
	const root: string = await fs.mkdtemp(path.join(os.tmpdir(), "daedalus-godot-domain-"));
	const projectRoot: string = path.join(root, "project");
	const appData: string = path.join(root, "appdata");
	const userProfile: string = path.join(root, "profile-user");
	process.env.GODOT_PROJECT_PATH = projectRoot;
	process.env.APPDATA = appData;
	process.env.USERPROFILE = userProfile;

	await fs.mkdir(projectRoot, { recursive: true });
	await fs.mkdir(path.join(appData, "Godot", "app_userdata", "Daedalus Test", "logs"), { recursive: true });
	await fs.mkdir(path.join(appData, "Godot"), { recursive: true });
	await fs.writeFile(path.join(projectRoot, "project.godot"), [
		"[application]",
		"config/name=\"Daedalus Test\"",
		"",
		"[debug]",
		"file_logging/enable_file_logging.pc=true",
		""
	].join("\n"), "utf8");
	await fs.writeFile(path.join(appData, "Godot", "app_userdata", "Daedalus Test", "logs", "godot.log"), [
		"first",
		"second",
		"third"
	].join("\n"), "utf8");
	await fs.writeFile(path.join(appData, "Godot", "editor_settings-4.7.tres"), [
		"[text_editor]",
		`external/editor_path="${path.join(userProfile, "tools", "editor.exe").replaceAll("\\", "/")}"`,
		""
	].join("\n"), "utf8");

	const { registerGodotToolsAndResources } = await import("../../../src/mcp/godot/registration.js");
	const server: FakeMcpServer = createFakeServer();
	registerGodotToolsAndResources(server as never);

	const blockedCreate = await callTool(server, "propose_create_text_file", {
		relativePath: ".godot/blocked.gd",
		content: "extends Node\n"
	});
	assert.equal(blockedCreate.valid, false);

	const proposedCreate = await callTool(server, "propose_create_text_file", {
		relativePath: "scripts/new_script.gd",
		content: "extends Node\n"
	});
	assert.equal(proposedCreate.valid, true);
	await assert.rejects(fs.access(path.join(projectRoot, "scripts", "new_script.gd")));

	const logTail = await callTool(server, "read_project_log", { lines: 2 });
	assert.deepEqual(logTail.lines, ["second", "third"]);

	const editorFiles = await callTool(server, "list_editor_config_files", {});
	const files = editorFiles.files as Array<Record<string, unknown>>;
	assert.ok(files.some((file: Record<string, unknown>): boolean => file.fileId === "global_config:editor_settings-4.7.tres"));

	const editorFile = await callTool(server, "read_editor_config_file", {
		fileId: "global_config:editor_settings-4.7.tres"
	});
	assert.match(String(editorFile.content), /%USERPROFILE%/);
	assert.doesNotMatch(String(editorFile.content), /profile-user/);
});
