import type { z } from "zod";
import type { aiChatParamsSchema, clientRequestSchema } from "./schema.js";

export type AiChatParams = z.infer<typeof aiChatParamsSchema>;

export type ClientRequest = z.infer<typeof clientRequestSchema>;

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
	event: "ai.delta" | "ai.done";
	data?: unknown;
};

