import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ExternalMcpConfig, ExternalMcpToolName } from "./config.js";
import { getExternalMcpToolNames } from "./config.js";
import { getExternalMcpRpcClient, type ExternalMcpRpcClient } from "./rpc-client.js";
import { redactExternalMcpResult } from "./redaction.js";

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
};

function asJsonTextResult(value: unknown): ToolResult {
	return {
		content: [{
			type: "text",
			text: JSON.stringify(redactExternalMcpResult(value), null, 2)
		}]
	};
}

function asErrorResult(error: unknown): ToolResult {
	return {
		isError: true,
		content: [{
			type: "text",
			text: error instanceof Error ? error.message : String(error)
		}]
	};
}

async function runTool(action: () => Promise<unknown>): Promise<ToolResult> {
	try {
		return asJsonTextResult(await action());
	} catch (error: unknown) {
		return asErrorResult(error);
	}
}

function getClient(config: ExternalMcpConfig): ExternalMcpRpcClient {
	return getExternalMcpRpcClient(config);
}

function hasTool(tools: ReadonlySet<ExternalMcpToolName>, name: ExternalMcpToolName): boolean {
	return tools.has(name);
}

function createChatModeSchema(config: ExternalMcpConfig): z.ZodType<"agent" | "ask" | "plan" | undefined> {
	return config.mode === "full"
		? z.enum(["agent", "ask", "plan"]).optional()
		: z.enum(["ask", "plan"]).optional();
}

