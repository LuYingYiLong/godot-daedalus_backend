import WebSocket, { WebSocketServer } from "ws";
import { composeSystemPrompt, listPromptTemplates } from "../prompts/registry.js";
import { clientRequestSchema } from "../protocol/schema.js";
import type { AiChatParams, ChatMessage, ClientRequest, ModelProfile } from "../protocol/types.js";
import { chatWithDeepSeek, streamChatWithDeepSeek } from "../providers/deepseek-client.js";
import type { DeepSeekChatOptions } from "../providers/deepseek-client.js";
import { McpHost } from "../mcp/mcp-host.js";
import { sendJson } from "./send-json.js";

const DEFAULT_HISTORY_BUDGET_TOKENS: number = 12000;
const DEFAULT_CONTEXT_WINDOW_TOKENS: number = 32000;
const DEFAULT_MAX_OUTPUT_TOKENS: number = 2048;

const DEFAULT_MODEL_PROFILE: ModelProfile = {
	provider: "deepseek",
	model: "deepseek-v4-flash",
	contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
	maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
	historyBudgetTokens: DEFAULT_HISTORY_BUDGET_TOKENS
};

type ClientSession = {
	deepseekApiKey?: string | undefined;
	deepseekModel?: string | undefined;
	deepseekBaseUrl?: string | undefined;
	messages: ChatMessage[];
	modelProfile: ModelProfile;
};

function parseMessage(data: WebSocket.RawData, isBinary: boolean): unknown {
	if (isBinary) {
		throw new Error("Binary messages are not supported");
	}

	const text: string = typeof data === "string" ? data : data.toString("utf8");
	return JSON.parse(text) as unknown;
}

function estimateTextTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 3));
}

function estimateMessageTokens(message: ChatMessage): number {
	return estimateTextTokens(message.content) + 4;
}

function trimHistoryByTokenBudget(messages: ChatMessage[], maxTokens: number): ChatMessage[] {
	const keptMessages: ChatMessage[] = [];
	let usedTokens: number = 0;

	for (let index: number = messages.length - 1; index >= 0; index -= 1) {
		const message: ChatMessage | undefined = messages[index];
		if (message === undefined) {
			continue;
		}

		const messageTokens: number = estimateMessageTokens(message);
		if (usedTokens + messageTokens > maxTokens) {
			break;
		}

		keptMessages.unshift(message);
		usedTokens += messageTokens;
	}

	return keptMessages;
}

function getHistoryBudgetTokens(profile: ModelProfile, params: AiChatParams, systemPrompt: string): number {
	const requestedOutputTokens: number = params.options?.maxTokens ?? profile.maxOutputTokens;
	const availableTokens: number = profile.contextWindowTokens
		- requestedOutputTokens
		- estimateTextTokens(systemPrompt)
		- estimateTextTokens(params.message);

	return Math.max(0, Math.min(profile.historyBudgetTokens, availableTokens));
}

function appendChatTurnToSession(
	session: ClientSession,
	history: ChatMessage[],
	userMessage: string,
	assistantMessage: string
): void {
	const nextMessages: ChatMessage[] = [
		...history,
		{ role: "user", content: userMessage },
		{ role: "assistant", content: assistantMessage }
	];
	session.messages = trimHistoryByTokenBudget(nextMessages, session.modelProfile.historyBudgetTokens);
}

function createDeepSeekChatOptions(session: ClientSession, apiKey: string): DeepSeekChatOptions {
	const options: DeepSeekChatOptions = { apiKey };
	if (session.deepseekModel !== undefined) {
		options.model = session.deepseekModel;
	}
	if (session.deepseekBaseUrl !== undefined) {
		options.baseUrl = session.deepseekBaseUrl;
	}

	return options;
}

