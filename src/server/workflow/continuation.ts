import WebSocket from "ws";
import type { AiChatParams } from "../../protocol/types.js";
import type { ProviderAgentResult } from "../../providers/agent-types.js";
import type { ProviderChatOptions } from "../../providers/deepseek-client.js";
import { McpHost } from "../../mcp/mcp-host.js";
import { sendJson } from "../send-json.js";
import { createWorkflowPhaseRunId, applyDeterministicVerificationGate, createWorkflowPhaseOutcome, findBlockingOutcomeBeforeSummarize } from "../../workflow/outcome.js";
import { appendPhaseOutput, createPhaseMessage, createPhaseParams, updateWorkflowPhaseStatus } from "../../workflow/runner.js";
import { countWorkflowAutoRepairRounds, insertWorkflowAutoRepairPhases } from "../../workflow/repair.js";
import type { WorkflowPhase, WorkflowPhaseOutput, WorkflowPlan, WorkflowRunState, WorkflowToolObservation } from "../../workflow/types.js";
import type { ClientSession, PendingAiContinuation } from "../client-session.js";
import { appendChatTurnToSession } from "../token-budget.js";
import { consumePendingGuideSection } from "../pending-guides.js";
import { sendSessionEvent } from "../session-events.js";
import { createPendingAiContinuation, registerPendingApprovalContinuation, sendAgentPaused } from "../approval-continuation.js";
import { reviseLlmWorkflowPlan } from "../../workflow/llm-planner.js";
import { WorkflowExecutionError } from "./workflow-error.js";
import { MAX_WORKFLOW_AUTO_REPAIR_ROUNDS } from "./limits.js";
import type { WorkflowPhaseRunResult, WorkflowPhaseToolStats } from "./shared-types.js";
import { createEmptyWorkflowPhaseToolStats, createWorkflowWriteGuardRetryMessage, didWorkflowWritePhaseExecute, shouldRequireWorkflowWriteTool } from "./tool-events.js";
import { sendWorkflowEvent, sendWorkflowTodoSnapshot } from "./events.js";
import { createWorkflowPhasePrompt, runWorkflowPhase } from "./phase-runner.js";

export function createWorkflowPendingContinuation(
	phaseParams: AiChatParams,
	options: ProviderChatOptions,
	agentResult: Extract<ProviderAgentResult, { status: "approval_required" }>,
	phase: WorkflowPhase,
	workflowState: WorkflowRunState,
	requestId: string,
	userCreatedAt: string,
	streamPhase: boolean
): PendingAiContinuation {
	return createPendingAiContinuation(
		phaseParams,
		options,
		agentResult.continuation,
		phase.allowedTools,
		workflowState.originalParams.message,
		requestId,
		userCreatedAt,
		streamPhase,
		workflowState
	);
}

