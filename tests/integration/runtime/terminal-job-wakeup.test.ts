import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import type { McpHost } from "../../../src/mcp/mcp-host.js";
import { createClientSession } from "../../../src/server/client-session.js";
import { scheduleTerminalJobWakeup } from "../../../src/server/terminal-job-wakeup.js";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve): void => {
		setTimeout(resolve, ms);
	});
}

function createSocket(): WebSocket & { sentMessages: Array<Record<string, unknown>> } {
	const sentMessages: Array<Record<string, unknown>> = [];
	return {
		readyState: WebSocket.OPEN,
		sentMessages,
		send(message: string): void {
			sentMessages.push(JSON.parse(message) as Record<string, unknown>);
		}
	} as WebSocket & { sentMessages: Array<Record<string, unknown>> };
}

test("terminal job wakeup records status event and pending guide", async (): Promise<void> => {
	const socket = createSocket();
	const session = createClientSession(undefined);
	const mcpHost = {
		async callTool(_serverName: string, _toolName: string, _args: unknown): Promise<unknown> {
			return {
				content: [{
					type: "text",
					text: JSON.stringify({
						jobId: "terminal-job-wakeup-test",
						status: "completed",
						durationMs: 25,
						exitCode: 0,
						stdoutTail: "compile finished",
						stderrTail: ""
					})
				}]
			};
		}
	} as McpHost;

	scheduleTerminalJobWakeup({
		socket,
		requestId: "request-test",
		persistRequestId: "request-test",
		session,
		mcpHost,
		jobId: "terminal-job-wakeup-test",
		wakeAfterMs: 1,
		runId: "run-test",
		stepRunId: "step-test"
	});

	await sleep(30);

	assert.equal(session.pendingGuides.length, 1);
	assert.match(session.pendingGuides[0]?.text ?? "", /compile finished/);
	assert.ok(socket.sentMessages.some((message): boolean => message.event === "terminal.job.completed"));
	assert.ok(socket.sentMessages.some((message): boolean => message.event === "terminal.job.resume_started"));
});
