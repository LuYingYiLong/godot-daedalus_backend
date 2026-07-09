import type WebSocket from "ws";
import type { AiChatParams, ChatMessage } from "../protocol/types.js";
import { chatWithDeepSeek, type ProviderChatOptions } from "../providers/deepseek-client.js";
import { parseJsonObjectLoose } from "./next-step-hints.js";
import type { ClientSession } from "./client-session.js";
import { clipTextByChars, cloneAdditionalContextItems } from "./additional-context.js";
import {
	createPlanEventPayload,
	createPlanMetadata,
	type PlanRecommendedReply,
	type StoredPlan,
	type StoredPlanMetadata,
	updateStoredPlan,
	writeStoredPlan
} from "./plan-store.js";
import { sendSessionEvent, waitForSessionEventPersistence } from "./session-events.js";
import { appendTranscriptOnlyChatTurnToSession } from "./transcript-history.js";
import { logger } from "../logger.js";

const PLAN_PREVIEW_MAX_CHARS: number = 1600;
const CLARIFICATION_REPLY_MAX_COUNT: number = 3;

export type PlanDecision =
	| {
		decision: "needs_clarification";
		title: string;
		question: string;
		recommendedReplies: PlanRecommendedReply[];
	}
	| {
		decision: "plan_ready";
		title: string;
		planMarkdown: string;
		assumptions: string[];
	};

function isBroadGodotPluginGoal(message: string): boolean {
	const normalized: string = message.trim().toLowerCase();
	if (normalized.length === 0 || normalized.length > 120) {
		return false;
	}

	const hasBuildIntent: boolean = /帮我|做一个|开发|实现|打造|创建/.test(normalized);
	const hasGodotAiPlugin: boolean = normalized.includes("godot") && (normalized.includes("ai") || normalized.includes("插件") || normalized.includes("plugin"));
	const hasConcreteScope: boolean = /前端|后端|ui|界面|gds|gdscript|typescript|ts|provider|供应商|mcp|审批|会话|工具|场景|脚本|测试/.test(normalized);
	return hasBuildIntent && hasGodotAiPlugin && !hasConcreteScope;
}

function createGodotPluginClarification(message: string): PlanDecision {
	return {
		decision: "needs_clarification",
		title: "Godot AI 插件方向澄清",
		question: "这个目标比较大。你想先把 Godot AI 插件推进到哪个方向？",
		recommendedReplies: [
			{
				label: "前端 GDS 插件",
				text: "先做前端 GDS 插件，重点是 Godot 编辑器 UI、会话面板、审批交互和 EditorBridge。",
				description: "适合先打磨用户可见体验。"
			},
			{
				label: "后端 TS 服务",
				text: "先做后端 TypeScript 服务，重点是 WebSocket/RPC、LLM provider、MCP 工具、审批和会话持久化。",
				description: "适合先稳定能力底座。"
			},
			{
				label: "UI 原型",
				text: "先做 UI/交互原型，重点是聊天、计划、审批、diff、设置和多前端协作流程。",
				description: "适合先确认产品形态。"
			}
		]
	};
}

function normalizeRecommendedReplies(value: unknown): PlanRecommendedReply[] {
	if (!Array.isArray(value)) {
		return [];
	}

	const replies: PlanRecommendedReply[] = [];
	for (const item of value) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			continue;
		}
		const record: Record<string, unknown> = item as Record<string, unknown>;
		const label: string = String(record.label ?? record.title ?? "").trim();
		const text: string = String(record.text ?? record.message ?? "").trim();
		const description: string = String(record.description ?? "").trim();
		if (label.length === 0 || text.length === 0) {
			continue;
		}
		replies.push({
			label: clipTextByChars(label, 32),
			text: clipTextByChars(text, 1200),
			description: description.length > 0 ? clipTextByChars(description, 180) : undefined
		});
		if (replies.length >= CLARIFICATION_REPLY_MAX_COUNT) {
			break;
		}
	}
	return replies;
}

function ensurePlanMarkdown(title: string, markdown: string, assumptions: readonly string[]): string {
	const trimmedMarkdown: string = markdown.trim();
	const lines: string[] = [];
	if (!trimmedMarkdown.startsWith("#")) {
		lines.push(`# ${title}`);
	}
	lines.push(trimmedMarkdown.length > 0 ? trimmedMarkdown : "## Summary\n\n需要先补充计划内容。");
	if (assumptions.length > 0 && !trimmedMarkdown.toLowerCase().includes("assumption")) {
		lines.push("\n## Assumptions");
		for (const assumption of assumptions) {
			lines.push(`- ${assumption}`);
		}
	}
	return lines.join("\n").trim() + "\n";
}

function createPlanPreview(markdown: string): string {
	return clipTextByChars(markdown.trim(), PLAN_PREVIEW_MAX_CHARS);
}

