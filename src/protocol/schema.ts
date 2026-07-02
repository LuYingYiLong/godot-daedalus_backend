import { z } from "zod";

export const promptIdSchema = z.enum([
	"godot.assistant",
	"gdscript.reviewer",
	"scene.architect",
	"backend.helper"
]);

export const skillIdSchema = z.enum([
	"godot.project_init",
	"gdscript.review",
	"scene.builder",
	"file.creator",
	"backend.helper"
]);

export const aiChatParamsSchema = z.object({
	message: z.string(),
	promptId: promptIdSchema.optional(),
	skillId: skillIdSchema.optional(),
	systemPrompt: z.string().optional(),
	retryFromRequestId: z.string().min(1).optional(),
	options: z.object({
		temperature: z.number().min(0).max(2).optional(),
		topP: z.number().min(0).max(1).optional(),
		maxTokens: z.number().int().positive().optional(),
		stop: z.union([z.string(), z.array(z.string())]).optional(),
		responseFormat: z.union([z.literal("text"), z.literal("json")]).optional(),
		stream: z.boolean().optional(),
		toolBudget: z.enum(["simple", "normal", "codegen", "project_edit"]).optional(),
		workflow: z.enum(["auto", "single", "multi_phase", "llm_planned"]).optional(),
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
		method: z.literal("provider.config.get"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("provider.config.set"),
		params: z.object({
			provider: z.literal("deepseek"),
			apiKey: z.string().optional(),
			model: z.string().min(1).optional(),
			baseUrl: z.string().min(1).optional(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("provider.config.clear"),
		params: z.object({}).optional(),
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
		method: z.literal("ai.cancel"),
		params: z.object({
			requestId: z.string().min(1),
		}),
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
		method: z.literal("skill.list"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("skill.activate"),
		params: z.object({
			skillId: skillIdSchema.nullable(),
		}),
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
		method: z.literal("session.create"),
		params: z.object({
			title: z.string().min(1),
			workspaceId: z.string().optional(),
			skillId: skillIdSchema.optional(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.open"),
		params: z.object({
			sessionId: z.string().min(1),
			limit: z.number().int().positive().max(500).optional(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.timeline"),
		params: z.object({
			sessionId: z.string().min(1).optional(),
			beforeOffset: z.number().int().min(0),
			limit: z.number().int().positive().max(500).optional(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.list"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.archive"),
		params: z.object({
			sessionId: z.string().min(1),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.archived.list"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.archived.restore"),
		params: z.object({
			sessionId: z.string().min(1),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.archived.delete"),
		params: z.object({
			sessionId: z.string().min(1),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.save"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.delete"),
		params: z.object({
			sessionId: z.string().min(1),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.rename"),
		params: z.object({
			sessionId: z.string().min(1),
			title: z.string().min(1),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.compress"),
		params: z.object({
			keepRecent: z.number().int().min(2).max(50).optional(),
		}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("session.summary"),
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
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("fileChange.create"),
		params: z.object({
			relativePath: z.string().min(1),
			content: z.string(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("fileChange.overwrite"),
		params: z.object({
			relativePath: z.string().min(1),
			content: z.string(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("fileChange.delete"),
		params: z.object({
			relativePath: z.string().min(1),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("approval.list"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("approval.mode.set"),
		params: z.object({
			mode: z.enum(["manual", "auto-safe", "read-only"]),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("approval.approve"),
		params: z.object({
			approvalId: z.string().min(1),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("approval.reject"),
		params: z.object({
			approvalId: z.string().min(1),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("environment.configure"),
		params: z.object({
			godotExecutablePath: z.string().min(1).optional(),
			godotProjectPath: z.string().min(1).optional(),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("workspace.list"),
		params: z.object({}).optional(),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("workspace.select"),
		params: z.object({
			workspaceId: z.string().min(1),
		}),
	}),
	z.object({
		type: z.literal("request"),
		id: z.string(),
		method: z.literal("workspace.info"),
		params: z.object({}).optional(),
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
