import { z } from "zod";
import type { AiChatParams, ChatMessage } from "../protocol/types.js";
import { chatWithDeepSeek, type ProviderChatOptions } from "../providers/deepseek-client.js";
import { parseJsonObjectFromLlm } from "../providers/llm-json.js";
import { isExplicitReadOnlyRequest } from "./planner.js";

export type WorkflowRouteExecution = "direct_answer" | "tool_answer" | "workflow";
export type WorkflowOption = NonNullable<NonNullable<AiChatParams["options"]>["workflow"]>;

export type WorkflowRouteDecision = {
	execution: WorkflowRouteExecution;
	reason: string;
	requiresTools: boolean;
	requiresWrite: boolean;
	planningHint: string;
	forcedByOption?: WorkflowOption | undefined;
	safetyOverride?: string | undefined;
};

export type WorkflowRouteContext = {
	workspaceSummary: string;
	editorSummary: string;
	additionalContextSummary: string;
};

const workflowRouteSchema = z.object({
	execution: z.enum(["direct_answer", "tool_answer", "workflow"]),
	reason: z.string().min(1).max(500).optional(),
	requiresTools: z.boolean().optional(),
	requiresWrite: z.boolean().optional(),
	planningHint: z.string().max(1000).optional()
}).strict();

type RawWorkflowRouteDecision = z.infer<typeof workflowRouteSchema>;

export function resolveForcedWorkflowRoute(params: AiChatParams): WorkflowRouteDecision | null {
	const workflowMode = params.options?.workflow ?? "auto";
	if (workflowMode === "auto") {
		return null;
	}

	if (workflowMode === "single") {
		return applyWorkflowRouteSafety({
			execution: "tool_answer",
			reason: "Explicit workflow=single forces hidden single-turn execution.",
			requiresTools: true,
			requiresWrite: false,
			planningHint: "",
			forcedByOption: workflowMode
		}, params);
	}

	return applyWorkflowRouteSafety({
		execution: "workflow",
		reason: `Explicit workflow=${workflowMode} forces workflow execution.`,
		requiresTools: true,
		requiresWrite: workflowMode === "multi_phase" || workflowMode === "llm_planned",
		planningHint: "",
		forcedByOption: workflowMode
	}, params);
}

export async function routeWorkflowExecution(
	params: AiChatParams,
	options: ProviderChatOptions,
	history: ChatMessage[],
	context: WorkflowRouteContext,
	abortSignal?: AbortSignal | undefined
): Promise<WorkflowRouteDecision> {
	const forcedRoute: WorkflowRouteDecision | null = resolveForcedWorkflowRoute(params);
	if (forcedRoute !== null) {
		return forcedRoute;
	}

	const text: string = await chatWithDeepSeek(
		createRouterParams(createRouteUserMessage(params, context)),
		options,
		limitRoutingHistory(history),
		createRouteSystemPrompt(),
		abortSignal
	);
	return normalizeWorkflowRouteDecision(parseWorkflowRouteDecision(text), params);
}

export function createFallbackWorkflowRoute(params: AiChatParams, reason: string = "Workflow router failed."): WorkflowRouteDecision {
	return applyWorkflowRouteSafety({
		execution: "tool_answer",
		reason,
		requiresTools: true,
		requiresWrite: false,
		planningHint: "",
		safetyOverride: "router_fallback"
	}, params);
}

export function normalizeWorkflowRouteDecision(raw: RawWorkflowRouteDecision, params: AiChatParams): WorkflowRouteDecision {
	const execution: WorkflowRouteExecution = raw.execution;
	const requiresWrite: boolean = raw.requiresWrite === true || execution === "workflow";
	const decision: WorkflowRouteDecision = {
		execution,
		reason: raw.reason?.trim() || "Routed by workflow router.",
		requiresTools: raw.requiresTools ?? execution !== "direct_answer",
		requiresWrite,
		planningHint: raw.planningHint?.trim() ?? ""
	};
	return applyWorkflowRouteSafety(decision, params);
}

export function applyWorkflowRouteSafety(decision: WorkflowRouteDecision, params: AiChatParams): WorkflowRouteDecision {
	const explicitReadOnly: boolean = isExplicitReadOnlyRequest(params.message.toLowerCase());
	if (!explicitReadOnly && params.mode !== "ask") {
		return decision;
	}

	if (!decision.requiresWrite) {
		return decision;
	}

	return {
		...decision,
		execution: "tool_answer",
		requiresTools: true,
		requiresWrite: false,
		planningHint: "",
		safetyOverride: explicitReadOnly ? "explicit_read_only" : "ask_mode_read_only",
		reason: `${decision.reason} Safety override forced read-only tool answer.`
	};
}

function parseWorkflowRouteDecision(text: string): RawWorkflowRouteDecision {
	return workflowRouteSchema.parse(parseJsonObjectFromLlm(text, "Workflow router did not return valid JSON"));
}

function createRouterParams(message: string): AiChatParams {
	return {
		message,
		options: {
			temperature: 0,
			maxTokens: 700,
			responseFormat: "json",
			workflow: "single"
		}
	};
}

function createRouteSystemPrompt(): string {
	return [
		"你是 Godot Daedalus 的执行路由器，只输出 JSON，不调用工具，不解释。",
		"判断本轮请求应该使用哪种执行形态：",
		"- direct_answer：普通问答、解释、建议、无需读取实时项目事实。",
		"- tool_answer：需要读取/验证当前事实，但不需要拆成多阶段 Todo，也不需要写入。",
		"- workflow：需要写入、审批、验证闭环、复杂排查、多文件实现或明确要求执行计划。",
		"输出格式：",
		"{\"execution\":\"direct_answer|tool_answer|workflow\",\"reason\":\"简短原因\",\"requiresTools\":true,\"requiresWrite\":false,\"planningHint\":\"给后续 planner 的简短提示\"}",
		"规则：",
		"- 简单动态事实查询，例如当前 workspace、文件数量、状态、路径，选 tool_answer。",
		"- 代码解释、概念说明、方案讨论，选 direct_answer，除非必须读取当前文件。",
		"- 创建、修改、修复、生成项目内容，选 workflow。",
		"- 用户明确只读/不要修改时 requiresWrite 必须为 false。",
		"- 不要因为存在 workspace/editor 上下文就自动选 workflow。"
	].join("\n");
}

function createRouteUserMessage(params: AiChatParams, context: WorkflowRouteContext): string {
	return [
		"## 用户请求",
		params.message,
		"",
		"## 会话模式",
		params.mode ?? "agent",
		"",
		"## Workspace",
		context.workspaceSummary,
		"",
		"## Editor",
		context.editorSummary,
		"",
		"## Additional Context",
		context.additionalContextSummary
	].join("\n");
}

function limitRoutingHistory(history: ChatMessage[]): ChatMessage[] {
	return history.slice(-4);
}
