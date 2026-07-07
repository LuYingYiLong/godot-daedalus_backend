import WebSocket from "ws";
import { composeSystemPrompt } from "../../prompts/registry.js";
import type { AiChatParams, ChatMessage } from "../../protocol/types.js";
import type { ProviderAgentResult } from "../../providers/agent-types.js";
import { runProviderAgent, runProviderAgentStreaming } from "../../providers/provider-agent.js";
import type { OnToolEvent, ToolEvent } from "../../tools/tool-dispatcher.js";
import type { ProviderChatOptions } from "../../providers/deepseek-client.js";
import { McpHost } from "../../mcp/mcp-host.js";
import { composeSkillPrompt } from "../../skills/registry.js";
import { applyToolEventToWorkflowObservations } from "../../workflow/outcome.js";
import { createPhasePrompt } from "../../workflow/runner.js";
import type { WorkflowPhase, WorkflowToolObservation } from "../../workflow/types.js";
import type { ClientSession } from "../client-session.js";
import { logPromptTrace } from "../prompt-trace.js";
import { createAdditionalContextPromptSection } from "../additional-context.js";
import { createMcpSystemContext, createProviderRuntimeContext } from "../prompt-context.js";
import { createAgentToolEventForwarder, createEmptyWorkflowPhaseToolStats, updateWorkflowPhaseToolStats } from "./tool-events.js";
import type { WorkflowPhaseRunResult, WorkflowPhaseToolStats } from "./shared-types.js";

export async function runWorkflowPhase(
	socket: WebSocket,
	params: AiChatParams,
	options: ProviderChatOptions,
	history: ChatMessage[],
	fullSystemPrompt: string,
	phase: WorkflowPhase,
	mcpHost: McpHost,
	session: ClientSession,
	requestId: string,
	persistRequestId: string,
	runId: string,
	stepRunId: string,
	streamPhase: boolean,
	abortSignal?: AbortSignal | undefined
): Promise<WorkflowPhaseRunResult> {
	const toolStats: WorkflowPhaseToolStats = createEmptyWorkflowPhaseToolStats();
	let toolObservations: WorkflowToolObservation[] = [];
	const forwardToolEvent: OnToolEvent = createAgentToolEventForwarder(socket, requestId, session, runId, stepRunId, persistRequestId, mcpHost);
	const onToolEvent: OnToolEvent = (event: ToolEvent): void => {
		updateWorkflowPhaseToolStats(toolStats, event);
		toolObservations = applyToolEventToWorkflowObservations(toolObservations, event);
		forwardToolEvent(event);
	};
	const agentResult: ProviderAgentResult = streamPhase
		? await runProviderAgentStreaming(params, options, history, fullSystemPrompt, mcpHost, session.approvalGateway, phase.allowedTools, onToolEvent, abortSignal)
		: await runProviderAgent(params, options, history, fullSystemPrompt, mcpHost, session.approvalGateway, phase.allowedTools, onToolEvent, abortSignal);
	return {
		agentResult,
		toolStats,
		toolObservations
	};
}

export async function createWorkflowPhasePrompt(
	phase: WorkflowPhase,
	params: AiChatParams,
	mcpHost: McpHost,
	session: ClientSession,
	requestId: string,
	guidePromptSection: string = ""
): Promise<string> {
	const systemPrompt: string = await composeSystemPrompt(phase.promptId ?? params.promptId, params.systemPrompt, createProviderRuntimeContext(session), params.mode);
	const skillPrompt: string = await composeSkillPrompt(phase.skillId);
	const mcpSystemContext: string = await createMcpSystemContext(mcpHost, session);
	const additionalContextSection: string = createAdditionalContextPromptSection(params.additionalContext);
	const fullSystemPrompt: string = [
		systemPrompt,
		createPhasePrompt(phase, skillPrompt, mcpSystemContext),
		additionalContextSection,
		guidePromptSection
	].join("\n\n");
	logPromptTrace({
		requestId,
		phaseId: phase.id,
		promptId: phase.promptId ?? params.promptId,
		skillId: phase.skillId,
		customInstructions: params.systemPrompt,
		systemPrompt,
		skillPrompt,
		mcpSystemContext,
		additionalContextSection,
		guidePromptSection,
		fullSystemPrompt
	});
	return fullSystemPrompt;
}
