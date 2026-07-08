import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { GodotEditorBridge } from "../src/mcp/godot/bridges/editor-bridge.js";
import { withMcpRequestContext } from "../src/mcp/request-context.js";
import { createClientSession } from "../src/server/client-session.js";
import { beginSessionRun, finishSessionRun, registerClientConnection, subscribeSocketToSession, updateClientConnection } from "../src/server/client-connections.js";
import { sendSessionEvent } from "../src/server/session-events.js";
import { clearDynamicMcpToolsForWorkspace, getDynamicMcpToolMapping, getDynamicMcpToolNames, replaceDynamicMcpToolsForWorkspace } from "../src/tools/dynamic-mcp-tools.js";

type SocketMock = WebSocket & { sent: Array<Record<string, unknown>> };

function createSocket(): SocketMock {
	const sent: Array<Record<string, unknown>> = [];
	return {
		readyState: WebSocket.OPEN,
		sent,
		send(message: string): void {
			sent.push(JSON.parse(message) as Record<string, unknown>);
		}
	} as SocketMock;
}

test("studio connection does not replace Godot editor tool target", async (): Promise<void> => {
	const bridge = new GodotEditorBridge();
	const godotSocket = createSocket();
	const studioSocket = createSocket();
	bridge.updateInstanceContext(godotSocket, "workspace-a", "editor-a", {
		activeScenePath: "res://main.tscn"
	}, "Godot A");

	updateClientConnection(registerSocket(studioSocket), {
		clientType: "studio",
		clientName: "Daedalus Studio",
		capabilities: { sessionSubscribe: true, approval: true, inlineDiffView: true }
	});

	const toolPromise = withMcpRequestContext({
		workspaceId: "workspace-a",
		editorInstanceId: "editor-a"
	}, async (): Promise<unknown> => bridge.callTool("apply_scene_patch", {
		operations: [{ type: "set_property" }]
	}));
	const requested = godotSocket.sent.find((message: Record<string, unknown>): boolean => message.event === "editor.tool.requested");
	assert.ok(requested);
	assert.equal(studioSocket.sent.some((message: Record<string, unknown>): boolean => message.event === "editor.tool.requested"), false);
	const data = requested.data as Record<string, unknown>;
	assert.equal(data.editorInstanceId, "editor-a");
	assert.equal(bridge.handleToolResult(String(data.callId), true, { ok: true }, undefined), true);
	const result = await toolPromise;
	assert.deepEqual(result, {
		content: [{
			type: "text",
			text: JSON.stringify({ ok: true, result: { ok: true } }, null, 2)
		}]
	});
});

test("multiple Godot editors require an explicit session editor binding", async (): Promise<void> => {
	const bridge = new GodotEditorBridge();
	const socketA = createSocket();
	const socketB = createSocket();
	bridge.updateInstanceContext(socketA, "workspace-a", "editor-a", {}, "Godot A");
	bridge.updateInstanceContext(socketB, "workspace-a", "editor-b", {}, "Godot B");

	await assert.rejects(
		withMcpRequestContext({ workspaceId: "workspace-a" }, async (): Promise<unknown> => {
			return await bridge.callTool("apply_scene_patch", { operations: [{ type: "set_property" }] });
		}),
		/editor_target_required/
	);

	const toolPromise = withMcpRequestContext({
		workspaceId: "workspace-a",
		editorInstanceId: "editor-b"
	}, async (): Promise<unknown> => bridge.callTool("apply_scene_patch", {
		operations: [{ type: "set_property" }]
	}));
	const requested = socketB.sent.find((message: Record<string, unknown>): boolean => message.event === "editor.tool.requested");
	assert.ok(requested);
	assert.equal(socketA.sent.some((message: Record<string, unknown>): boolean => message.event === "editor.tool.requested"), false);
	const data = requested.data as Record<string, unknown>;
	assert.equal(bridge.handleToolResult(String(data.callId), true, { ok: true }, undefined), true);
	await toolPromise;
});