export async function continueWorkflowExecution(
	socket: WebSocket,
	requestId: string,
	session: ClientSession,
	mcpHost: McpHost,
	options: ProviderChatOptions,
	workflowState: WorkflowRunState,
	userCreatedAt: string,
	initialAgentResult?: ProviderAgentResult | undefined,
	persistRequestId: string = requestId,
	abortSignal?: AbortSignal | undefined,
	initialToolObservations: WorkflowToolObservation[] = []
): Promise<void> {
	let state: WorkflowRunState = workflowState;
	let plan: WorkflowPlan = state.plan;
	let phaseOutputs = state.phaseOutputs;
	let agentResultOverride: ProviderAgentResult | undefined = initialAgentResult;
	let agentResultOverrideToolObservations: WorkflowToolObservation[] = initialToolObservations;
	const streamFinal: boolean = state.originalParams.options?.stream === true;
	const planningContext: string = state.planningContext ?? "";

	for (let index: number = state.phaseIndex; index < plan.phases.length; index += 1) {
		const phase: WorkflowPhase | undefined = plan.phases[index];
		if (phase === undefined) {
			break;
		}

		const phaseRunId: string = createWorkflowPhaseRunId(phase.id);
		if (phase.toolGroup === "summarize") {
			const blockingOutcome: WorkflowPhaseOutput | null = findBlockingOutcomeBeforeSummarize(phaseOutputs);
			if (blockingOutcome !== null) {
				const guardMessage: string = `总结阶段被阻止：阶段「${blockingOutcome.title}」仍处于 ${blockingOutcome.status}，不能交付完成总结。`;
				const blockedOutcome: WorkflowPhaseOutput = {
					phaseId: phase.id,
					phaseRunId,
					title: phase.title,
					status: "blocked",
					summary: guardMessage,
					evidence: [],
					failedChecks: blockingOutcome.failedChecks,
					requiredFixes: blockingOutcome.requiredFixes,
					modifiedArtifacts: [],
					verifiedArtifacts: [],
					toolObservations: [],
					sourcePhaseId: blockingOutcome.phaseId,
					blockedReason: guardMessage
				};
				phaseOutputs = appendPhaseOutput(phaseOutputs, phase, blockedOutcome);
				plan = updateWorkflowPhaseStatus(plan, phase.id, "failed");
				sendWorkflowEvent(socket, requestId, session, "workflow.phase.outcome", {
					workflowId: plan.id,
					phaseId: phase.id,
					phaseRunId,
					outcome: blockedOutcome
				}, persistRequestId);
				sendWorkflowTodoSnapshot(socket, requestId, session, plan, persistRequestId, phaseOutputs, phaseRunId);
				throw new WorkflowExecutionError(guardMessage, plan, new Error(guardMessage), phaseOutputs);
			}
		}

		plan = updateWorkflowPhaseStatus(plan, phase.id, "running");
		state = { ...state, plan, phaseIndex: index, phaseOutputs, activePhaseRunId: phaseRunId };
		sendWorkflowEvent(socket, requestId, session, "workflow.phase.started", {
			workflowId: plan.id,
			phaseId: phase.id,
			phaseRunId,
			title: phase.title,
			toolGroup: phase.toolGroup ?? null,
			skillId: phase.skillId ?? null,
			acceptanceCriteria: phase.acceptanceCriteria ?? [],
			repairOf: phase.repairOf ?? null,
			repairRound: phase.repairRound ?? 0
		}, persistRequestId);
		sendWorkflowTodoSnapshot(socket, requestId, session, plan, persistRequestId, phaseOutputs, phaseRunId);

		const phaseMessage: string = createPhaseMessage(state.originalParams, plan, phase, phaseOutputs);
		const isFinalPhase: boolean = index >= plan.phases.length - 1;
		const streamPhase: boolean = isFinalPhase && streamFinal;
		const phaseParams: AiChatParams = createPhaseParams(state.originalParams, phase, phaseMessage, streamPhase);
		const carriedGuidePromptSection: string = state.guidePromptSection ?? "";
		state = { ...state, guidePromptSection: undefined };
		const pendingGuidePromptSection: string = consumePendingGuideSection(socket, requestId, session, persistRequestId);
		const guidePromptSection: string = [
			carriedGuidePromptSection,
			pendingGuidePromptSection
		].filter((section: string): boolean => section.length > 0).join("\n\n");
		const fullSystemPrompt: string = await createWorkflowPhasePrompt(phase, phaseParams, mcpHost, session, requestId, guidePromptSection);
		let agentResult: ProviderAgentResult;
		let phaseToolStats: WorkflowPhaseToolStats = createEmptyWorkflowPhaseToolStats();
		let phaseToolObservations: WorkflowToolObservation[] = [];
		try {
			if (agentResultOverride !== undefined) {
				agentResult = agentResultOverride;
				phaseToolStats.approvalEvents = 1;
				phaseToolStats.writeToolEvents = 1;
				phaseToolObservations = agentResultOverrideToolObservations.length > 0 ? agentResultOverrideToolObservations : [{
					toolCallId: `${phaseRunId}-approved-continuation`,
					toolName: "approved_tool_continuation",
					risk: "write",
					status: "succeeded",
					parsedResult: {
						ok: true,
						validationStatus: "passed",
						summary: "审批通过后的工具调用已执行，LLM continuation 已恢复。"
					},
					artifactRefs: []
				}];
				agentResultOverrideToolObservations = [];
			} else {
				let phaseRunResult: WorkflowPhaseRunResult = await runWorkflowPhase(
					socket,
					phaseParams,
					options,
					state.history,
					fullSystemPrompt,
					phase,
					mcpHost,
					session,
					requestId,
					persistRequestId,
					plan.id,
					phaseRunId,
					streamPhase,
					abortSignal
				);
				agentResult = phaseRunResult.agentResult;
				phaseToolStats = phaseRunResult.toolStats;
				phaseToolObservations = phaseRunResult.toolObservations;

				if (
					agentResult.status === "completed"
					&& shouldRequireWorkflowWriteTool(phase)
					&& !didWorkflowWritePhaseExecute(phase, phaseToolStats)
				) {
					const retryPhaseParams: AiChatParams = createPhaseParams(
						state.originalParams,
						phase,
						createWorkflowWriteGuardRetryMessage(phaseMessage),
						false
					);
					phaseRunResult = await runWorkflowPhase(
						socket,
						retryPhaseParams,
						options,
						state.history,
						fullSystemPrompt,
						phase,
						mcpHost,
						session,
						requestId,
						persistRequestId,
						plan.id,
						phaseRunId,
						false,
						abortSignal
					);
					agentResult = phaseRunResult.agentResult;
					phaseToolStats = phaseRunResult.toolStats;
					phaseToolObservations = phaseRunResult.toolObservations;
				}
			}
		} catch (error: unknown) {
			throw new WorkflowExecutionError(error instanceof Error ? error.message : "Workflow phase failed", plan, error);
		}
		agentResultOverride = undefined;

		if (agentResult.status === "approval_required") {
			plan = updateWorkflowPhaseStatus(plan, phase.id, "paused");
			const approvalOutcome: WorkflowPhaseOutput = createWorkflowPhaseOutcome(phase, phaseRunId, "", phaseToolObservations);
			phaseOutputs = appendPhaseOutput(phaseOutputs, phase, approvalOutcome);
			const pausedState: WorkflowRunState = { ...state, plan, phaseIndex: index, phaseOutputs, activePhaseRunId: phaseRunId };
			const pendingContinuation: PendingAiContinuation = createWorkflowPendingContinuation(
				phaseParams,
				options,
				agentResult,
				phase,
				pausedState,
				persistRequestId,
				userCreatedAt,
				streamPhase
			);
			await registerPendingApprovalContinuation(session, mcpHost, agentResult.approvalId, pendingContinuation);
			sendWorkflowEvent(socket, requestId, session, "workflow.phase.outcome", {
				workflowId: plan.id,
				phaseId: phase.id,
				phaseRunId,
				outcome: approvalOutcome
			}, persistRequestId);
			sendWorkflowTodoSnapshot(socket, requestId, session, plan, persistRequestId, phaseOutputs, phaseRunId);
			sendAgentPaused(socket, requestId, session, plan.id, agentResult, persistRequestId);
			return;
		}

		if (agentResult.status === "protocol_violation") {
			const protocolOutcome: WorkflowPhaseOutput = {
				phaseId: phase.id,
				phaseRunId,
				title: phase.title,
				status: "blocked",
				summary: agentResult.reason,
				evidence: [],
				failedChecks: [{
					code: "protocol_violation",
					message: agentResult.reason,
					severity: "error"
				}],
				requiredFixes: ["模型必须通过 API tool_calls 调用工具，不能在文本中输出 XML/DSML/裸工具标签。"],
				modifiedArtifacts: [],
				verifiedArtifacts: [],
				toolObservations: phaseToolObservations,
				blockedReason: agentResult.reason
			};
			phaseOutputs = appendPhaseOutput(phaseOutputs, phase, protocolOutcome);
			plan = updateWorkflowPhaseStatus(plan, phase.id, "failed");
			sendWorkflowEvent(socket, requestId, session, "workflow.phase.outcome", {
				workflowId: plan.id,
				phaseId: phase.id,
				phaseRunId,
				outcome: protocolOutcome
			}, persistRequestId);
			sendWorkflowTodoSnapshot(socket, requestId, session, plan, persistRequestId, phaseOutputs, phaseRunId);
			throw new WorkflowExecutionError(agentResult.reason, plan, new Error(agentResult.reason), phaseOutputs);
		}

		if (shouldRequireWorkflowWriteTool(phase) && !didWorkflowWritePhaseExecute(phase, phaseToolStats)) {
			const guardMessage: string = `写入阶段「${phase.title}」没有实际调用写入工具或触发审批，已阻止将该 Todo 标记为完成。`;
			throw new WorkflowExecutionError(
				guardMessage,
				plan,
				new Error(guardMessage)
			);
		}

		const phaseOutcome: WorkflowPhaseOutput = applyDeterministicVerificationGate(
			phase,
			createWorkflowPhaseOutcome(phase, phaseRunId, agentResult.text, phaseToolObservations),
			phaseOutputs
		);
		if (phaseOutcome.status === "needs_fix") {
			if (countWorkflowAutoRepairRounds(plan) >= MAX_WORKFLOW_AUTO_REPAIR_ROUNDS) {
				const guardMessage: string = `验证阶段「${phase.title}」仍发现需要修复的问题，已达到自动修复次数上限。`;
				const blockedOutcome: WorkflowPhaseOutput = {
					...phaseOutcome,
					status: "blocked",
					summary: guardMessage,
					blockedReason: guardMessage
				};
				phaseOutputs = appendPhaseOutput(phaseOutputs, phase, blockedOutcome);
				plan = updateWorkflowPhaseStatus(plan, phase.id, "failed");
				sendWorkflowEvent(socket, requestId, session, "workflow.phase.outcome", {
					workflowId: plan.id,
					phaseId: phase.id,
					phaseRunId,
					outcome: blockedOutcome
				}, persistRequestId);
				sendWorkflowTodoSnapshot(socket, requestId, session, plan, persistRequestId, phaseOutputs);
				throw new WorkflowExecutionError(
					guardMessage,
					plan,
					new Error(`${guardMessage}\n\n${phaseOutcome.requiredFixes.join("\n")}`),
					phaseOutputs
				);
			}

			phaseOutputs = appendPhaseOutput(phaseOutputs, phase, phaseOutcome);
			plan = updateWorkflowPhaseStatus(plan, phase.id, "failed");
			sendWorkflowEvent(socket, requestId, session, "workflow.phase.outcome", {
				workflowId: plan.id,
				phaseId: phase.id,
				phaseRunId,
				outcome: phaseOutcome
			}, persistRequestId);
			plan = insertWorkflowAutoRepairPhases(plan, index + 1, phase, phaseOutcome.summary, phaseOutcome.failedChecks);
			state = { ...state, plan, phaseIndex: index + 1, phaseOutputs };
			sendWorkflowTodoSnapshot(socket, requestId, session, plan, persistRequestId, phaseOutputs);
			continue;
		}

		if (phaseOutcome.status === "blocked" || phaseOutcome.status === "failed") {
			phaseOutputs = appendPhaseOutput(phaseOutputs, phase, phaseOutcome);
			plan = updateWorkflowPhaseStatus(plan, phase.id, "failed");
			sendWorkflowEvent(socket, requestId, session, "workflow.phase.outcome", {
				workflowId: plan.id,
				phaseId: phase.id,
				phaseRunId,
				outcome: phaseOutcome
			}, persistRequestId);
			sendWorkflowTodoSnapshot(socket, requestId, session, plan, persistRequestId, phaseOutputs);
			throw new WorkflowExecutionError(phaseOutcome.summary, plan, new Error(phaseOutcome.summary), phaseOutputs);
		}

		phaseOutputs = appendPhaseOutput(phaseOutputs, phase, phaseOutcome);
		plan = updateWorkflowPhaseStatus(plan, phase.id, "done");
		state = { ...state, plan, phaseIndex: index + 1, phaseOutputs };
		sendWorkflowEvent(socket, requestId, session, "workflow.phase.outcome", {
			workflowId: plan.id,
			phaseId: phase.id,
			phaseRunId,
			outcome: phaseOutcome
		}, persistRequestId);
		sendWorkflowEvent(socket, requestId, session, "workflow.phase.done", {
			workflowId: plan.id,
			phaseId: phase.id,
			phaseRunId,
			title: phase.title
		}, persistRequestId);
		sendWorkflowTodoSnapshot(socket, requestId, session, plan, persistRequestId, phaseOutputs);

		if (isFinalPhase) {
			await appendChatTurnToSession(
				session,
				state.history,
				state.originalParams.message,
				agentResult.text,
				persistRequestId,
				userCreatedAt,
				undefined,
				state.originalParams.additionalContext
			);
			sendWorkflowEvent(socket, requestId, session, "workflow.done", {
				workflowId: plan.id,
				title: plan.title
			}, persistRequestId);

			if (streamFinal) {
				sendSessionEvent(socket, requestId, session, "agent.message.done", {
					runId: plan.id,
					stepRunId: phaseRunId,
					text: agentResult.text,
					context: {
						historyMessagesStored: session.messages.length,
						historyBudgetTokens: state.historyBudgetTokens,
						mcpServers: mcpHost.getConnectedServerIds()
					}
				}, persistRequestId);
			} else {
				sendSessionEvent(socket, requestId, session, "agent.message.done", {
					runId: plan.id,
					stepRunId: phaseRunId,
					text: agentResult.text,
					context: {
						historyMessagesStored: session.messages.length,
						historyBudgetTokens: state.historyBudgetTokens,
						mcpServers: mcpHost.getConnectedServerIds()
					}
				}, persistRequestId);
				sendJson(socket, {
					type: "response",
					id: requestId,
					ok: true,
					result: {
						text: agentResult.text,
						context: {
							historyMessagesStored: session.messages.length,
							historyBudgetTokens: state.historyBudgetTokens,
							mcpServers: mcpHost.getConnectedServerIds()
						}
					}
				});
			}
			return;
		}

		if (plan.source === "llm") {
			try {
				const revisionGuidePromptSection: string = consumePendingGuideSection(socket, requestId, session, persistRequestId);
				const revisionPlanningContext: string = [
					planningContext,
					revisionGuidePromptSection
				].filter((section: string): boolean => section.length > 0).join("\n\n");
				if (revisionGuidePromptSection.length > 0) {
					state = {
						...state,
						guidePromptSection: [
							state.guidePromptSection ?? "",
							revisionGuidePromptSection
						].filter((section: string): boolean => section.length > 0).join("\n\n")
					};
				}
				const revisedPlan: WorkflowPlan = await reviseLlmWorkflowPlan(
					plan,
					index,
					state.originalParams,
					phaseOutputs,
					options,
					state.history,
					revisionPlanningContext,
					abortSignal
				);
				if ((revisedPlan.revision ?? 0) !== (plan.revision ?? 0)) {
					plan = revisedPlan;
					state = { ...state, plan, phaseIndex: index + 1, phaseOutputs };
					sendWorkflowTodoSnapshot(socket, requestId, session, plan, persistRequestId, phaseOutputs);
				}
			} catch (error: unknown) {
				console.warn("[workflow] LLM plan revision failed, continuing current plan:", error);
			}
		}
	}
}