async function createMcpSystemContext(mcpHost: McpHost): Promise<string> {
	const serverIds: string[] = mcpHost.getConnectedServerIds();
	if (serverIds.length === 0) {
		return "\n\n## MCP 工具上下文\n\n当前后端没有连接任何 MCP server。";
	}

	const sections: string[] = [
		"## MCP 工具上下文",
		"当前 TypeScript 后端已经连接以下 MCP server。你不能直接连接 MCP server；所有 MCP 数据都由后端读取后注入到本系统提示词中。回答时可以基于这些已注入的 MCP 上下文说明当前可见能力。"
	];

	for (const serverId of serverIds) {
		sections.push(`\n### MCP Server: ${serverId}`);

		try {
			const toolsResult = await mcpHost.listTools(serverId);
			const toolLines: string[] = toolsResult.tools.map((tool) => {
				const description: string = tool.description ?? "";
				return `- ${tool.name}${description.length > 0 ? `：${description}` : ""}`;
			});
			sections.push("可用工具：");
			sections.push(toolLines.length > 0 ? toolLines.join("\n") : "- （无工具）");
		} catch (error: unknown) {
			const message: string = error instanceof Error ? error.message : "unknown error";
			sections.push(`工具列表读取失败：${message}`);
		}

		try {
			const resourcesResult = await mcpHost.listResources(serverId);
			const resourceLines: string[] = resourcesResult.resources.map((resource) => {
				const name: string = resource.name ?? resource.uri;
				return `- ${resource.uri}${name !== resource.uri ? `（${name}）` : ""}`;
			});
			sections.push("可用资源：");
			sections.push(resourceLines.length > 0 ? resourceLines.join("\n") : "- （无资源）");
		} catch (error: unknown) {
			const message: string = error instanceof Error ? error.message : "unknown error";
			sections.push(`资源列表读取失败：${message}`);
		}

		if (serverId === "godot") {
			try {
				const projectResource = await mcpHost.readResource(serverId, "godot://project");
				const projectContent = projectResource.contents[0];
				if (projectContent !== undefined && "text" in projectContent) {
					sections.push("当前 Godot 项目摘要：");
					sections.push("```json");
					sections.push(projectContent.text);
					sections.push("```");
				}
			} catch (error: unknown) {
				const message: string = error instanceof Error ? error.message : "unknown error";
				sections.push(`Godot 项目摘要读取失败：${message}`);
			}
		}
	}

	return `\n\n${sections.join("\n")}`;
}

