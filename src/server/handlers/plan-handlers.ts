import type WebSocket from "ws";
import type { AiChatParams, ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { sendJson } from "../send-json.js";
import { ensureProviderConfigured } from "../../application/provider-session-service.js";
import { createProviderChatOptions } from "../provider-chat-options.js";
import { getProviderDisplayName } from "../../providers/provider-registry.js";
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
	sendPlanMessageDone
} from "../plan-mode.js";
import { sendSessionEvent } from "../session-events.js";
import { handleChatRequest } from "../chat-orchestrator.js";
import { getActiveSessionRunRequestId } from "../client-connections.js";
import { logger } from "../../logger.js";
import { updateSessionMetadata } from "../../session/session-store.js";
import { createRuntimeSessionUiMetadata } from "../session-ui-metadata.js";
import { bumpWorkbenchRevision, emitWorkbenchUpdated, serializeWorkbench } from "../workbench.js";

const PLAN_EXECUTION_SLOT_WAIT_TIMEOUT_MS: number = 2000;
const PLAN_EXECUTION_SLOT_WAIT_INTERVAL_MS: number = 25;

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
	const payload: Record<string, unknown> = {
		...createPlanEventPayload(plan),
		operationRequestId: requestId
	};
	if (plan.metadata.status === "clarification_required") {
		sendSessionEvent(socket, plan.metadata.requestId, session, "plan.clarification.required", payload);
		sendPlanMessageDone(socket, plan.metadata.requestId, session, plan.metadata.planId, plan.metadata.requestId, requestId);
		return;
	}
	sendSessionEvent(socket, plan.metadata.requestId, session, revised ? "plan.revised" : "plan.generated", payload);
	sendPlanMessageDone(socket, plan.metadata.requestId, session, plan.metadata.planId, plan.metadata.requestId, requestId);
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve: () => void): void => {
		setTimeout(resolve, ms);
	});
}

async function waitForPlanExecutionSlot(session: ClientSession, originalRequestId: string): Promise<boolean> {
	const startedAtMs: number = Date.now();
	while (Date.now() - startedAtMs < PLAN_EXECUTION_SLOT_WAIT_TIMEOUT_MS) {
		const activeRunRequestId: string | undefined = session.activeRunRequestId ?? getActiveSessionRunRequestId(session.sessionId);
		if (activeRunRequestId === undefined) {
			return true;
		}
		if (activeRunRequestId !== originalRequestId) {
			return false;
		}
		await wait(PLAN_EXECUTION_SLOT_WAIT_INTERVAL_MS);
	}

	return false;
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
				const apiKey: string | undefined = await ensureProviderConfigured(session);
				if (!apiKey) {
					sendProviderMissing(socket, request.id, session);
					return;
				}
				const plan: StoredPlan = await readStoredPlan(sessionId, request.params.planId);
				const options = createProviderChatOptions(session, apiKey);
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
				const apiKey: string | undefined = await ensureProviderConfigured(session);
				if (!apiKey) {
					sendProviderMissing(socket, request.id, session);
					return;
				}
				const plan: StoredPlan = await readStoredPlan(sessionId, request.params.planId);
				const options = createProviderChatOptions(session, apiKey);
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
				session.workbenchComposer.chatMode = "agent";
				session.workbenchComposer.updatedAt = approvedAt;
				bumpWorkbenchRevision(session);
				await updateSessionMetadata(sessionId, createRuntimeSessionUiMetadata(session));
				emitWorkbenchUpdated(socket, request.id, session);
				const approvedPlan: StoredPlan = await updateStoredPlan(sessionId, plan.metadata.planId, (current: StoredPlan): StoredPlan => ({
					metadata: {
						...current.metadata,
						status: "approved",
						approvedAt
					},
					markdown: current.markdown
				}));
				// sendSessionEvent(socket, plan.metadata.requestId, session, "plan.approved", {
				// 	...createPlanEventPayload(approvedPlan),
				// 	operationRequestId: request.id
				// });
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
						executionRequestId,
						chatMode: "agent",
						workbench: serializeWorkbench(session)
					}
				});

				const executionParams: AiChatParams = createApprovedPlanExecutionParams(
					plan,
					session.activeProvider,
					session.providerModel ?? session.modelProfile.model
				);
				const executionRequest: ClientRequest = {
					type: "request",
					id: executionRequestId,
					method: "ai.chat",
					params: executionParams
				};
				setTimeout((): void => {
					void (async (): Promise<void> => {
						const executionSlotAvailable: boolean = await waitForPlanExecutionSlot(session, plan.metadata.requestId);
						if (!executionSlotAvailable) {
							throw new Error("Timed out waiting for the plan authoring run to finish before executing the approved plan.");
						}
						await handleChatRequest(socket, executionRequest, session, mcpHost);
					})().catch((error: unknown): void => {
						const message: string = error instanceof Error ? error.message : String(error);
						sendSessionEvent(socket, executionRequestId, session, "agent.run.error", {
							runId: executionRequestId,
							code: "plan_execution_failed",
							message
						});
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
