import assert from "node:assert/strict";
import test from "node:test";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
	createPersistedApprovalRequestedData,
	createRuntimePendingContinuation,
	foldPendingApprovalStates
} from "../src/session/approval-persistence.js";
import type { StoredApprovalEvent } from "../src/session/session-store.js";
import type { PendingAiContinuation } from "../src/server/client-session.js";
import type { PendingApproval } from "../src/tools/approval-gateway.js";

function createPendingApproval(): PendingApproval {
	return {
		approvalId: "approval-test",
		toolCallId: "call-test",
		toolName: "mcp_godot_create_text_file",
		llmToolName: "mcp_godot_create_text_file",
		args: {
			relativePath: "test_approval.md",
			content: "# Approval"
		},
		reason: "写操作需要用户在 Godot 客户端确认",
		createdAt: Date.parse("2026-07-03T00:00:00.000Z"),
		executionFingerprint: "godot:create:fingerprint"
	};
}

function createPendingContinuation(): PendingAiContinuation {
	const assistantMessage = {
		role: "assistant",
		content: null,
		tool_calls: [
			{
				id: "call-test",
				type: "function",
				function: {
					name: "mcp_godot_create_text_file",
					arguments: "{\"relativePath\":\"test_approval.md\",\"content\":\"# Approval\"}"
				}
			}
		],
		reasoning_content: "保留 thinking mode 所需 reasoning_content"
	} as unknown as ChatCompletionMessageParam;

	return {
		params: {
			message: "创建一个审批测试文件",
			options: {
				stream: true,
				workflow: "single"
			}
		},
		options: {
			provider: "deepseek",
			apiKey: "secret-api-key",
			model: "deepseek-v4-flash",
			baseUrl: "https://api.deepseek.com"
		},
		continuation: {
			messages: [assistantMessage],
			nextStep: 1,
			totalToolResultChars: 0
		},
		allowedToolNames: ["mcp_godot_create_text_file"],
		userMessage: "创建一个审批测试文件",
		requestId: "request-test",
		userCreatedAt: "2026-07-03T00:00:00.000Z",
		stream: true
	};
}

function createApprovalEvent(event: string, data: unknown, createdAt: string): StoredApprovalEvent {
	return {
		id: `approval-event-${event}-${createdAt}`,
		schemaVersion: 1,
		approvalId: "approval-test",
		requestId: "request-test",
		event,
		data,
		createdAt
	};
}

test("approval persistence folds pending, interrupted, and executed states", (): void => {
	const pendingApproval: PendingApproval = createPendingApproval();
	const pendingContinuation: PendingAiContinuation = createPendingContinuation();
	const requestedData = createPersistedApprovalRequestedData(pendingApproval, pendingContinuation, "workspace-a");
	const serializedData: string = JSON.stringify(requestedData);

	assert.equal(serializedData.includes("secret-api-key"), false);
	assert.equal(serializedData.includes("reasoning_content"), true);

	const pendingStates = foldPendingApprovalStates([
		createApprovalEvent("requested", requestedData, "2026-07-03T00:00:00.000Z")
	]);
	assert.equal(pendingStates.length, 1);
	assert.equal(pendingStates[0]?.status, "pending");
	assert.equal(pendingStates[0]?.restored, true);

	const interruptedStates = foldPendingApprovalStates([
		createApprovalEvent("requested", requestedData, "2026-07-03T00:00:00.000Z"),
		createApprovalEvent("approved", { approvedAt: "2026-07-03T00:00:01.000Z" }, "2026-07-03T00:00:01.000Z"),
		createApprovalEvent("executing", { startedAt: "2026-07-03T00:00:02.000Z" }, "2026-07-03T00:00:02.000Z")
	]);
	assert.equal(interruptedStates.length, 1);
	assert.equal(interruptedStates[0]?.status, "interrupted");
	assert.equal(interruptedStates[0]?.interrupted, true);

	const executedStates = foldPendingApprovalStates([
		createApprovalEvent("requested", requestedData, "2026-07-03T00:00:00.000Z"),
		createApprovalEvent("executing", { startedAt: "2026-07-03T00:00:02.000Z" }, "2026-07-03T00:00:02.000Z"),
		createApprovalEvent("executed", { resultChars: 12 }, "2026-07-03T00:00:03.000Z")
	]);
	assert.equal(executedStates.length, 0);

	assert.ok(requestedData.continuation !== undefined);
	const runtimeContinuation = createRuntimePendingContinuation(requestedData.continuation, "new-api-key");
	assert.equal(runtimeContinuation.options.apiKey, "new-api-key");
	assert.equal(runtimeContinuation.options.provider, "deepseek");
	assert.equal(runtimeContinuation.options.model, "deepseek-v4-flash");
});