function createPlannerSystemPrompt(): string {
	return [
		"你是 Godot Daedalus 的 Plan 模式规划器。此阶段只能澄清和生成计划，不能执行、不能写文件、不能假装已经修改项目。",
		"先判断用户目标是否足够明确；如果直接做容易偏离真实需求，必须要求澄清。",
		"关键缺失信息会影响整体设计时必须问；不关键的信息可以写入 assumptions。",
		"输出必须是 JSON object，不要输出 markdown fence。",
		"需要澄清时格式：{\"decision\":\"needs_clarification\",\"title\":\"短标题\",\"question\":\"一个问题\",\"recommendedReplies\":[{\"label\":\"短按钮\",\"text\":\"用户可直接采用的澄清回复\",\"description\":\"可选说明\"}]}。",
		"计划就绪时格式：{\"decision\":\"plan_ready\",\"title\":\"短标题\",\"planMarkdown\":\"完整 Markdown 计划\",\"assumptions\":[\"合理假设\"]}。",
		"recommendedReplies 最多 3 条。planMarkdown 必须包含 Summary、Key Changes、Public Interfaces、Test Plan、Assumptions。"
	].join("\n");
}

function createPlannerMessage(originalMessage: string, clarifications: readonly string[], revisions: readonly string[], currentPlanMarkdown?: string | undefined): string {
	const lines: string[] = [
		"用户原始目标：",
		originalMessage.trim()
	];
	if (clarifications.length > 0) {
		lines.push("\n用户澄清：");
		for (const clarification of clarifications) {
			lines.push(`- ${clarification}`);
		}
	}
	if (currentPlanMarkdown !== undefined && currentPlanMarkdown.trim().length > 0) {
		lines.push("\n当前计划：");
		lines.push(currentPlanMarkdown.trim());
	}
	if (revisions.length > 0) {
		lines.push("\n用户修订反馈：");
		for (const revision of revisions) {
			lines.push(`- ${revision}`);
		}
	}
	return lines.join("\n");
}

function normalizePlanDecision(raw: unknown, fallbackTitle: string): PlanDecision {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error("Plan planner returned non-object JSON.");
	}
	const record: Record<string, unknown> = raw as Record<string, unknown>;
	const decision: string = String(record.decision ?? "").trim();
	const title: string = clipTextByChars(String(record.title ?? fallbackTitle).trim() || fallbackTitle, 80);
	if (decision === "needs_clarification") {
		const question: string = String(record.question ?? "").trim();
		const replies: PlanRecommendedReply[] = normalizeRecommendedReplies(record.recommendedReplies);
		if (question.length === 0 || replies.length === 0) {
			throw new Error("Plan clarification decision is missing question or replies.");
		}
		return {
			decision: "needs_clarification",
			title,
			question: clipTextByChars(question, 600),
			recommendedReplies: replies
		};
	}
	if (decision === "plan_ready") {
		const assumptions: string[] = Array.isArray(record.assumptions)
			? record.assumptions.map((item: unknown): string => String(item).trim()).filter((item: string): boolean => item.length > 0).slice(0, 12)
			: [];
		return {
			decision: "plan_ready",
			title,
			planMarkdown: ensurePlanMarkdown(title, String(record.planMarkdown ?? "").trim(), assumptions),
			assumptions
		};
	}
	throw new Error(`Unknown plan decision: ${decision}`);
}

export async function createPlanDecision(
	params: AiChatParams,
	options: ProviderChatOptions,
	clarifications: readonly string[] = [],
	revisions: readonly string[] = [],
	currentPlanMarkdown?: string | undefined,
	abortSignal?: AbortSignal | undefined
): Promise<PlanDecision> {
	if (clarifications.length === 0 && revisions.length === 0 && isBroadGodotPluginGoal(params.message)) {
		return createGodotPluginClarification(params.message);
	}

	const plannerParams: AiChatParams = {
		message: createPlannerMessage(params.message, clarifications, revisions, currentPlanMarkdown),
		mode: "plan",
		options: {
			temperature: 0.2,
			maxTokens: 3200,
			responseFormat: "json",
			stream: false
		}
	};
	const responseText: string = await chatWithDeepSeek(
		plannerParams,
		options,
		[] satisfies ChatMessage[],
		createPlannerSystemPrompt(),
		abortSignal
	);
	const rawDecision: unknown = parseJsonObjectLoose(responseText);
	return normalizePlanDecision(rawDecision, "执行计划");
}

