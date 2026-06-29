import WebSocket, { WebSocketServer } from "ws";
import { composeSystemPrompt, listPromptTemplates } from "../prompts/registry.js";
import { clientRequestSchema } from "../protocol/schema.js";
import type { AiChatParams, ChatMessage, ClientRequest, ModelProfile } from "../protocol/types.js";
import { runDeepSeekAgent, type DeepSeekAgentResult } from "../providers/deepseek-agent.js";
import type { OnToolEvent } from "../tools/tool-dispatcher.js";
import type { DeepSeekChatOptions } from "../providers/deepseek-client.js";
import { McpHost } from "../mcp/mcp-host.js";
import { sendJson } from "./send-json.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getDefaultModelProfile, resolveModelProfile } from "../tokens/model-profiles.js";
import { type TokenCounter } from "../tokens/token-counter.js";
import { createTokenCounter } from "../tokens/token-counter-factory.js";
import { computeInputBudget, selectMessagesWithinBudget } from "../session/session-compressor.js";
import { ApprovalGateway } from "../tools/approval-gateway.js";
import { composeSkillPrompt, getSkill, isSkillId, listSkills } from "../skills/registry.js";
import type { SkillId } from "../skills/registry.js";
import { loadWorkspaces, findWorkspace, getDefaultWorkspace } from "../workspace/registry.js";
import type { WorkspaceConfig } from "../workspace/types.js";
import {
	createSession, openSession, saveSession, listSessions,
	deleteSession, renameSession, type SessionMetadata
} from "../session/session-store.js";

const tokenCounterPromise: Promise<TokenCounter> = createTokenCounter();

async function getTokenCounter(): Promise<TokenCounter> {
	return tokenCounterPromise;
}

type ClientSession = {
	deepseekApiKey?: string | undefined;
	deepseekModel?: string | undefined;
	deepseekBaseUrl?: string | undefined;
	godotExecutablePath?: string | undefined;
	godotProjectPath?: string | undefined;
	messages: ChatMessage[];
	modelProfile: ModelProfile;
	approvalGateway: ApprovalGateway;
	activeSkillId?: SkillId | undefined;
	activeWorkspace?: WorkspaceConfig | undefined;
	sessionId?: string | undefined;
	sessionTitle?: string | undefined;
};

type SlashCommandResult =
	| { type: "handled" }
	| { type: "ai"; params: AiChatParams }
	| { type: "none" };

function parseMessage(data: WebSocket.RawData, isBinary: boolean): unknown {
	if (isBinary) {
		throw new Error("Binary messages are not supported");
	}

	const text: string = typeof data === "string" ? data : data.toString("utf8");
	return JSON.parse(text) as unknown;
}

async function estimateTextTokens(text: string): Promise<number> {
	const tc: TokenCounter = await getTokenCounter();
	return tc.countText(text);
}

async function selectHistoryWithinBudget(messages: ChatMessage[], budgetTokens: number): Promise<ChatMessage[]> {
	const tc: TokenCounter = await getTokenCounter();
	return selectMessagesWithinBudget(messages, budgetTokens, tc);
}

async function computeHistoryBudget(
	profile: ModelProfile,
	params: AiChatParams,
	systemPrompt: string,
	mcpContext: string
): Promise<number> {
	const tc: TokenCounter = await getTokenCounter();
	const outputReserveTokens: number = params.options?.maxTokens ?? profile.defaultOutputReserveTokens;
	const systemPromptTokens: number = await tc.countText(systemPrompt);
	const mcpContextTokens: number = await tc.countText(mcpContext);
	const currentMessageTokens: number = await tc.countText(params.message);

	return computeInputBudget({
		profile,
		outputReserveTokens,
		systemPromptTokens,
		mcpContextTokens,
		toolDefinitionsTokens: 0,
		currentMessageTokens,
		tokenCounter: tc
	});
}

