import WebSocket from "ws";
import { composeSystemPrompt } from "../../prompts/registry.js";
import type { AiChatParams, ChatMessage } from "../../protocol/types.js";
import type { ProviderAgentResult } from "../../providers/agent-types.js";
import { runProviderAgent, runProviderAgentStreaming } from "../../providers/provider-agent.js";
import type { OnToolEvent, ToolEvent } from "../../tools/tool-dispatcher.js";
import type { ProviderChatOptions } from "../../providers/deepseek-client.js";
import { McpHost } from "../../mcp/mcp-host.js";
import { composeSkillPrompt } from "../../skills/registry.js";
import { composeExplicitSkillPrompt, composeSkillCatalogPrompt, resolveExplicitSkills } from "../../skills/runtime.js";
import type { SkillWorkspace } from "../../skills/types.js";
import { applyToolEventToWorkflowObservations } from "../../workflow/outcome.js";
import { createPhasePrompt } from "../../workflow/runner.js";
import type { WorkflowPhase, WorkflowToolObservation } from "../../workflow/types.js";
import type { ClientSession } from "../client-session.js";
import { logPromptTrace } from "../prompt-trace.js";
import { createAdditionalContextPromptSection } from "../additional-context.js";
import { createMcpSystemContext, createProviderRuntimeContext } from "../prompt-context.js";
import { createAgentToolEventForwarder, createEmptyWorkflowPhaseToolStats, updateWorkflowPhaseToolStats } from "./tool-events.js";
import type { WorkflowPhaseRunResult, WorkflowPhaseToolStats } from "./shared-types.js";
import { isEmptyProviderResponseError } from "./provider-errors.js";
import { createSceneViewToolResultEnricher } from "./scene-view-enricher.js";

const SCENE_VIEW_CAPTURE_TOOL: string = "mcp_godot_editor_capture_scene_view";
const SKILL_LOAD_TOOL: string = "mcp_skills_load";

export function createRuntimeWorkflowPhase(phase: WorkflowPhase, mcpHost: McpHost, session?: ClientSession | undefined): WorkflowPhase {
	const allowedTools: string[] = phase.allowedTools.includes(SKILL_LOAD_TOOL) ? [...phase.allowedTools] : [...phase.allowedTools, SKILL_LOAD_TOOL];
	if (allowedTools.includes(SCENE_VIEW_CAPTURE_TOOL) && !mcpHost.getEditorBridge().supportsTool("capture_scene_view", session?.activeWorkspace?.id, session?.editorInstanceId)) {
		return {
			...phase,
			allowedTools: allowedTools.filter((toolName: string): boolean => toolName !== SCENE_VIEW_CAPTURE_TOOL)
		};
	}
	return {
		...phase,
		allowedTools
	};
}

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
	const runtimePhase: WorkflowPhase = createRuntimeWorkflowPhase(phase, mcpHost, session);
	const sceneViewEnricher = createSceneViewToolResultEnricher({
		session,
		options,
		phaseInstruction: runtimePhase.instruction,
		abortSignal
	});
	const toolStats: WorkflowPhaseToolStats = createEmptyWorkflowPhaseToolStats();
	let toolObservations: WorkflowToolObservation[] = [];
	const forwardToolEvent: OnToolEvent = createAgentToolEventForwarder(socket, requestId, session, runId, stepRunId, persistRequestId, mcpHost);
	const onToolEvent: OnToolEvent = (event: ToolEvent): void => {
		updateWorkflowPhaseToolStats(toolStats, event);
		toolObservations = applyToolEventToWorkflowObservations(toolObservations, event);
		forwardToolEvent(event);
	};
	let agentResult: ProviderAgentResult;
	try {
		agentResult = streamPhase
			? await runProviderAgentStreaming(params, options, history, fullSystemPrompt, mcpHost, session.approvalGateway, runtimePhase.allowedTools, onToolEvent, abortSignal, sceneViewEnricher.enricher, { workspaceId: session.activeWorkspace?.id, editorInstanceId: session.editorInstanceId })
			: await runProviderAgent(params, options, history, fullSystemPrompt, mcpHost, session.approvalGateway, runtimePhase.allowedTools, onToolEvent, abortSignal, sceneViewEnricher.enricher, { workspaceId: session.activeWorkspace?.id, editorInstanceId: session.editorInstanceId });
	} catch (error: unknown) {
		if (phase.toolGroup === "write" && isEmptyProviderResponseError(error)) {
			agentResult = {
				status: "completed",
				text: ""
			};
		} else {
			throw error;
		}
	}
	return {
		agentResult,
		toolStats,
		toolObservations,
		capturedAttachments: sceneViewEnricher.getCapturedAttachments()
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
	const phaseSkillPrompt: string = await composeSkillPrompt(phase.skillId);
	const skillWorkspace: SkillWorkspace = session.activeWorkspace !== undefined
		? { id: session.activeWorkspace.id, rootPath: session.activeWorkspace.rootPath }
		: { id: `runtime:${session.godotProjectPath ?? "unknown"}`, rootPath: session.godotProjectPath ?? process.cwd() };
	const explicitSkillPrompt: string = composeExplicitSkillPrompt(await resolveExplicitSkills(skillWorkspace, params.skillRefs ?? []));
	const skillCatalogPrompt: string = await composeSkillCatalogPrompt(skillWorkspace);
	const skillPrompt: string = [phaseSkillPrompt, explicitSkillPrompt, skillCatalogPrompt].filter((section): boolean => section.length > 0).join("\n\n");
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
