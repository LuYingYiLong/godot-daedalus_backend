import { z } from "zod";

export const promptIdSchema = z.enum([
	"godot.assistant",
	"gdscript.reviewer",
	"scene.architect",
	"backend.helper"
]);

export const aiChatParamsSchema = z.object({
	message: z.string(),
	promptId: promptIdSchema.optional(),
	systemPrompt: z.string().optional(),
	options: z.object({
		temperature: z.number().min(0).max(2).optional(),
		topP: z.number().min(0).max(1).optional(),
		maxTokens: z.number().int().positive().optional(),
		stop: z.union([z.string(), z.array(z.string())]).optional(),
		responseFormat: z.union([z.literal("text"), z.literal("json")]).optional(),
		stream: z.boolean().optional(),
	}).optional()
});

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
		method: z.literal("provider.configure"),
		params: z.object({
			provider: z.literal("deepseek"),
			apiKey: z.string().min(1),
			model: z.string().min(1).optional(),
			baseUrl: z.string().min(1).optional(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("ai.chat"),
		params: aiChatParamsSchema,
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("prompt.list"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.reset"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.info"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("mcp.listTools"),
		params: z.object({
			serverId: z.string().optional(),
		}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("mcp.callTool"),
		params: z.object({
			serverId: z.string().optional(),
			name: z.string(),
			args: z.record(z.string(), z.unknown()).optional(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("mcp.listResources"),
		params: z.object({
			serverId: z.string().optional(),
		}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("mcp.readResource"),
		params: z.object({
			serverId: z.string().optional(),
			uri: z.string(),
		}),
	})
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
