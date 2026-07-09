import assert from "node:assert/strict";
import test from "node:test";
import { buildCanonicalTimelineBlocks, type TimelineAssistantBlock, type TimelineBlock } from "../src/session/timeline-blocks.js";
import type { StoredMessage, StoredSession, StoredSessionEvent, SessionMetadata } from "../src/session/session-store.js";

function metadata(): SessionMetadata {
	return {
		id: "session-test",
		title: "Timeline test",
		createdAt: "2026-07-09T00:00:00.000Z",
		updatedAt: "2026-07-09T00:00:00.000Z"
	};
}

function session(messages: StoredMessage[], events: StoredSessionEvent[]): StoredSession {
	return {
		metadata: metadata(),
		messages,
		events
	};
}

function event(id: string, requestId: string, eventName: string, createdAt: string, data: Record<string, unknown>): StoredSessionEvent {
	return {
		id,
		requestId,
		event: eventName,
		data,
		createdAt
	};
}

function assistantBlock(block: TimelineBlock | undefined): TimelineAssistantBlock {
	assert.equal(block?.type, "assistant");
	return block as TimelineAssistantBlock;
}

test("canonical timeline merges plan clarification request events into original assistant block", (): void => {
	const stored: StoredSession = session(
		[
			{
				role: "user",
				requestId: "request-plan",
				content: "写一个本地井字棋",
				createdAt: "2026-07-09T00:00:00.000Z",
				excludeFromLlmContext: true
			},
			{
				role: "assistant",
				requestId: "request-plan",
				content: "需要澄清：请选择目标形态。",
				createdAt: "2026-07-09T00:00:01.000Z",
				excludeFromLlmContext: true
			}
		],
		[
			event("event-clarify", "request-plan", "plan.clarification.required", "2026-07-09T00:00:01.000Z", {
				planId: "plan-a",
				requestId: "request-plan",
				question: "请选择 CLI 还是 Godot 场景。",
				recommendedReplies: ["CLI", "Godot 场景"]
			}),
			event("event-thinking", "plan-clarify-1", "agent.thinking.delta", "2026-07-09T00:00:02.000Z", {
				text: "读取项目结构。"
			}),
			event("event-tool-call", "plan-clarify-1", "agent.tool.call", "2026-07-09T00:00:03.000Z", {
				toolCallId: "tool-read",
				toolName: "mcp_godot_list_project_files"
			}),
			event("event-tool-result", "plan-clarify-1", "agent.tool.result", "2026-07-09T00:00:04.000Z", {
				toolCallId: "tool-read",
				toolName: "mcp_godot_list_project_files",
				summary: "列出项目文件"
			}),
			event("event-plan", "plan-clarify-1", "plan.generated", "2026-07-09T00:00:05.000Z", {
				planId: "plan-a",
				requestId: "request-plan",
				status: "ready",
				title: "井字棋计划",
				previewMarkdown: "## Summary\n\n实现井字棋。"
			})
		]
	);

	const result = buildCanonicalTimelineBlocks(stored);
	assert.equal(result.blocks.length, 2);
	const assistant = assistantBlock(result.blocks[1]);
	assert.equal(assistant.requestId, "request-plan");
	assert.deepEqual(assistant.bodyParts.map((part) => part.type), ["markdown", "status", "thinking", "tool", "plan"]);
	assert.equal(assistant.bodyParts.find((part) => part.type === "tool")?.type, "tool");
	const planPart = assistant.bodyParts.find((part) => part.type === "plan");
	assert.equal(planPart?.type, "plan");
	assert.equal(planPart?.planId, "plan-a");
});