async function handleRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, mcpHost: McpHost): Promise<void> {
	switch (request.method) {
		case "ping":
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: { message: "pong" }
			});
			break;

		case "provider.configure":
			session.deepseekApiKey = request.params.apiKey;
			session.deepseekModel = request.params.model;
			session.deepseekBaseUrl = request.params.baseUrl;
			if (request.params.model !== undefined) {
				session.modelProfile = {
					...session.modelProfile,
					model: request.params.model
				};
			}

			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					provider: request.params.provider,
					configured: true
				}
			});
			break;

		case "ai.chat": {
			const apiKey: string | undefined = session.deepseekApiKey;

			if (!apiKey) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "provider_not_configured",
						message: "DeepSeek API key is not configured. Send provider.configure first."
					}
				});
				break;
			}

			try {
				const options: DeepSeekChatOptions = createDeepSeekChatOptions(session, apiKey);
				const systemPrompt: string = await composeSystemPrompt(
					request.params.promptId,
					request.params.systemPrompt
				);
				const mcpSystemContext: string = await createMcpSystemContext(mcpHost);
				const fullSystemPrompt: string = systemPrompt + mcpSystemContext;
				const historyBudgetTokens: number = getHistoryBudgetTokens(
					session.modelProfile,
					request.params,
					fullSystemPrompt
				);
				const history: ChatMessage[] = trimHistoryByTokenBudget(session.messages, historyBudgetTokens);

				if (request.params.options?.stream === true) {
					let text: string = "";
					for await (const delta of streamChatWithDeepSeek(request.params, options, history, fullSystemPrompt)) {
						text += delta;
						sendJson(socket, {
							type: "event",
							id: request.id,
							event: "ai.delta",
							data: { text: delta }
						});
					}

					appendChatTurnToSession(session, history, request.params.message, text);
					sendJson(socket, {
						type: "event",
						id: request.id,
						event: "ai.done",
						data: {
							text,
							context: {
								historyMessagesUsed: history.length,
								historyMessagesStored: session.messages.length,
								historyBudgetTokens,
								mcpServers: mcpHost.getConnectedServerIds()
							}
						}
					});
				} else {
					const text: string = await chatWithDeepSeek(request.params, options, history, fullSystemPrompt);
					appendChatTurnToSession(session, history, request.params.message, text);

					sendJson(socket, {
						type: "response",
						id: request.id,
						ok: true,
						result: {
							text,
							context: {
								historyMessagesUsed: history.length,
								historyMessagesStored: session.messages.length,
								historyBudgetTokens,
								mcpServers: mcpHost.getConnectedServerIds()
							}
						}
					});
				}
			} catch (error: unknown) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "provider_error",
						message: error instanceof Error ? error.message : "DeepSeek API call failed"
					}
				});
			}
			break;
		}

		case "prompt.list":
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					prompts: listPromptTemplates()
				}
			});
			break;

		case "session.reset":
			session.messages = [];
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					reset: true,
					historyMessagesStored: session.messages.length
				}
			});
			break;

		case "session.info":
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					providerConfigured: session.deepseekApiKey !== undefined,
					model: session.deepseekModel ?? session.modelProfile.model,
					historyMessagesStored: session.messages.length,
					historyBudgetTokens: session.modelProfile.historyBudgetTokens,
					contextWindowTokens: session.modelProfile.contextWindowTokens,
					maxOutputTokens: session.modelProfile.maxOutputTokens
				}
			});
			break;

		case "mcp.listTools": {
			const serverId: string = request.params?.serverId ?? "godot";

			try {
				const result = await mcpHost.listTools(serverId);
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result
				});
			} catch (error: unknown) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "mcp_error",
						message: error instanceof Error ? error.message : "MCP call failed"
					}
				});
			}
			break;
		}

		case "mcp.callTool": {
			const serverId: string = request.params.serverId ?? "godot";

			try {
				const result = await mcpHost.callTool(serverId, request.params.name, request.params.args ?? {});
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result
				});
			} catch (error: unknown) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "mcp_error",
						message: error instanceof Error ? error.message : "MCP call failed"
					}
				});
			}
			break;
		}

		case "mcp.listResources": {
			const serverId: string = request.params?.serverId ?? "godot";

			try {
				const result = await mcpHost.listResources(serverId);
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result
				});
			} catch (error: unknown) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "mcp_error",
						message: error instanceof Error ? error.message : "MCP call failed"
					}
				});
			}
			break;
		}

		case "mcp.readResource": {
			const serverId: string = request.params.serverId ?? "godot";

			try {
				const result = await mcpHost.readResource(serverId, request.params.uri);
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result
				});
			} catch (error: unknown) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "mcp_error",
						message: error instanceof Error ? error.message : "MCP call failed"
					}
				});
			}
			break;
		}
	}
}

export function createServer(port: number, mcpHost: McpHost): WebSocketServer {
	const server: WebSocketServer = new WebSocketServer({ port });

	server.on("connection", (socket: WebSocket, request): void => {
		const session: ClientSession = {
			messages: [],
			modelProfile: { ...DEFAULT_MODEL_PROFILE }
		};
		const remoteAddress: string = request.socket.remoteAddress ?? "unknown";
		console.log(`Client connected: ${remoteAddress}`);

		socket.on("error", (error: Error): void => {
			console.error("WebSocket error:", error);
		});

		socket.on("message", (data: WebSocket.RawData, isBinary: boolean): void => {
			let parsedMessage: unknown;

			try {
				parsedMessage = parseMessage(data, isBinary);
			} catch (error: unknown) {
				sendJson(socket, {
					type: "response",
					id: "",
					ok: false,
					error: {
						code: "parse_error",
						message: error instanceof Error ? error.message : "Invalid message"
					}
				});
				return;
			}

			const validationResult = clientRequestSchema.safeParse(parsedMessage);

			if (!validationResult.success) {
				sendJson(socket, {
					type: "response",
					id: "",
					ok: false,
					error: {
						code: "invalid_request",
						message: validationResult.error.message
					}
				});
				return;
			}

			handleRequest(socket, validationResult.data, session, mcpHost).catch((error: unknown): void => {
				console.error("Unhandled request error:", error);
			});
		});

		socket.on("close", (): void => {
			console.log(`Client disconnected: ${remoteAddress}`);
		});
	});

	server.on("listening", (): void => {
		console.log(`WebSocket server listening on ws://localhost:${port}`);
	});

	server.on("error", (error: Error): void => {
		console.error("WebSocket server error:", error);
	});

	return server;
}