async function appendChatTurnToSession(
	session: ClientSession,
	history: ChatMessage[],
	userMessage: string,
	assistantMessage: string
): Promise<void> {
	const tc: TokenCounter = await getTokenCounter();
	const nextMessages: ChatMessage[] = [
		...history,
		{ role: "user", content: userMessage },
		{ role: "assistant", content: assistantMessage }
	];
	const profile: ModelProfile = session.modelProfile;
	const budgetTokens: number = profile.contextWindowTokens - profile.defaultOutputReserveTokens - profile.safetyMarginTokens;
	session.messages = await selectMessagesWithinBudget(nextMessages, Math.max(0, budgetTokens), tc);
}

function getSessionProjectPath(session: ClientSession): string {
	return session.activeWorkspace?.rootPath ?? session.godotProjectPath ?? process.env.GODOT_PROJECT_PATH ?? "";
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

function canCallMcpToolDirectly(toolName: string): boolean {
	const allowedTools: Set<string> = new Set([
		"get_project_summary",
		"list_project_files",
		"list_scenes",
		"list_scripts",
		"read_text_file",
		"search_text",
		"propose_create_text_file"
	]);

	return allowedTools.has(toolName);
}

function createSessionInfoResult(session: ClientSession, mcpHost: McpHost): Record<string, unknown> {
	return {
		providerConfigured: session.deepseekApiKey !== undefined,
		model: session.deepseekModel ?? session.modelProfile.model,
		historyMessagesStored: session.messages.length,
		contextWindowTokens: session.modelProfile.contextWindowTokens,
		maxOutputTokens: session.modelProfile.maxOutputTokens,
		defaultOutputReserveTokens: session.modelProfile.defaultOutputReserveTokens,
		safetyMarginTokens: session.modelProfile.safetyMarginTokens,
		approvalMode: session.approvalGateway.getMode(),
		pendingApprovals: session.approvalGateway.listPending().length,
		mcpServers: mcpHost.getConnectedServerIds(),
		godotExecutablePath: session.activeWorkspace?.godotExecutablePath ?? session.godotExecutablePath ?? null,
		godotProjectPath: getSessionProjectPath(session) || null,
		activeWorkspace: session.activeWorkspace ? {
			id: session.activeWorkspace.id,
			name: session.activeWorkspace.name,
			kind: session.activeWorkspace.kind,
			rootPath: session.activeWorkspace.rootPath,
			godotExecutablePath: session.activeWorkspace.godotExecutablePath ?? null
		} : null,
		activeSkillId: session.activeSkillId ?? null
	};
}

function formatSessionInfo(session: ClientSession, mcpHost: McpHost): string {
	const info = createSessionInfoResult(session, mcpHost);
	return [
		"## 当前上下文",
		`- Provider configured: ${String(info.providerConfigured)}`,
		`- Model: ${String(info.model)}`,
		`- Active skill: ${String(info.activeSkillId ?? "none")}`,
		`- History messages: ${String(info.historyMessagesStored)}`,
		`- Context window: ${String(info.contextWindowTokens)} tokens`,
		`- Default output reserve: ${String(info.defaultOutputReserveTokens)} tokens`,
		`- Safety margin: ${String(info.safetyMarginTokens)} tokens`,
		`- Approval mode: ${String(info.approvalMode)}`,
		`- Pending approvals: ${String(info.pendingApprovals)}`,
		`- MCP servers: ${JSON.stringify(info.mcpServers)}`,
		`- Godot project: ${String(info.godotProjectPath ?? "")}`
	].join("\n");
}

function formatPendingApprovals(session: ClientSession): string {
	const pending = session.approvalGateway.listPending();
	if (pending.length === 0) {
		return "当前没有待审批工具调用。";
	}

	return [
		"## 待审批工具调用",
		...pending.map((approval): string => [
			`- ${approval.approvalId}`,
			`  - Tool: ${approval.llmToolName}`,
			`  - Reason: ${approval.reason}`,
			`  - Args: \`${JSON.stringify(approval.args)}\``
		].join("\n"))
	].join("\n");
}

function formatSkillList(): string {
	return [
		"## 可用 Skills",
		...listSkills().map((skill): string => `- \`${skill.id}\`：${skill.name} - ${skill.description}`)
	].join("\n");
}

function createSlashHelpText(): string {
	return [
		"## 可用指令",
		"- `/help`：显示指令帮助。",
		"- `/context`：显示当前模型、上下文窗口、MCP 和审批信息。",
		"- `/approvals`：显示待审批工具调用。",
		"- `/skills`：列出可用 skills。",
		"- `/skill <skillId>`：激活会话默认 skill，例如 `/skill gdscript.review`。",
		"- `/skill off`：关闭会话默认 skill。",
		"- `/reset`：清空当前会话历史。",
		"- `/init`：检查当前 Godot 项目，并请求生成项目根目录 `AGENTS.md`。"
	].join("\n");
}

function sendChatText(socket: WebSocket, request: ClientRequest, text: string, session: ClientSession, mcpHost: McpHost): void {
	if (request.method !== "ai.chat" || request.params.options?.stream !== true) {
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: {
				text,
				context: createSessionInfoResult(session, mcpHost)
			}
		});
		return;
	}

	for (let index: number = 0; index < text.length; index += 1) {
		sendJson(socket, {
			type: "event",
			id: request.id,
			event: "ai.delta",
			data: { text: text[index] }
		});
	}

	sendJson(socket, {
		type: "event",
		id: request.id,
		event: "ai.done",
		data: {
			text,
			context: createSessionInfoResult(session, mcpHost)
		}
	});
}

