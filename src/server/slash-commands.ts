import type WebSocket from "ws";
import type { AiChatParams, ClientRequest } from "../protocol/types.js";
import { getSkill, isSkillId, listSkills } from "../skills/registry.js";
import type { McpHost } from "../mcp/mcp-host.js";
import type { ClientSession } from "./client-session.js";
import { sendJson } from "./send-json.js";

export type SlashCommandDefinition = {
	command: string;
	usage: string;
	insertText: string;
	description: string;
	requiresArgument: boolean;
	examples: string[];
};

export type SlashCommandResult =
	| { type: "handled" }
	| { type: "ai"; params: AiChatParams }
	| { type: "none" };

export type SessionInfoFactory = (session: ClientSession, mcpHost: McpHost) => Record<string, unknown>;

const SLASH_COMMANDS: readonly SlashCommandDefinition[] = [
	{
		command: "/help",
		usage: "/help",
		insertText: "/help",
		description: "显示指令帮助。",
		requiresArgument: false,
		examples: ["/help"]
	},
	{
		command: "/context",
		usage: "/context",
		insertText: "/context",
		description: "显示当前模型、上下文窗口、MCP 和审批信息。",
		requiresArgument: false,
		examples: ["/context"]
	},
	{
		command: "/approvals",
		usage: "/approvals",
		insertText: "/approvals",
		description: "显示待审批工具调用。",
		requiresArgument: false,
		examples: ["/approvals"]
	},
	{
		command: "/skills",
		usage: "/skills",
		insertText: "/skills",
		description: "列出可用 skills。",
		requiresArgument: false,
		examples: ["/skills"]
	},
	{
		command: "/skill",
		usage: "/skill <skillId|off>",
		insertText: "/skill ",
		description: "激活或关闭会话默认 skill。",
		requiresArgument: true,
		examples: ["/skill gdscript.review", "/skill off"]
	},
	{
		command: "/reset",
		usage: "/reset",
		insertText: "/reset",
		description: "清空当前会话历史。",
		requiresArgument: false,
		examples: ["/reset"]
	},
	{
		command: "/init",
		usage: "/init [补充要求]",
		insertText: "/init ",
		description: "检查当前 Godot 项目，并请求生成项目根目录 AGENTS.md。",
		requiresArgument: false,
		examples: ["/init", "/init 请保留现有项目约束"]
	}
] as const;

export function listSlashCommands(): SlashCommandDefinition[] {
	return SLASH_COMMANDS.map((command: SlashCommandDefinition): SlashCommandDefinition => ({
		...command,
		examples: [...command.examples]
	}));
}

export function createSlashCommandListResult(): { commands: SlashCommandDefinition[] } {
	return {
		commands: listSlashCommands()
	};
}

export function createSlashHelpText(): string {
	return [
		"## 可用指令",
		...SLASH_COMMANDS.map((command: SlashCommandDefinition): string => {
			return `- \`${command.usage}\`：${command.description}`;
		})
	].join("\n");
}

function formatSessionInfo(session: ClientSession, mcpHost: McpHost, createSessionInfo: SessionInfoFactory): string {
	const info: Record<string, unknown> = createSessionInfo(session, mcpHost);
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

function sendChatText(
	socket: WebSocket,
	request: ClientRequest,
	text: string,
	session: ClientSession,
	mcpHost: McpHost,
	createSessionInfo: SessionInfoFactory
): void {
	if (request.method !== "ai.chat" || request.params.options?.stream !== true) {
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: {
				text,
				context: createSessionInfo(session, mcpHost)
			}
		});
		return;
	}

	const runId: string = `slash-${request.id}`;
	sendJson(socket, {
		type: "event",
		id: request.id,
		event: "agent.run.started",
		data: {
			runId,
			requestId: request.id,
			title: "Slash command",
			source: "slash",
			steps: [{
				id: "answer",
				title: "回答命令",
				toolGroup: "answer",
				acceptanceCriteria: []
			}]
		}
	});

	for (let index: number = 0; index < text.length; index += 1) {
		sendJson(socket, {
			type: "event",
			id: request.id,
			event: "agent.message.delta",
			data: {
				runId,
				stepRunId: `${runId}-answer`,
				text: text[index]
			}
		});
	}

	sendJson(socket, {
		type: "event",
		id: request.id,
		event: "agent.message.done",
		data: {
			runId,
			stepRunId: `${runId}-answer`,
			text,
			context: createSessionInfo(session, mcpHost)
		}
	});
	sendJson(socket, {
		type: "event",
		id: request.id,
		event: "agent.run.done",
		data: {
			runId,
			title: "Slash command"
		}
	});
}

export async function handleSlashCommand(params: {
	socket: WebSocket;
	request: ClientRequest;
	session: ClientSession;
	mcpHost: McpHost;
	createSessionInfo: SessionInfoFactory;
}): Promise<SlashCommandResult> {
	const { socket, request, session, mcpHost, createSessionInfo } = params;
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
		sendChatText(socket, request, createSlashHelpText(), session, mcpHost, createSessionInfo);
		return { type: "handled" };
	}

	if (command === "/context") {
		sendChatText(socket, request, formatSessionInfo(session, mcpHost, createSessionInfo), session, mcpHost, createSessionInfo);
		return { type: "handled" };
	}

	if (command === "/approvals") {
		sendChatText(socket, request, formatPendingApprovals(session), session, mcpHost, createSessionInfo);
		return { type: "handled" };
	}

	if (command === "/skills") {
		sendChatText(socket, request, formatSkillList(), session, mcpHost, createSessionInfo);
		return { type: "handled" };
	}

	if (command === "/skill") {
		if (restText.length === 0) {
			const activeText: string = session.activeSkillId ?? "none";
			sendChatText(socket, request, `当前激活 skill：\`${activeText}\`\n\n${formatSkillList()}`, session, mcpHost, createSessionInfo);
			return { type: "handled" };
		}

		if (restText === "off" || restText === "none") {
			session.activeSkillId = undefined;
			sendChatText(socket, request, "已关闭会话默认 skill。", session, mcpHost, createSessionInfo);
			return { type: "handled" };
		}

		if (!isSkillId(restText)) {
			sendChatText(socket, request, `未知 skill：\`${restText}\`\n\n${formatSkillList()}`, session, mcpHost, createSessionInfo);
			return { type: "handled" };
		}

		session.activeSkillId = restText;
		const skill = getSkill(restText);
		sendChatText(socket, request, `已激活 skill：\`${skill.id}\` - ${skill.name}`, session, mcpHost, createSessionInfo);
		return { type: "handled" };
	}

	if (command === "/reset") {
		session.messages = [];
		session.fullSessionLoadPromise = undefined;
		sendChatText(socket, request, "已清空当前会话历史。", session, mcpHost, createSessionInfo);
		return { type: "handled" };
	}

	if (command === "/init") {
		session.messages = [];
		session.fullSessionLoadPromise = undefined;
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

	sendChatText(socket, request, `未知指令：\`${command}\`\n\n${createSlashHelpText()}`, session, mcpHost, createSessionInfo);
	return { type: "handled" };
}
