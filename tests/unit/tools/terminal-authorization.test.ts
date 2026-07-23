import assert from "node:assert/strict";
import test from "node:test";
import {
	consumeTerminalCommandAuthorization,
	createTerminalCommandAuthorization,
	createTerminalCommandFingerprint
} from "../../../src/mcp/terminal/authorization.js";

function rejectionReason(result: ReturnType<typeof consumeTerminalCommandAuthorization>): string {
	assert.equal(result.allowed, false);
	return result.allowed ? "" : result.reason;
}

test("terminal command authorization binds all execution inputs and is one-shot", (): void => {
	const args: Record<string, unknown> = {
		commandLine: "npm test",
		cwd: ".",
		env: { CI: "1" },
		executionMode: "wait",
		timeoutMs: 20_000
	};
	const authorization = createTerminalCommandAuthorization({
		source: "model",
		requestId: "request-1",
		toolCallId: "call-1",
		workspaceId: "workspace-1",
		args
	});

	assert.equal(
		authorization.commandFingerprint,
		createTerminalCommandFingerprint(args, "workspace-1")
	);
	assert.deepEqual(
		consumeTerminalCommandAuthorization(authorization, args, "workspace-1"),
		{ allowed: true, source: "model" }
	);
	assert.match(
		rejectionReason(consumeTerminalCommandAuthorization(authorization, args, "workspace-1")),
		/already consumed/u
	);
});

test("terminal command authorization rejects workspace and argument changes", (): void => {
	const args: Record<string, unknown> = {
		commandLine: "npm run build",
		cwd: ".",
		env: {},
		executionMode: "wait"
	};
	const changedCommandAuthorization = createTerminalCommandAuthorization({
		source: "user",
		requestId: "request-2",
		toolCallId: "call-2",
		workspaceId: "workspace-1",
		args
	});
	assert.match(
		rejectionReason(consumeTerminalCommandAuthorization(changedCommandAuthorization, {
			...args,
			commandLine: "npm publish"
		}, "workspace-1")),
		/changed after it was authorized/u
	);

	const changedWorkspaceAuthorization = createTerminalCommandAuthorization({
		source: "user",
		requestId: "request-3",
		toolCallId: "call-3",
		workspaceId: "workspace-1",
		args
	});
	assert.match(
		rejectionReason(consumeTerminalCommandAuthorization(changedWorkspaceAuthorization, args, "workspace-2")),
		/workspace does not match/u
	);
});