test("filesystem refresh broadcasts to online Godot editors in the workspace", async (): Promise<void> => {
	const bridge = new GodotEditorBridge();
	const socketA = createSocket();
	const socketB = createSocket();
	const socketOther = createSocket();
	bridge.updateInstanceContext(socketA, "workspace-a", "editor-a", {}, "Godot A");
	bridge.updateInstanceContext(socketB, "workspace-a", "editor-b", {}, "Godot B");
	bridge.updateInstanceContext(socketOther, "workspace-b", "editor-other", {}, "Godot Other");

	const refreshPromise = withMcpRequestContext({ workspaceId: "workspace-a" }, async (): Promise<unknown[] | null> => {
		return await bridge.refreshFilesystem(["project.godot"]);
	});
	const requestedA = socketA.sent.find((message: Record<string, unknown>): boolean => message.event === "editor.tool.requested");
	const requestedB = socketB.sent.find((message: Record<string, unknown>): boolean => message.event === "editor.tool.requested");
	assert.ok(requestedA);
	assert.ok(requestedB);
	assert.equal(socketOther.sent.some((message: Record<string, unknown>): boolean => message.event === "editor.tool.requested"), false);

	const dataA = requestedA.data as Record<string, unknown>;
	const dataB = requestedB.data as Record<string, unknown>;
	assert.equal(dataA.toolName, "refresh_filesystem");
	assert.equal(dataB.toolName, "refresh_filesystem");
	assert.deepEqual((dataA.args as Record<string, unknown>).changedPaths, ["project.godot"]);
	assert.deepEqual((dataB.args as Record<string, unknown>).changedPaths, ["project.godot"]);
	assert.equal(bridge.handleToolResult(String(dataA.callId), true, { ok: true, editor: "a" }, undefined), true);
	assert.equal(bridge.handleToolResult(String(dataB.callId), true, { ok: true, editor: "b" }, undefined), true);

	assert.deepEqual(await refreshPromise, [
		{ ok: true, editor: "a" },
		{ ok: true, editor: "b" }
	]);
});

test("session events broadcast to subscribed frontend sockets once", (): void => {
	const originSocket = createSocket();
	const studioSocket = createSocket();
	const originSession = createClientSession(undefined);
	const studioSession = createClientSession(undefined);
	originSession.sessionId = "session-multi-client";
	studioSession.sessionId = "session-multi-client";
	registerClientConnection(originSocket, originSession);
	registerClientConnection(studioSocket, studioSession);
	subscribeSocketToSession(originSocket, "session-multi-client");
	subscribeSocketToSession(studioSocket, "session-multi-client");

	sendSessionEvent(originSocket, "request-1", originSession, "client.connected", {
		text: "done"
	});

	assert.equal(originSocket.sent.filter((message: Record<string, unknown>): boolean => message.event === "client.connected").length, 1);
	assert.equal(studioSocket.sent.filter((message: Record<string, unknown>): boolean => message.event === "client.connected").length, 1);
});

test("session run lock is shared across frontend connections", (): void => {
	assert.deepEqual(beginSessionRun("session-run-lock", "request-a"), { ok: true });
	assert.deepEqual(beginSessionRun("session-run-lock", "request-b"), {
		ok: false,
		activeRequestId: "request-a"
	});
	finishSessionRun("session-run-lock", "request-b");
	assert.deepEqual(beginSessionRun("session-run-lock", "request-c"), {
		ok: false,
		activeRequestId: "request-a"
	});
	finishSessionRun("session-run-lock", "request-a");
	assert.deepEqual(beginSessionRun("session-run-lock", "request-d"), { ok: true });
	finishSessionRun("session-run-lock", "request-d");
});

test("custom MCP dynamic tools are scoped by workspace context", async (): Promise<void> => {
	replaceDynamicMcpToolsForWorkspace("workspace-a", [{
		serverId: "custom-a",
		serverName: "Shared Tools",
		toolName: "echo"
	}]);
	replaceDynamicMcpToolsForWorkspace("workspace-b", [{
		serverId: "custom-b",
		serverName: "Shared Tools",
		toolName: "echo"
	}]);

	try {
		const workspaceAToolNames = await withMcpRequestContext({ workspaceId: "workspace-a" }, async (): Promise<string[]> => getDynamicMcpToolNames());
		const workspaceBToolNames = await withMcpRequestContext({ workspaceId: "workspace-b" }, async (): Promise<string[]> => getDynamicMcpToolNames());
		assert.equal(workspaceAToolNames.length, 1);
		assert.equal(workspaceBToolNames.length, 1);
		assert.notEqual(workspaceAToolNames[0], workspaceBToolNames[0]);

		const workspaceAMapping = await withMcpRequestContext({ workspaceId: "workspace-a" }, async () => getDynamicMcpToolMapping(workspaceAToolNames[0]!));
		const workspaceBMapping = await withMcpRequestContext({ workspaceId: "workspace-b" }, async () => getDynamicMcpToolMapping(workspaceBToolNames[0]!));
		assert.deepEqual(workspaceAMapping, { serverId: "custom-a", toolName: "echo" });
		assert.deepEqual(workspaceBMapping, { serverId: "custom-b", toolName: "echo" });

		const hiddenAcrossWorkspace = await withMcpRequestContext({ workspaceId: "workspace-b" }, async () => getDynamicMcpToolMapping(workspaceAToolNames[0]!));
		assert.equal(hiddenAcrossWorkspace, undefined);
	} finally {
		clearDynamicMcpToolsForWorkspace("workspace-a");
		clearDynamicMcpToolsForWorkspace("workspace-b");
	}
});

function registerSocket(socket: SocketMock): WebSocket {
	registerClientConnection(socket, createClientSession(undefined));
	return socket;
}