export async function createInitialPlan(
	socket: WebSocket,
	requestId: string,
	session: ClientSession,
	params: AiChatParams,
	options: ProviderChatOptions,
	turnStartedAt: string,
	abortSignal?: AbortSignal | undefined
): Promise<StoredPlan> {
	if (!session.sessionId) {
		throw new Error("Plan mode requires an active session.");
	}
	const decision: PlanDecision = await createPlanDecision(params, options, [], [], undefined, abortSignal);
	let metadata: StoredPlanMetadata;
	let markdown: string;
	let assistantMessage: string;
	let eventName: "plan.clarification.required" | "plan.generated";
	if (decision.decision === "needs_clarification") {
		metadata = createPlanMetadata({
			sessionId: session.sessionId,
			requestId,
			status: "clarification_required",
			title: decision.title,
			originalMessage: params.message,
			clarificationQuestion: decision.question,
			recommendedReplies: decision.recommendedReplies
		});
		markdown = "";
		assistantMessage = `需要澄清：${decision.question}`;
		eventName = "plan.clarification.required";
	} else {
		markdown = decision.planMarkdown;
		metadata = createPlanMetadata({
			sessionId: session.sessionId,
			requestId,
			status: "ready",
			title: decision.title,
			originalMessage: params.message,
			previewMarkdown: createPlanPreview(markdown)
		});
		assistantMessage = metadata.previewMarkdown;
		eventName = "plan.generated";
	}

	const storedPlan: StoredPlan = await writeStoredPlan(metadata, markdown);
	sendSessionEvent(socket, requestId, session, eventName, createPlanEventPayload(storedPlan));
	sendSessionEvent(socket, requestId, session, "agent.message.done", {
		runId: requestId,
		mode: "plan",
		planId: metadata.planId
	});
	await waitForSessionEventPersistence(session);
	await appendTranscriptOnlyChatTurnToSession(
		session,
		params.message,
		assistantMessage,
		requestId,
		turnStartedAt,
		new Date().toISOString(),
		cloneAdditionalContextItems(params.additionalContext)
	);
	logger.info("plan", "plan_turn_created", {
		requestId,
		sessionId: session.sessionId,
		planId: metadata.planId,
		status: metadata.status
	});
	return storedPlan;
}

export async function applyPlanClarification(
	plan: StoredPlan,
	reply: string,
	options: ProviderChatOptions,
	abortSignal?: AbortSignal | undefined
): Promise<StoredPlan> {
	const nextClarifications: string[] = [...plan.metadata.clarifications, reply.trim()];
	const decision: PlanDecision = await createPlanDecision(
		{ message: plan.metadata.originalMessage, mode: "plan" },
		options,
		nextClarifications,
		plan.metadata.revisions,
		plan.markdown,
		abortSignal
	);
	return updateStoredPlan(plan.metadata.sessionId, plan.metadata.planId, (): StoredPlan => {
		if (decision.decision === "needs_clarification") {
			return {
				metadata: {
					...plan.metadata,
					status: "clarification_required",
					title: decision.title,
					clarificationQuestion: decision.question,
					recommendedReplies: decision.recommendedReplies,
					clarifications: nextClarifications
				},
				markdown: ""
			};
		}
		const markdown: string = decision.planMarkdown;
		return {
			metadata: {
				...plan.metadata,
				status: "ready",
				title: decision.title,
				previewMarkdown: createPlanPreview(markdown),
				clarificationQuestion: undefined,
				recommendedReplies: [],
				clarifications: nextClarifications
			},
			markdown
		};
	});
}

export async function applyPlanRevision(
	plan: StoredPlan,
	feedback: string,
	options: ProviderChatOptions,
	abortSignal?: AbortSignal | undefined
): Promise<StoredPlan> {
	const nextRevisions: string[] = [...plan.metadata.revisions, feedback.trim()];
	const decision: PlanDecision = await createPlanDecision(
		{ message: plan.metadata.originalMessage, mode: "plan" },
		options,
		plan.metadata.clarifications,
		nextRevisions,
		plan.markdown,
		abortSignal
	);
	return updateStoredPlan(plan.metadata.sessionId, plan.metadata.planId, (): StoredPlan => {
		if (decision.decision === "needs_clarification") {
			return {
				metadata: {
					...plan.metadata,
					status: "clarification_required",
					title: decision.title,
					clarificationQuestion: decision.question,
					recommendedReplies: decision.recommendedReplies,
					revisions: nextRevisions
				},
				markdown: plan.markdown
			};
		}
		const markdown: string = decision.planMarkdown;
		return {
			metadata: {
				...plan.metadata,
				status: "ready",
				title: decision.title,
				previewMarkdown: createPlanPreview(markdown),
				clarificationQuestion: undefined,
				recommendedReplies: [],
				revisions: nextRevisions
			},
			markdown
		};
	});
}

export function createApprovedPlanSystemPrompt(markdown: string): string {
	return [
		"以下是用户已经批准的 Daedalus Plan。执行阶段必须以该计划为主要约束。",
		"如果执行中发现计划与实际项目冲突，先说明阻塞点或走正常审批/验证流程，不要擅自扩大范围。",
		"",
		markdown.trim()
	].join("\n");
}
