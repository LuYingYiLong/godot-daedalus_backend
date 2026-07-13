import type WebSocket from "ws";
import type { AiChatParams, ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { sendJson } from "../send-json.js";
import { ensureProviderConfigured } from "../../application/provider-session-service.js";
import { createProviderChatOptions } from "../provider-chat-options.js";
import { getProviderDisplayName } from "../../providers/provider-registry.js";
import { resolveProviderTaskModelOptions } from "../../providers/task-model-routing.js";
import {
	createPlanEventPayload,
	createPlanGetResult,
	readStoredPlan,
	type StoredPlan,
	updateStoredPlan
} from "../plan-store.js";
import {
	applyPlanClarification,
	applyPlanRevision,
	createApprovedPlanExecutionParams,
	sendPlanMessageDelta,
	sendPlanMessageDone
} from "../plan-mode.js";
import { sendSessionEvent } from "../session-events.js";
import { handleChatRequest } from "../chat-orchestrator.js";
import { logger } from "../../logger.js";

function sendProviderMissing(socket: WebSocket, requestId: string, session: ClientSession): void {
	sendJson(socket, {
		type: "response",
		id: requestId,
		ok: false,
		error: {
			code: "provider_not_configured",
			message: `${getProviderDisplayName(session.activeProvider)} API key is not configured. Save it with provider.config.set first.`
		}
	});
}

function getActiveSessionId(session: ClientSession, requestedSessionId?: string | undefined): string | undefined {
	if (session.sessionId === undefined) {
		return undefined;
	}
	if (requestedSessionId !== undefined && requestedSessionId !== session.sessionId) {
		return undefined;
	}
	return session.sessionId;
}

function sendPlanResponse(socket: WebSocket, requestId: string, plan: StoredPlan): void {
	sendJson(socket, {
		type: "response",
		id: requestId,
		ok: true,
		result: createPlanGetResult(plan)
	});
}

async function emitPlanUpdate(socket: WebSocket, requestId: string, session: ClientSession, plan: StoredPlan, revised: boolean): Promise<void> {
	if (plan.metadata.status === "clarification_required") {
		sendPlanMessageDelta(socket, requestId, session, `我还需要继续确认一个关键点：\n\n${plan.metadata.clarificationQuestion ?? ""}\n`);
		sendSessionEvent(socket, requestId, session, "plan.clarification.required", createPlanEventPayload(plan));
		sendPlanMessageDone(socket, requestId, session, plan.metadata.planId);
		return;
	}
	sendPlanMessageDelta(socket, requestId, session, revised ? "我已根据你的反馈修订计划，请重新预览并确认。\n" : "我已根据你的澄清生成计划，请预览并确认。\n");
	sendSessionEvent(socket, requestId, session, revised ? "plan.revised" : "plan.generated", createPlanEventPayload(plan));
	sendPlanMessageDone(socket, requestId, session, plan.metadata.planId);
}

export async function handlePlanRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, mcpHost: McpHost): Promise<void> {
	try {
		switch (request.method) {
			case "plan.get": {
				const sessionId: string | undefined = getActiveSessionId(session, request.params.sessionId);
				if (sessionId === undefined) {
					sendJson(socket, {
						type: "response",
						id: request.id,
						ok: false,
						error: {
							code: "session_mismatch",
							message: "Plans can only be read for the active session."
						}
					});
					return;
				}
				const plan: StoredPlan = await readStoredPlan(sessionId, request.params.planId);
				sendPlanResponse(socket, request.id, plan);
				return;
			}

			case "plan.clarify": {
				const sessionId: string | undefined = getActiveSessionId(session);
				if (sessionId === undefined) {
					throw new Error("Plan clarification requires an active session.");
				}
				sendPlanMessageDelta(socket, request.id, session, "我正在吸收你的澄清并重新判断计划是否足够明确。\n\n");
				const apiKey: string | undefined = await ensureProviderConfigured(session);
				if (!apiKey) {
					sendProviderMissing(socket, request.id, session);
					return;
				}
				const plan: StoredPlan = await readStoredPlan(sessionId, request.params.planId);
				const options = (await resolveProviderTaskModelOptions("workflowPlanner", createProviderChatOptions(session, apiKey))).options;
				const updatedPlan: StoredPlan = await applyPlanClarification(
					plan,
					request.params.reply,
					options,
					{
						socket,
						requestId: request.id,
						session,
						mcpHost
					}
				);
				await emitPlanUpdate(socket, request.id, session, updatedPlan, false);
				sendPlanResponse(socket, request.id, updatedPlan);
				return;
			}

			case "plan.revise": {
				const sessionId: string | undefined = getActiveSessionId(session);
				if (sessionId === undefined) {
					throw new Error("Plan revision requires an active session.");
				}
				sendPlanMessageDelta(socket, request.id, session, "我正在根据你的反馈修订计划，会保持在只读规划阶段。\n\n");
				const apiKey: string | undefined = await ensureProviderConfigured(session);
				if (!apiKey) {
					sendProviderMissing(socket, request.id, session);
					return;
				}
				const plan: StoredPlan = await readStoredPlan(sessionId, request.params.planId);
				const options = (await resolveProviderTaskModelOptions("workflowPlanner", createProviderChatOptions(session, apiKey))).options;
				const updatedPlan: StoredPlan = await applyPlanRevision(
					plan,
					request.params.feedback,
					options,
					{
						socket,
						requestId: request.id,
						session,
						mcpHost
					}
				);
				await emitPlanUpdate(socket, request.id, session, updatedPlan, true);
				sendPlanResponse(socket, request.id, updatedPlan);
				return;
			}

			case "plan.approve": {
				const sessionId: string | undefined = getActiveSessionId(session);
				if (sessionId === undefined) {
					throw new Error("Plan approval requires an active session.");
				}
				const plan: StoredPlan = await readStoredPlan(sessionId, request.params.planId);
				if (plan.metadata.status !== "ready") {
					sendJson(socket, {
						type: "response",
						id: request.id,
						ok: false,
						error: {
							code: "plan_not_ready",
							message: "Only ready plans can be approved."
						}
					});
					return;
				}

				const approvedAt: string = new Date().toISOString();
				const executionRequestId: string = `plan-exec-${plan.metadata.planId}-${Date.now().toString(36)}`;
				const approvedPlan: StoredPlan = await updateStoredPlan(sessionId, plan.metadata.planId, (current: StoredPlan): StoredPlan => ({
					metadata: {
						...current.metadata,
						status: "approved",
						approvedAt
					},
					markdown: current.markdown
				}));
				sendSessionEvent(socket, request.id, session, "plan.approved", createPlanEventPayload(approvedPlan));
				const executingPlan: StoredPlan = await updateStoredPlan(sessionId, plan.metadata.planId, (current: StoredPlan): StoredPlan => ({
					metadata: {
						...current.metadata,
						status: "executing",
						executedRequestId: executionRequestId
					},
					markdown: current.markdown
				}));
				sendSessionEvent(socket, executionRequestId, session, "plan.execution.started", {
					...createPlanEventPayload(executingPlan),
					executionRequestId,
					originalRequestId: plan.metadata.requestId
				});
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result: {
						planApproved: true,
						planId: plan.metadata.planId,
						executionRequestId
					}
				});

				const executionParams: AiChatParams = createApprovedPlanExecutionParams(plan);
				const executionRequest: ClientRequest = {
					type: "request",
					id: executionRequestId,
					method: "ai.chat",
					params: executionParams
				};
				setTimeout((): void => {
					void handleChatRequest(socket, executionRequest, session, mcpHost).catch((error: unknown): void => {
						logger.error("plan", "approved_plan_execution_failed", error, {
							planId: plan.metadata.planId,
							sessionId,
							executionRequestId
						});
					});
				}, 0);
				return;
			}

			default:
				throw new Error(`Unsupported plan method: ${request.method}`);
		}
	} catch (error: unknown) {
		const message: string = error instanceof Error ? error.message : String(error);
		logger.error("plan", "plan_request_failed", error, {
			requestId: request.id,
			method: request.method,
			sessionId: session.sessionId
		});
		sendSessionEvent(socket, request.id, session, "plan.error", {
			code: "plan_error",
			message
		});
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: false,
			error: {
				code: "plan_error",
				message
			}
		});
	}
}