async function handleSlashCommand(
	socket: WebSocket,
	request: ClientRequest,
	session: ClientSession,
	mcpHost: McpHost
): Promise<SlashCommandResult> {
	if (request.method !== "ai.chat") {
		return { type: "none" };
	}

	const inputText: string = request.params.message.trim();
	if (!inputText.startsWith("/")) {
		return { type: "none" };
	}

	const [rawCommand = "", ...restParts] = inputText.split(/\s+/);
	const command: string = rawCommand.toLowerCase();
	const restText: string = restParts.join(" ").trim();

	if (command === "/help") {
		sendChatText(socket, request, createSlashHelpText(), session, mcpHost);
		return { type: "handled" };
	}

	if (command === "/context") {
		sendChatText(socket, request, formatSessionInfo(session, mcpHost), session, mcpHost);
		return { type: "handled" };
	}

	if (command === "/approvals") {
		sendChatText(socket, request, formatPendingApprovals(session), session, mcpHost);
		return { type: "handled" };
	}

	if (command === "/skills") {
		sendChatText(socket, request, formatSkillList(), session, mcpHost);
		return { type: "handled" };
	}

	if (command === "/skill") {
		if (restText.length === 0) {
			const activeText: string = session.activeSkillId ?? "none";
			sendChatText(socket, request, `当前激活 skill：\`${activeText}\`\n\n${formatSkillList()}`, session, mcpHost);
			return { type: "handled" };
		}

		if (restText === "off" || restText === "none") {
			session.activeSkillId = undefined;
			sendChatText(socket, request, "已关闭会话默认 skill。", session, mcpHost);
			return { type: "handled" };
		}

		if (!isSkillId(restText)) {
			sendChatText(socket, request, `未知 skill：\`${restText}\`\n\n${formatSkillList()}`, session, mcpHost);
			return { type: "handled" };
		}

		session.activeSkillId = restText;
		const skill = getSkill(restText);
		sendChatText(socket, request, `已激活 skill：\`${skill.id}\` - ${skill.name}`, session, mcpHost);
		return { type: "handled" };
	}

	if (command === "/reset") {
		session.messages = [];
		sendChatText(socket, request, "已清空当前会话历史。", session, mcpHost);
		return { type: "handled" };
	}

	if (command === "/init") {
		session.messages = [];
		const extraInstruction: string = restText.length > 0
			? `\n\n用户补充要求：${restText}`
			: "";

		return {
			type: "ai",
			params: {
				...request.params,
				promptId: "godot.assistant",
				skillId: "godot.project_init",
				message: [
					"请初始化当前 Godot 项目的 AI 协作上下文。",
					"请通过 MCP 工具检查项目摘要、场景、脚本、插件和关键配置。",
					"请生成适合项目根目录的 AGENTS.md 内容，并调用文件创建工具请求创建 `AGENTS.md`。",
					"如果 `AGENTS.md` 已存在，请读取并总结现有内容，不要覆盖；说明是否建议更新。",
					"文件创建工具需要用户审批时，请明确告知审批 ID 和用户需要在 Godot 客户端 Approvals 区域批准。"
				].join("\n") + extraInstruction
			}
		};
	}

	sendChatText(socket, request, `未知指令：\`${command}\`\n\n${createSlashHelpText()}`, session, mcpHost);
	return { type: "handled" };
}

