import type { z } from "zod";
import type { additionalContextItemSchema, aiChatParamsSchema, clientRequestSchema, promptIdSchema, skillIdSchema } from "./schema.js";

export type AiChatParams = z.infer<typeof aiChatParamsSchema>;

export type AdditionalContextItem = z.infer<typeof additionalContextItemSchema>;

export type ClientRequest = z.infer<typeof clientRequestSchema>;

export type PromptId = z.infer<typeof promptIdSchema>;

export type SkillId = z.infer<typeof skillIdSchema>;

export type ProviderId = "deepseek" | "moonshot";

export type ChatMessage = {
	role: "system" | "user" | "assistant";
	content: string;
	requestId?: string | undefined;
	createdAt?: string | undefined;
	additionalContext?: AdditionalContextItem[] | undefined;
};

export type ServerResponse =
	| {
		type: "response";
		id: string;
		ok: true;
		result: unknown;
	}
	| {
		type: "response";
		id: string;
		ok: false;
		error: {
			code: string;
			message: string;
		};
	};

export type ServerEvent = {
	type: "event";
	id: string;
	event:
		| "agent.run.started"
		| "agent.run.snapshot"
		| "agent.step.started"
		| "agent.step.outcome"
		| "agent.message.delta"
		| "agent.message.done"
		| "agent.thinking.delta"
		| "agent.thinking.done"
		| "agent.tool.call"
		| "agent.tool.result"
		| "agent.tool.error"
		| "agent.tool.approval_required"
		| "agent.tool.approved"
		| "agent.tool.rejected"
		| "agent.run.paused"
		| "agent.run.done"
		| "agent.run.error"
		| "agent.run.cancelled"
		| "ai.delta"
		| "ai.done"
		| "ai.status"
		| "ai.paused"
		| "ai.cancelled"
		| "ai.thinking.delta"
		| "ai.thinking.done"
		| "tool.call"
		| "tool.result"
		| "tool.error"
		| "tool.approval_required"
		| "tool.approved"
		| "tool.rejected"
		| "guide.added"
		| "guide.updated"
		| "guide.deleted"
		| "guide.applied"
		| "session.renamed"
		| "editor.tool.requested"
		| "mcp.config.updated"
		| "workflow.started"
		| "workflow.phase.started"
		| "workflow.todo.updated"
		| "workflow.phase.outcome"
		| "workflow.phase.done"
		| "workflow.done"
		| "workflow.error";
	data?: unknown;
};

export type ModelProfile = {
	provider: ProviderId;
	model: string;
	contextWindowTokens: number;
	maxOutputTokens: number;
	defaultOutputReserveTokens: number;
	safetyMarginTokens: number;
};
