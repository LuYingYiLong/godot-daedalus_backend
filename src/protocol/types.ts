import type { z } from "zod";
import type { aiChatParamsSchema, clientRequestSchema, promptIdSchema, skillIdSchema } from "./schema.js";

export type AiChatParams = z.infer<typeof aiChatParamsSchema>;

export type ClientRequest = z.infer<typeof clientRequestSchema>;

export type PromptId = z.infer<typeof promptIdSchema>;

export type SkillId = z.infer<typeof skillIdSchema>;

export type ChatMessage = {
	role: "system" | "user" | "assistant";
	content: string;
	requestId?: string | undefined;
	createdAt?: string | undefined;
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
		| "ai.delta"
		| "ai.done"
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
		| "workflow.started"
		| "workflow.phase.started"
		| "workflow.todo.updated"
		| "workflow.phase.done"
		| "workflow.done"
		| "workflow.error";
	data?: unknown;
};

export type ModelProfile = {
	provider: "deepseek";
	model: string;
	contextWindowTokens: number;
	maxOutputTokens: number;
	defaultOutputReserveTokens: number;
	safetyMarginTokens: number;
};
