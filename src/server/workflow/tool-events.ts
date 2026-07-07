import WebSocket from "ws";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import type { OnToolEvent, ToolEvent } from "../../tools/tool-dispatcher.js";
import { parseToolResultSummary } from "../../tools/tool-result-parser.js";
import { getToolPolicy } from "../../tools/tool-policy.js";
import type { WorkflowPhase } from "../../workflow/types.js";
import { sendSessionEvent } from "../session-events.js";
import { scheduleTerminalJobWakeup } from "../terminal-job-wakeup.js";
import type { WorkflowPhaseToolStats } from "./shared-types.js";
import { persistFileEditBatch } from "../file-edit-batches.js";

export function createAgentToolEventForwarder(
	socket: WebSocket,
	requestId: string,
	session: ClientSession,
	runId: string,
	stepRunId: string,
	persistRequestId: string = requestId,
	mcpHost?: McpHost | undefined
): OnToolEvent {
	return (event: ToolEvent): void => {
		if (event.type === "ai.delta") {
			sendSessionEvent(socket, requestId, session, "agent.message.delta", {
				runId,
				stepRunId,
				text: event.text
			}, persistRequestId);
			return;
		}
		if (event.type === "ai.thinking.delta") {
			sendSessionEvent(socket, requestId, session, "agent.thinking.delta", {
				runId,
				stepRunId,
				text: event.text
			}, persistRequestId);
			return;
		}
		if (event.type === "ai.thinking.done") {
			sendSessionEvent(socket, requestId, session, "agent.thinking.done", {
				runId,
				stepRunId
			}, persistRequestId);
			return;
		}
		if (event.type === "tool.call") {
			sendSessionEvent(socket, requestId, session, "agent.tool.call", {
				...event,
				type: "agent.tool.call",
				runId,
				stepRunId
			}, persistRequestId);
			return;
		}
		if (event.type === "tool.result") {
			const { fileEditDraft, ...publicEvent } = event;
			const fileEditBatch = persistFileEditBatch(
				session.sessionId,
				persistRequestId,
				event.toolCallId,
				event.toolName,
				fileEditDraft
			);
			if (
				event.terminalJobStatus === "running"
				&& event.terminalJobId !== undefined
				&& event.terminalJobWakeAfterMs !== undefined
			) {
				sendSessionEvent(socket, requestId, session, "terminal.job.started", {
					jobId: event.terminalJobId,
					wakeAfterMs: event.terminalJobWakeAfterMs,
					runId,
					stepRunId,
					toolName: event.toolName
				}, persistRequestId);
				if (mcpHost !== undefined) {
					scheduleTerminalJobWakeup({
						socket,
						requestId,
						persistRequestId,
						session,
						mcpHost,
						jobId: event.terminalJobId,
						wakeAfterMs: event.terminalJobWakeAfterMs,
						runId,
						stepRunId
					});
				}
			}
			sendSessionEvent(socket, requestId, session, "agent.tool.result", {
				...publicEvent,
				type: "agent.tool.result",
				runId,
				stepRunId,
				...(fileEditBatch === undefined ? {} : { fileEditBatch })
			}, persistRequestId);
			return;
		}
		if (event.type === "tool.error") {
			sendSessionEvent(socket, requestId, session, "agent.tool.error", {
				...event,
				type: "agent.tool.error",
				runId,
				stepRunId
			}, persistRequestId);
			return;
		}
		if (event.type === "tool.approval_required") {
			sendSessionEvent(socket, requestId, session, "agent.tool.approval_required", {
				...event,
				type: "agent.tool.approval_required",
				runId,
				stepRunId
			}, persistRequestId);
		}
	};
}

export function createEmptyWorkflowPhaseToolStats(): WorkflowPhaseToolStats {
	return {
		toolEvents: 0,
		proposeToolEvents: 0,
		writeToolEvents: 0,
		approvalEvents: 0
	};
}

export function updateWorkflowPhaseToolStats(stats: WorkflowPhaseToolStats, event: ToolEvent): void {
	if (!event.type.startsWith("tool.")) {
		return;
	}

	stats.toolEvents += 1;

	if (event.type === "tool.approval_required") {
		stats.approvalEvents += 1;
	}

	const toolName: string | undefined = "toolName" in event ? event.toolName : undefined;
	if (toolName === undefined) {
		return;
	}

	const policy = getToolPolicy(toolName);
	if (policy?.risk === "propose") {
		stats.proposeToolEvents += 1;
	}
	if (policy?.risk === "write" || policy?.risk === "destructive") {
		stats.writeToolEvents += 1;
	}
}

export function shouldRequireWorkflowWriteTool(phase: WorkflowPhase): boolean {
	return phase.toolGroup === "write";
}

export function didWorkflowWritePhaseExecute(phase: WorkflowPhase, stats: WorkflowPhaseToolStats): boolean {
	if (stats.writeToolEvents > 0 || stats.approvalEvents > 0) {
		return true;
	}

	return isWorkflowProposalPhase(phase) && stats.proposeToolEvents > 0;
}

export function isWorkflowProposalPhase(phase: WorkflowPhase): boolean {
	const text: string = `${phase.id}\n${phase.title}\n${phase.instruction}`.toLowerCase();
	return text.includes("propose")
		|| text.includes("preview")
		|| text.includes("diff")
		|| text.includes("预览")
		|| text.includes("提案")
		|| text.includes("方案");
}

export function createWorkflowWriteGuardRetryMessage(phaseMessage: string): string {
	return [
		phaseMessage,
		"",
		"## 后端执行守卫",
		"上一次候选回复没有实际调用当前阶段需要的 propose/write 工具，也没有触发审批，因此当前阶段还没有完成。",
		"如果当前阶段是预览/提案，请调用允许的 propose_* 工具；如果当前阶段是实际修改，请调用写入工具并按审批流程暂停。",
		"不要只描述计划、步骤或意图。"
	].join("\n");
}
