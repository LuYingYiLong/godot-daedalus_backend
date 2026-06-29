import { z } from "zod";

export const clientRequestSchema = z.discriminatedUnion("method", [
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("ping"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("ai.chat"),
		params: z.object({
			message: z.string(),
		}),
	}),
]);

export const serverResponseSchema = z.discriminatedUnion("ok", [
	z.object({
		type: z.literal("response"),
		id: z.string(),
		ok: z.literal(true),
		result: z.unknown(),
	}),
	z.object({
		type: z.literal("response"),
		id: z.string(),
		ok: z.literal(false),
		error: z.object({
			code: z.string(),
			message: z.string(),
		}),
	}),
]);