test("canonical timeline keeps plan execution as independent blocks with tools and inline diff", (): void => {
	const fileEditBatch = {
		batchId: "edit-a",
		workspaceId: "workspace-a",
		workspaceRoot: "D:/Project",
		editedFiles: [{
			path: "scripts/game.gd",
			absolutePath: "D:/Project/scripts/game.gd",
			workspaceRoot: "D:/Project",
			additions: 3,
			deletions: 1,
			existsAfter: true,
			afterSha256: "after",
			undoable: true
		}]
	};
	const stored: StoredSession = session(
		[
			{
				role: "user",
				requestId: "plan-exec-1",
				content: "写一个本地井字棋",
				createdAt: "2026-07-09T00:01:00.000Z"
			},
			{
				role: "assistant",
				requestId: "plan-exec-1",
				content: "完成。",
				createdAt: "2026-07-09T00:02:00.000Z"
			}
		],
		[
			event("event-exec", "plan-exec-1", "plan.execution.started", "2026-07-09T00:01:00.000Z", {
				planId: "plan-a",
				requestId: "request-plan",
				executionRequestId: "plan-exec-1"
			}),
			event("event-tool-call", "plan-exec-1", "agent.tool.call", "2026-07-09T00:01:01.000Z", {
				toolCallId: "tool-write",
				toolName: "mcp_godot_overwrite_text_file"
			}),
			event("event-tool-result", "plan-exec-1", "agent.tool.result", "2026-07-09T00:01:02.000Z", {
				toolCallId: "tool-write",
				toolName: "mcp_godot_overwrite_text_file",
				fileEditBatch
			}),
			event("event-outcome", "plan-exec-1", "agent.step.outcome", "2026-07-09T00:01:03.000Z", {
				outcome: {
					title: "实现修改",
					status: "completed",
					summary: "mcp_godot_overwrite_text_file"
				}
			}),
			event("event-todo", "plan-exec-1", "workflow.todo.updated", "2026-07-09T00:01:04.000Z", {
				workflowId: "workflow-a",
				todos: [
					{ id: "phase-write", title: "实现修改", status: "completed" }
				]
			})
		]
	);

	const result = buildCanonicalTimelineBlocks(stored);
	assert.equal(result.blocks.length, 2);
	assert.equal(result.blocks[0]?.type, "user");
	const assistant = assistantBlock(result.blocks[1]);
	assert.equal(assistant.requestId, "plan-exec-1");
	assert.deepEqual(assistant.bodyParts.map((part) => part.type), ["markdown", "tool", "inline_diff"]);
	const inlineDiff = assistant.bodyParts.find((part) => part.type === "inline_diff");
	assert.equal(inlineDiff?.type, "inline_diff");
	assert.equal(inlineDiff?.editedFileCount, 1);
	assert.equal(inlineDiff?.additions, 3);
	assert.equal(inlineDiff?.deletions, 1);
	assert.deepEqual(result.latestWorkflowSnapshot, {
		workflowId: "workflow-a",
		todos: [
			{ id: "phase-write", title: "实现修改", status: "completed" }
		]
	});
});

test("canonical timeline restores failed transcript-only turn with tool, error and inline diff", (): void => {
	const fileEditBatch = {
		batchId: "edit-failed",
		workspaceId: "workspace-a",
		workspaceRoot: "D:/Project",
		editedFiles: [{
			path: "scripts/failed.gd",
			absolutePath: "D:/Project/scripts/failed.gd",
			workspaceRoot: "D:/Project",
			additions: 1,
			deletions: 0,
			existsAfter: true,
			afterSha256: "after",
			undoable: true
		}]
	};
	const stored: StoredSession = session(
		[
			{
				role: "user",
				requestId: "request-failed",
				content: "修复脚本",
				createdAt: "2026-07-09T00:03:00.000Z",
				excludeFromLlmContext: true
			},
			{
				role: "assistant",
				requestId: "request-failed",
				content: "",
				createdAt: "2026-07-09T00:03:30.000Z",
				excludeFromLlmContext: true,
				status: "failed",
				error: {
					code: "agent_run_error",
					message: "总结阶段不能调用工具"
				}
			}
		],
		[
			event("event-delta", "request-failed", "agent.message.delta", "2026-07-09T00:03:01.000Z", { text: "准备修改脚本。" }),
			event("event-tool", "request-failed", "agent.tool.result", "2026-07-09T00:03:02.000Z", {
				toolCallId: "tool-1",
				toolName: "mcp_godot_overwrite_text_file",
				fileEditBatch
			}),
			event("event-error", "request-failed", "agent.run.error", "2026-07-09T00:03:03.000Z", {
				code: "agent_run_error",
				message: "总结阶段不能调用工具"
			})
		]
	);

	const result = buildCanonicalTimelineBlocks(stored);
	const assistant = assistantBlock(result.blocks[1]);
	assert.deepEqual(assistant.bodyParts.map((part) => part.type), ["markdown", "tool", "status", "inline_diff"]);
	const statusPart = assistant.bodyParts.find((part) => part.type === "status");
	assert.equal(statusPart?.type, "status");
	assert.equal(statusPart?.details, "总结阶段不能调用工具");
});

test("canonical timeline compacts many deltas into a bounded markdown part", (): void => {
	const events: StoredSessionEvent[] = [];
	for (let index = 0; index < 2600; index += 1) {
		events.push(event(`event-${index}`, "request-large", "agent.message.delta", `2026-07-09T00:04:${(index % 60).toString().padStart(2, "0")}.000Z`, {
			text: "x"
		}));
	}
	const stored: StoredSession = session(
		[
			{ role: "user", requestId: "request-large", content: "大输出", createdAt: "2026-07-09T00:04:00.000Z" },
			{ role: "assistant", requestId: "request-large", content: "", createdAt: "2026-07-09T00:05:00.000Z" }
		],
		events
	);

	const result = buildCanonicalTimelineBlocks(stored);
	const assistant = assistantBlock(result.blocks[1]);
	assert.equal(assistant.bodyParts.length, 1);
	assert.equal(assistant.bodyParts[0]?.type, "markdown");
	assert.equal(assistant.bodyParts[0]?.text.length, 2600);
	assert.equal(result.eventCount, 2600);
});
