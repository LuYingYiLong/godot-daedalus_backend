import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { clientRequestSchema } from "../../../src/protocol/schema.js";
import type { ChatMessage, ClientRequest } from "../../../src/protocol/types.js";
import type { McpHost } from "../../../src/mcp/mcp-host.js";
import { createClientSession, type ClientSession } from "../../../src/server/client-session.js";
import { resolveModelProfile } from "../../../src/tokens/model-profiles.js";

type CapturedResponse = {
	protocolVersion: number;
	type: "response";
	id: string;
	ok: boolean;
	result?: Record<string, unknown> | undefined;
	error?: { code: string; message: string } | undefined;
};

function createCaptureSocket(): { socket: WebSocket; responses: CapturedResponse[] } {
	const responses: CapturedResponse[] = [];
	const socket = {
		readyState: WebSocket.OPEN,
		send(data: string): void {
			responses.push(JSON.parse(data) as CapturedResponse);
		}
	} as WebSocket;
	return { socket, responses };
}

async function requestContextEstimate(session: ClientSession, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
	const { handleSessionRequest } = await import("../../../src/server/session-rpc-handlers.js");
	const { socket, responses } = createCaptureSocket();
	const request: ClientRequest = {
		type: "request",
		id: "estimate-context",
		method: "session.context.estimate",
		params
	} as ClientRequest;

	await handleSessionRequest(socket, request, session, {} as McpHost);

	assert.equal(responses.length, 1);
	assert.equal(responses[0]!.ok, true, responses[0]!.error?.message ?? "context estimate failed");
	assert.ok(responses[0]!.result !== undefined);
	return responses[0]!.result!;
}

function createMessages(count: number): ChatMessage[] {
	const messages: ChatMessage[] = [];
	for (let index: number = 0; index < count; index += 1) {
		messages.push({
			role: index % 2 === 0 ? "user" : "assistant",
			content: `message ${index} with enough text to count as history context`
		});
	}
	return messages;
}

test("session.context.estimate schema accepts draft, model and additional context params", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "context-estimate",
		method: "session.context.estimate",
		params: {
			message: "Explain this script",
			mode: "ask",
			provider: "deepseek",
			model: "deepseek-chat",
			additionalContext: [{
				id: "ctx-file",
				kind: "file",
				title: "player.gd",
				subtitle: "script",
				source: "manual",
				resourcePath: "res://player.gd",
				data: {
					path: "res://player.gd",
					content: "extends Node"
				}
			}]
		}
	}).success, true);
});

test("session.context.estimate returns draft-only usage without active session", async (): Promise<void> => {
	const session: ClientSession = createClientSession(undefined);
	const result: Record<string, unknown> = await requestContextEstimate(session, {
		message: "How should I structure this Godot scene?",
		mode: "ask",
		provider: "deepseek",
		model: "deepseek-chat"
	});

	assert.equal(result.historyTokens, 0);
	assert.equal(result.canCompress, false);
	assert.equal(result.compressReason, "No active session");
	assert.equal(result.summaryActive, false);
	assert.equal(result.estimationSource, "local");
	assert.ok(Number(result.usedTokens) > 0);
	assert.ok(Number(result.currentMessageTokens) > 0);
	assert.ok(Number(result.systemAndContextTokens) > 0);
	assert.ok(Number(result.outputReserveTokens) > 0);
	assert.ok(Number(result.contextWindowTokens) > 0);
	assert.ok(Number(result.availableTokens) >= 0);
});

test("session.context.estimate includes active session history and enables compression for long chats", async (): Promise<void> => {
	const session: ClientSession = createClientSession(undefined);
	session.sessionId = "session-context-estimate";
	session.providerApiKey = "test-key";
	session.messages = createMessages(10);

	const result: Record<string, unknown> = await requestContextEstimate(session, {
		message: "Continue with a concise answer",
		mode: "agent"
	});

	assert.ok(Number(result.historyTokens) > 0);
	assert.ok(Number(result.currentMessageTokens) > 0);
	assert.equal(result.canCompress, true);
	assert.equal(result.compressReason, null);
	assert.equal(result.summaryActive, false);
});

test("session.context.estimate falls back to local counting when provider estimator fails", async (): Promise<void> => {
	const originalFetch: typeof fetch = globalThis.fetch;
	globalThis.fetch = (async (): Promise<Response> => {
		throw new Error("estimator offline");
	}) as typeof fetch;

	try {
		const session: ClientSession = createClientSession(undefined);
		session.sessionId = "session-context-estimate-moonshot";
		session.activeProvider = "moonshot";
		session.providerApiKey = "test-key";
		session.providerModel = "kimi-k2.7-code";
		session.modelProfile = resolveModelProfile("moonshot", "kimi-k2.7-code");
		session.messages = createMessages(4);

		const result: Record<string, unknown> = await requestContextEstimate(session, {
			message: "Use local token estimation if provider estimator fails",
			provider: "moonshot",
			model: "kimi-k2.7-code"
		});

		assert.equal(result.estimationSource, "local");
		assert.ok(Number(result.usedTokens) > 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("session.context.estimate reports summary-active history", async (): Promise<void> => {
	const session: ClientSession = createClientSession(undefined);
	session.sessionId = "session-context-estimate-summary";
	session.providerApiKey = "test-key";
	session.messages = createMessages(12);
	session.summaryMessage = {
		role: "system",
		content: "Previous conversation summary for context compression."
	};
	session.summaryCoveredMessageCount = 8;

	const result: Record<string, unknown> = await requestContextEstimate(session, {
		message: "Pick up from the summary"
	});

	assert.equal(result.summaryActive, true);
	assert.ok(Number(result.historyTokens) > 0);
});