async function createMcpSystemContext(mcpHost: McpHost, session: ClientSession): Promise<string> {
	const serverIds: string[] = mcpHost.getConnectedServerIds();
	const sections: string[] = [];

	// Godot environment section
	if (session.godotExecutablePath || session.godotProjectPath || session.activeWorkspace) {
		sections.push("## Godot 开发环境");

		if (session.activeWorkspace) {
			sections.push(`- 当前工作区：\`${session.activeWorkspace.name}\`（ID: \`${session.activeWorkspace.id}\`）`);
			sections.push(`- 项目根路径：\`${session.activeWorkspace.rootPath}\``);

			if (session.activeWorkspace.godotExecutablePath) {
				sections.push(`- Godot 可执行文件：\`${session.activeWorkspace.godotExecutablePath}\``);
			}
		} else {
			sections.push("当前连接的 Godot 客户端提供以下环境信息。你可以基于这些路径建议用户执行具体命令。");

			if (session.godotExecutablePath) {
				sections.push(`- Godot 可执行文件：\`${session.godotExecutablePath}\``);
			}

			if (session.godotProjectPath) {
				sections.push(`- Godot 项目路径：\`${session.godotProjectPath}\``);
			}
		}

		const effectiveGodotPath: string | undefined = session.activeWorkspace?.godotExecutablePath ?? session.godotExecutablePath;

		if (effectiveGodotPath) {
			sections.push(`- 语法检查命令：\`"${effectiveGodotPath}" --headless --path "项目路径" --check-only --quit\``);
			sections.push(`- 无头运行命令：\`"${effectiveGodotPath}" --headless --path "项目路径" --quit\``);
		}

		sections.push("");
	}

	// Project instruction files (AGENTS.md / CLAUDE.md)
	for (const serverId of serverIds) {
		for (const fileName of ["AGENTS.md", "CLAUDE.md"]) {
			try {
				const result = await mcpHost.callTool(serverId, "read_text_file", { relativePath: fileName });
				const firstContent = (result as { content: Array<{ text?: string }> }).content[0];
				if (firstContent && firstContent.text) {
					sections.push("## 项目指令文件");
					sections.push(`以下内容来自项目根目录的 \`${fileName}\`，是可信的项目级规范。其中规则优先于本提示词的默认规范：`);
					sections.push("");
					sections.push(firstContent.text);
					sections.push("");
				}
				break; // Only read the first one found
			} catch {
				// File not found — skip
			}
		}
	}

	// MCP context section
	if (serverIds.length === 0) {
		sections.push("## MCP 工具上下文");
		sections.push("当前后端没有连接任何 MCP server。");
	} else {
		sections.push("## MCP 工具上下文");
		sections.push("当前 TypeScript 后端已经连接以下 MCP server。你不能直接连接 MCP server；所有 MCP 数据都由后端读取后注入到本系统提示词中。回答时可以基于这些已注入的 MCP 上下文说明当前可见能力。");

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
				try {
					session.modelProfile = resolveModelProfile(request.params.model);
				} catch (error: unknown) {
					sendJson(socket, {
						type: "response",
						id: request.id,
						ok: false,
						error: {
							code: "invalid_model",
							message: error instanceof Error ? error.message : "Unknown model"
						}
					});
					break;
				}
			}

			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					provider: request.params.provider,
					configured: true,
					model: session.deepseekModel ?? session.modelProfile.model,
					modelProfile: session.modelProfile
				}
			});
			break;

		case "ai.chat": {
			const slashCommandResult: SlashCommandResult = await handleSlashCommand(socket, request, session, mcpHost);
			if (slashCommandResult.type === "handled") {
				break;
			}

			const params: AiChatParams = slashCommandResult.type === "ai"
				? slashCommandResult.params
				: request.params;
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
				const activeSkillId: SkillId | undefined = params.skillId ?? session.activeSkillId;
				const activeSkill = activeSkillId !== undefined ? getSkill(activeSkillId) : undefined;
				const allowedToolNames: readonly string[] | undefined = activeSkill?.allowedTools;
				const promptId = params.promptId ?? (activeSkillId !== undefined ? getSkill(activeSkillId).defaultPromptId : undefined);
				const systemPrompt: string = await composeSystemPrompt(
					promptId,
					params.systemPrompt
				);
				const skillPrompt: string = await composeSkillPrompt(activeSkillId);
				const mcpSystemContext: string = await createMcpSystemContext(mcpHost, session);
				const fullSystemPrompt: string = systemPrompt
					+ (skillPrompt.length > 0 ? `\n\n${skillPrompt}` : "")
					+ mcpSystemContext;
				const historyBudgetTokens: number = await computeHistoryBudget(
					session.modelProfile,
					params,
					systemPrompt,
					skillPrompt + mcpSystemContext
				);
				const history: ChatMessage[] = await selectHistoryWithinBudget(session.messages, historyBudgetTokens);

				const onToolEvent: OnToolEvent = (event): void => {
					sendJson(socket, {
						type: "event",
						id: request.id,
						event: event.type,
						data: event
					});
				};

				if (params.options?.stream === true) {
					const agentResult: DeepSeekAgentResult = await runDeepSeekAgent(params, options, history, fullSystemPrompt, mcpHost, session.approvalGateway, allowedToolNames, onToolEvent);

					if (agentResult.status === "approval_required") {
						sendJson(socket, {
							type: "event",
							id: request.id,
							event: "ai.paused",
							data: {
								reason: "approval_required",
								approvalId: agentResult.approvalId,
								toolName: agentResult.toolName,
								message: `工具 ${agentResult.toolName} 需要审批：${agentResult.approvalId}`
							}
						});
						break;
					}

					const text: string = agentResult.text;

					for (let index: number = 0; index < text.length; index += 1) {
						sendJson(socket, {
							type: "event",
							id: request.id,
							event: "ai.delta",
							data: { text: text[index] }
						});
					}

					await appendChatTurnToSession(session, history, params.message, text);
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
					const agentResult: DeepSeekAgentResult = await runDeepSeekAgent(params, options, history, fullSystemPrompt, mcpHost, session.approvalGateway, allowedToolNames, onToolEvent);

					if (agentResult.status === "approval_required") {
						sendJson(socket, {
							type: "response",
							id: request.id,
							ok: true,
							result: {
								paused: true,
								reason: "approval_required",
								approvalId: agentResult.approvalId,
								toolName: agentResult.toolName,
								message: `工具 ${agentResult.toolName} 需要审批：${agentResult.approvalId}`
							}
						});
						break;
					}

					const text: string = agentResult.text;
					await appendChatTurnToSession(session, history, params.message, text);

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

		case "skill.list":
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					skills: listSkills(),
					activeSkillId: session.activeSkillId ?? null
				}
			});
			break;

		case "skill.activate":
			session.activeSkillId = request.params.skillId ?? undefined;
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					activeSkillId: session.activeSkillId ?? null
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
				result: createSessionInfoResult(session, mcpHost)
			});
			break;

		case "session.create": {
			const metadata: SessionMetadata = await createSession(
				request.params.title,
				request.params.workspaceId,
				request.params.skillId
			);
			session.sessionId = metadata.id;
			session.sessionTitle = metadata.title;
			if (request.params.workspaceId) {
				const ws: WorkspaceConfig | undefined = findWorkspace(request.params.workspaceId);
				if (ws) {
					session.activeWorkspace = ws;
					session.godotProjectPath = ws.rootPath;
				}
			}
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: metadata
			});
			break;
		}

		case "session.open": {
			try {
				const stored = await openSession(request.params.sessionId);
				session.sessionId = stored.metadata.id;
				session.sessionTitle = stored.metadata.title;
				session.messages = stored.messages.map((m) => ({ role: m.role, content: m.content }));

				if (stored.metadata.workspaceId) {
					const ws: WorkspaceConfig | undefined = findWorkspace(stored.metadata.workspaceId);
					if (ws) {
						session.activeWorkspace = ws;
						session.godotProjectPath = ws.rootPath;
					}
				}

				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result: {
						opened: true,
						metadata: stored.metadata,
						messageCount: stored.messages.length
					}
				});
			} catch (error: unknown) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "session_not_found",
						message: error instanceof Error ? error.message : "Session not found"
					}
				});
			}
			break;
		}

		case "session.list":
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: { sessions: await listSessions() }
			});
			break;

		case "session.save":
			if (!session.sessionId) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "no_session", message: "No active session to save. Create one first with session.create." }
				});
				break;
			}
			await saveSession(session.sessionId, session.messages, {
				workspaceId: session.activeWorkspace?.id,
				activeSkillId: session.activeSkillId
			});
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: { saved: true, sessionId: session.sessionId, messageCount: session.messages.length }
			});
			break;

		case "session.delete":
			await deleteSession(request.params.sessionId);
			if (session.sessionId === request.params.sessionId) {
				session.sessionId = undefined;
				session.sessionTitle = undefined;
				session.messages = [];
			}
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: { deleted: true, sessionId: request.params.sessionId }
			});
			break;

		case "session.rename": {
			const metadata: SessionMetadata = await renameSession(request.params.sessionId, request.params.title);
			if (session.sessionId === request.params.sessionId) {
				session.sessionTitle = metadata.title;
			}
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: metadata
			});
			break;
		}

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
				if (!canCallMcpToolDirectly(request.params.name)) {
					sendJson(socket, {
						type: "response",
						id: request.id,
						ok: false,
						error: {
							code: "approval_required",
							message: `Direct MCP call is not allowed for tool: ${request.params.name}`
						}
					});
					break;
				}

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

		case "fileChange.create": {
			const projectPath: string = getSessionProjectPath(session);

			if (!projectPath) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "config_error",
						message: "No workspace selected and GODOT_PROJECT_PATH is not configured"
					}
				});
				break;
			}

			const cleanedPath: string = request.params.relativePath.trim().replaceAll("\\", "/");
			const resolvedPath: string = path.resolve(projectPath, cleanedPath);

			// Validate path safety
			let pathError: string | null = null;
			const relative: string = path.relative(projectPath, resolvedPath).replaceAll(path.sep, "/");

			if (!resolvedPath.startsWith(path.resolve(projectPath))) {
				pathError = "Path traversal denied";
			} else {
				const segments: string[] = relative.split("/");

				for (const segment of segments) {
					if (segment.startsWith(".")) {
						pathError = `Hidden directory not allowed: ${segment}`;
						break;
					}
				}
			}

			if (!pathError && (relative.startsWith(".godot/") || relative === ".godot" || relative.startsWith("addons/") || relative === "addons")) {
				pathError = `Writing to ${relative.split("/")[0]}/ is not allowed`;
			}

			const allowedExtensions: Set<string> = new Set([".gd", ".tres", ".json", ".md", ".txt"]);
			const ext: string = path.extname(resolvedPath);

			if (!pathError && !allowedExtensions.has(ext)) {
				pathError = `Extension not allowed: ${ext}. Allowed: ${Array.from(allowedExtensions).join(", ")}`;
			}

			if (pathError) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "invalid_path", message: pathError }
				});
				break;
			}

			try {
				await fs.access(resolvedPath);
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "file_exists", message: `File already exists: ${relative}` }
				});
				break;
			} catch {
				// File does not exist — proceed
			}

			try {
				await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
				await fs.writeFile(resolvedPath, request.params.content, "utf8");
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result: { created: true, path: relative }
				});
			} catch (error: unknown) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "write_error",
						message: error instanceof Error ? error.message : "Failed to write file"
					}
				});
			}
			break;
		}

		case "fileChange.overwrite": {
			const projectPath: string = getSessionProjectPath(session);

			if (!projectPath) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "config_error", message: "No workspace selected" }
				});
				break;
			}

			const cleanedPath: string = request.params.relativePath.trim().replaceAll("\\", "/");
			const resolvedPath: string = path.resolve(projectPath, cleanedPath);

			if (!resolvedPath.startsWith(path.resolve(projectPath))) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "invalid_path", message: "Path traversal denied" }
				});
				break;
			}

			const relative: string = path.relative(projectPath, resolvedPath).replaceAll(path.sep, "/");

			if (relative.startsWith(".godot/") || relative === ".godot") {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "invalid_path", message: "Cannot overwrite files in .godot/" }
				});
				break;
			}

			const allowedExtensions: Set<string> = new Set([".gd", ".tres", ".json", ".md", ".txt"]);
			const ext: string = path.extname(resolvedPath);

			if (!allowedExtensions.has(ext)) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "invalid_extension", message: `Extension not allowed: ${ext}` }
				});
				break;
			}

			try {
				await fs.access(resolvedPath);
			} catch {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "file_not_found", message: `File does not exist: ${relative}` }
				});
				break;
			}

			try {
				await fs.writeFile(resolvedPath, request.params.content, "utf8");
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result: { overwritten: true, path: relative }
				});
			} catch (error: unknown) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "write_error",
						message: error instanceof Error ? error.message : "Failed to overwrite file"
					}
				});
			}
			break;
		}

		case "fileChange.delete": {
			const projectPath: string = getSessionProjectPath(session);

			if (!projectPath) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "config_error", message: "No workspace selected" }
				});
				break;
			}

			const cleanedPath: string = request.params.relativePath.trim().replaceAll("\\", "/");
			const resolvedPath: string = path.resolve(projectPath, cleanedPath);

			if (!resolvedPath.startsWith(path.resolve(projectPath))) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "invalid_path", message: "Path traversal denied" }
				});
				break;
			}

			const relative: string = path.relative(projectPath, resolvedPath).replaceAll(path.sep, "/");

			if (relative.startsWith(".godot/") || relative === ".godot") {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "invalid_path", message: "Cannot delete files in .godot/" }
				});
				break;
			}

			try {
				const stat = await fs.stat(resolvedPath);
				if (!stat.isFile()) {
					sendJson(socket, {
						type: "response",
						id: request.id,
						ok: false,
						error: { code: "not_a_file", message: `Not a file: ${relative}` }
					});
					break;
				}
			} catch {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "file_not_found", message: `File does not exist: ${relative}` }
				});
				break;
			}

			try {
				await fs.unlink(resolvedPath);
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result: { deleted: true, path: relative }
				});
			} catch (error: unknown) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "delete_error",
						message: error instanceof Error ? error.message : "Failed to delete file"
					}
				});
			}
			break;
		}

		case "approval.list":
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					pending: session.approvalGateway.listPending(),
					mode: session.approvalGateway.getMode()
				}
			});
			break;

		case "approval.approve": {
			try {
				const result = await session.approvalGateway.approve(request.params.approvalId, mcpHost);
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result: { approved: true, approvalId: request.params.approvalId, result }
				});
				sendJson(socket, {
					type: "event",
					id: request.id,
					event: "tool.approved",
					data: { approvalId: request.params.approvalId }
				});
			} catch (error: unknown) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "approval_error",
						message: error instanceof Error ? error.message : "Approval failed"
					}
				});
			}
			break;
		}

		case "approval.reject": {
			try {
				const rejected = session.approvalGateway.reject(request.params.approvalId);
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result: { rejected: true, approvalId: request.params.approvalId, toolName: rejected.llmToolName }
				});
				sendJson(socket, {
					type: "event",
					id: request.id,
					event: "tool.rejected",
					data: { approvalId: request.params.approvalId, toolName: rejected.llmToolName }
				});
			} catch (error: unknown) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "approval_error",
						message: error instanceof Error ? error.message : "Rejection failed"
					}
				});
			}
			break;
		}

		case "environment.configure":
			if (request.params.godotExecutablePath !== undefined) {
				session.godotExecutablePath = request.params.godotExecutablePath;
			}

			if (request.params.godotProjectPath !== undefined) {
				session.godotProjectPath = request.params.godotProjectPath;
			}

			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					configured: true,
					godotExecutablePath: session.godotExecutablePath ?? null,
					godotProjectPath: session.godotProjectPath ?? null
				}
			});
			break;

		case "workspace.list":
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					workspaces: loadWorkspaces(),
					active: session.activeWorkspace?.id ?? null
				}
			});
			break;

		case "workspace.select": {
			const workspace: WorkspaceConfig | undefined = findWorkspace(request.params.workspaceId);

			if (!workspace) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "workspace_not_found",
						message: `Workspace not found: ${request.params.workspaceId}`
					}
				});
				break;
			}

			try {
				await mcpHost.switchWorkspace(workspace);
			} catch (error: unknown) {
				console.error("Failed to switch MCP workspace:", error);
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "workspace_switch_failed",
						message: error instanceof Error ? error.message : "Failed to switch MCP workspace"
					}
				});
				break;
			}

			session.activeWorkspace = workspace;
			session.godotProjectPath = workspace.rootPath;

			if (workspace.godotExecutablePath) {
				session.godotExecutablePath = workspace.godotExecutablePath;
			}

			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					selected: true,
					workspace: {
						id: workspace.id,
						name: workspace.name,
						kind: workspace.kind,
						rootPath: workspace.rootPath
					}
				}
			});
			break;
		}

		case "workspace.info":
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: session.activeWorkspace ?? null
			});
			break;
	}
}

export function createServer(port: number, mcpHost: McpHost): WebSocketServer {
	const server: WebSocketServer = new WebSocketServer({ port });

	server.on("connection", (socket: WebSocket, request): void => {
		const session: ClientSession = {
			messages: [],
			modelProfile: getDefaultModelProfile(),
			approvalGateway: new ApprovalGateway(),
			activeWorkspace: getDefaultWorkspace()
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
			if (session.sessionId && session.messages.length > 0) {
				saveSession(session.sessionId, session.messages, {
					workspaceId: session.activeWorkspace?.id,
					activeSkillId: session.activeSkillId
				}).catch((error: unknown): void => {
					console.error("Failed to auto-save session on disconnect:", error);
				});
			}
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