export function registerExternalMcpTools(server: McpServer, config: ExternalMcpConfig): void {
	const toolNames: ReadonlySet<ExternalMcpToolName> = new Set(getExternalMcpToolNames(config.mode));

	if (hasTool(toolNames, "daedalus_backend_health")) {
		server.registerTool("daedalus_backend_health", {
			title: "Daedalus backend health",
			description: "Read Daedalus backend health through the public WebSocket RPC boundary.",
			inputSchema: z.object({
				timeoutMs: z.number().int().positive().max(120000).optional()
			})
		}, async (input: { timeoutMs?: number | undefined }): Promise<ToolResult> => runTool(async (): Promise<unknown> => {
			const result = await getClient(config).sendRequest("backend.health", undefined, input.timeoutMs);
			return {
				backendUrl: config.backendUrl,
				mode: config.mode,
				health: result
			};
		}));
	}

	if (hasTool(toolNames, "daedalus_list_workspaces")) {
		server.registerTool("daedalus_list_workspaces", {
			title: "List Daedalus workspaces",
			description: "List configured workspaces and the active backend workspace.",
			inputSchema: z.object({})
		}, async (): Promise<ToolResult> => runTool(async (): Promise<unknown> =>
			getClient(config).sendRequest("workspace.list", {})
		));
	}

	if (hasTool(toolNames, "daedalus_select_workspace")) {
		server.registerTool("daedalus_select_workspace", {
			title: "Select Daedalus workspace",
			description: "Select the active backend workspace for subsequent session and runtime calls.",
			inputSchema: z.object({
				workspaceId: z.string().min(1)
			})
		}, async (input: { workspaceId: string }): Promise<ToolResult> => runTool(async (): Promise<unknown> =>
			getClient(config).sendRequest("workspace.select", input)
		));
	}

	if (hasTool(toolNames, "daedalus_create_session")) {
		server.registerTool("daedalus_create_session", {
			title: "Create Daedalus session",
			description: "Create a Daedalus backend session, optionally under a workspace.",
			inputSchema: z.object({
				title: z.string().min(1).max(200),
				workspaceId: z.string().min(1).optional(),
				provider: z.string().min(1).optional(),
				model: z.string().min(1).optional(),
				chatMode: z.enum(["agent", "ask", "plan"]).optional()
			})
		}, async (input: {
			title: string;
			workspaceId?: string | undefined;
			provider?: string | undefined;
			model?: string | undefined;
			chatMode?: "agent" | "ask" | "plan" | undefined;
		}): Promise<ToolResult> => runTool(async (): Promise<unknown> =>
			getClient(config).sendRequest("session.create", input)
		));
	}

	if (hasTool(toolNames, "daedalus_open_session")) {
		server.registerTool("daedalus_open_session", {
			title: "Open Daedalus session",
			description: "Open an existing Daedalus session and bind this MCP connection to it.",
			inputSchema: z.object({
				sessionId: z.string().min(1),
				limit: z.number().int().positive().max(500).optional()
			})
		}, async (input: { sessionId: string; limit?: number | undefined }): Promise<ToolResult> => runTool(async (): Promise<unknown> =>
			getClient(config).sendRequest("session.open", input)
		));
	}

	if (hasTool(toolNames, "daedalus_get_session_info")) {
		server.registerTool("daedalus_get_session_info", {
			title: "Get Daedalus session info",
			description: "Read provider, approval, workspace, editor and diagnostics runtime state.",
			inputSchema: z.object({
				sessionId: z.string().min(1).optional(),
				timeoutMs: z.number().int().positive().max(300000).optional()
			})
		}, async (input: { sessionId?: string | undefined; timeoutMs?: number | undefined }): Promise<ToolResult> => runTool(async (): Promise<unknown> => {
			const client: ExternalMcpRpcClient = getClient(config);
			if (input.sessionId !== undefined) {
				await client.sendRequest("session.open", { sessionId: input.sessionId, limit: 100 }, input.timeoutMs);
			}
			return client.sendRequest("session.info", {}, input.timeoutMs);
		}));
	}

	if (hasTool(toolNames, "daedalus_get_session_events")) {
		server.registerTool("daedalus_get_session_events", {
			title: "Get Daedalus session timeline",
			description: "Read a session timeline page.",
			inputSchema: z.object({
				sessionId: z.string().min(1),
				beforeOffset: z.number().int().min(0).optional(),
				limit: z.number().int().positive().max(500).optional()
			})
		}, async (input: { sessionId: string; beforeOffset?: number | undefined; limit?: number | undefined }): Promise<ToolResult> => runTool(async (): Promise<unknown> =>
			getClient(config).sendRequest("session.timeline", {
				sessionId: input.sessionId,
				...(input.beforeOffset === undefined ? {} : { beforeOffset: input.beforeOffset }),
				limit: input.limit
			})
		));
	}

	if (hasTool(toolNames, "daedalus_get_plan")) {
		server.registerTool("daedalus_get_plan", {
			title: "Get Daedalus plan",
			description: "Read persisted plan metadata and markdown by plan id.",
			inputSchema: z.object({
				sessionId: z.string().min(1).optional(),
				planId: z.string().min(1)
			})
		}, async (input: { sessionId?: string | undefined; planId: string }): Promise<ToolResult> => runTool(async (): Promise<unknown> =>
			getClient(config).sendRequest("plan.get", input)
		));
	}

	if (hasTool(toolNames, "daedalus_list_pending_approvals")) {
		server.registerTool("daedalus_list_pending_approvals", {
			title: "List pending approvals",
			description: "List current approval requests for the active Daedalus session.",
			inputSchema: z.object({})
		}, async (): Promise<ToolResult> => runTool(async (): Promise<unknown> =>
			getClient(config).sendRequest("approval.list", {})
		));
	}

	if (hasTool(toolNames, "daedalus_send_chat")) {
		server.registerTool("daedalus_send_chat", {
			title: "Send Daedalus chat",
			description: "Send ai.chat through Daedalus. Returns requestId immediately; use wait_for_event to observe progress.",
			inputSchema: z.object({
				sessionId: z.string().min(1).optional(),
				message: z.string().min(1),
				mode: createChatModeSchema(config),
				promptId: z.string().min(1).optional(),
				systemPrompt: z.string().optional(),
				additionalContext: z.array(z.unknown()).optional(),
				options: z.record(z.string(), z.unknown()).optional()
			})
		}, async (input: {
			sessionId?: string | undefined;
			message: string;
			mode?: "agent" | "ask" | "plan" | undefined;
			promptId?: string | undefined;
			systemPrompt?: string | undefined;
			additionalContext?: unknown[] | undefined;
			options?: Record<string, unknown> | undefined;
		}): Promise<ToolResult> => runTool(async (): Promise<unknown> => {
			if (config.mode !== "full" && input.mode === "agent") {
				throw new Error("agent chat is only available in full external MCP mode.");
			}
			const client: ExternalMcpRpcClient = getClient(config);
			if (input.sessionId !== undefined) {
				await client.sendRequest("session.open", { sessionId: input.sessionId, limit: 100 });
			}
			const { sessionId: _sessionId, ...chatParams } = input;
			const requestId: string = await client.sendRequestNoWait("ai.chat", {
				...chatParams,
				mode: chatParams.mode ?? "ask"
			});
			return { requestId };
		}));
	}

	if (hasTool(toolNames, "daedalus_wait_for_event")) {
		server.registerTool("daedalus_wait_for_event", {
			title: "Wait for Daedalus event",
			description: "Wait for a streamed backend event by event name, requestId, planId, or sequence cursor.",
			inputSchema: z.object({
				eventName: z.string().min(1).optional(),
				requestId: z.string().min(1).optional(),
				planId: z.string().min(1).optional(),
				afterSequence: z.number().int().min(0).optional(),
				timeoutMs: z.number().int().positive().max(300000).optional()
			})
		}, async (input: {
			eventName?: string | undefined;
			requestId?: string | undefined;
			planId?: string | undefined;
			afterSequence?: number | undefined;
			timeoutMs?: number | undefined;
		}): Promise<ToolResult> => runTool(async (): Promise<unknown> =>
			getClient(config).waitForEvent(input)
		));
	}

	if (hasTool(toolNames, "daedalus_submit_clarification")) {
		server.registerTool("daedalus_submit_clarification", {
			title: "Submit plan clarification",
			description: "Submit a clarification reply for a plan-mode request.",
			inputSchema: z.object({
				planId: z.string().min(1),
				reply: z.string().min(1).max(8000),
				timeoutMs: z.number().int().positive().max(300000).optional()
			})
		}, async (input: { planId: string; reply: string; timeoutMs?: number | undefined }): Promise<ToolResult> => runTool(async (): Promise<unknown> =>
			getClient(config).sendRequest("plan.clarify", {
				planId: input.planId,
				reply: input.reply
			}, input.timeoutMs)
		));
	}

	if (hasTool(toolNames, "daedalus_revise_plan")) {
		server.registerTool("daedalus_revise_plan", {
			title: "Revise Daedalus plan",
			description: "Send feedback to revise a ready plan without starting execution.",
			inputSchema: z.object({
				planId: z.string().min(1),
				feedback: z.string().min(1).max(12000),
				timeoutMs: z.number().int().positive().max(300000).optional()
			})
		}, async (input: { planId: string; feedback: string; timeoutMs?: number | undefined }): Promise<ToolResult> => runTool(async (): Promise<unknown> =>
			getClient(config).sendRequest("plan.revise", {
				planId: input.planId,
				feedback: input.feedback
			}, input.timeoutMs)
		));
	}

	if (hasTool(toolNames, "daedalus_list_runtime_tools")) {
		server.registerTool("daedalus_list_runtime_tools", {
			title: "List Daedalus runtime tools",
			description: "List low-level Daedalus LLM runtime tools allowed by the current external MCP mode.",
			inputSchema: z.object({})
		}, async (): Promise<ToolResult> => runTool(async (): Promise<unknown> =>
			getClient(config).sendRequest("tool.catalog.list", { mode: config.mode })
		));
	}

	if (hasTool(toolNames, "daedalus_call_runtime_tool")) {
		server.registerTool("daedalus_call_runtime_tool", {
			title: "Call Daedalus runtime tool",
			description: "Call one low-level Daedalus LLM runtime tool by canonical tool name through backend policy and approval.",
			inputSchema: z.object({
				sessionId: z.string().min(1).optional(),
				toolName: z.string().min(1),
				args: z.record(z.string(), z.unknown()).optional(),
				timeoutMs: z.number().int().positive().max(300000).optional()
			})
		}, async (input: {
			sessionId?: string | undefined;
			toolName: string;
			args?: Record<string, unknown> | undefined;
			timeoutMs?: number | undefined;
		}): Promise<ToolResult> => runTool(async (): Promise<unknown> => {
			const client: ExternalMcpRpcClient = getClient(config);
			if (input.sessionId !== undefined) {
				await client.sendRequest("session.open", { sessionId: input.sessionId, limit: 100 }, input.timeoutMs);
			}
			return client.sendRequest("tool.execute", {
				mode: config.mode,
				toolName: input.toolName,
				args: input.args ?? {}
			}, input.timeoutMs);
		}));
	}

	if (hasTool(toolNames, "daedalus_approve_plan")) {
		server.registerTool("daedalus_approve_plan", {
			title: "Approve Daedalus plan",
			description: "Approve a ready plan and start normal agent execution. Full external MCP mode only.",
			inputSchema: z.object({
				planId: z.string().min(1)
			})
		}, async (input: { planId: string }): Promise<ToolResult> => runTool(async (): Promise<unknown> =>
			getClient(config).sendRequest("plan.approve", input)
		));
	}

	if (hasTool(toolNames, "daedalus_approve_tool")) {
		server.registerTool("daedalus_approve_tool", {
			title: "Approve Daedalus tool",
			description: "Approve one pending tool request through the backend approval boundary. Full external MCP mode only.",
			inputSchema: z.object({
				approvalId: z.string().min(1)
			})
		}, async (input: { approvalId: string }): Promise<ToolResult> => runTool(async (): Promise<unknown> =>
			getClient(config).sendRequest("approval.approve", input)
		));
	}

	if (hasTool(toolNames, "daedalus_reject_tool")) {
		server.registerTool("daedalus_reject_tool", {
			title: "Reject Daedalus tool",
			description: "Reject one pending tool request. Full external MCP mode only.",
			inputSchema: z.object({
				approvalId: z.string().min(1)
			})
		}, async (input: { approvalId: string }): Promise<ToolResult> => runTool(async (): Promise<unknown> =>
			getClient(config).sendRequest("approval.reject", input)
		));
	}
}
