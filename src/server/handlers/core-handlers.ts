import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { sendJson } from "../send-json.js";
import { createBackendHealthResult } from "../backend-health.js";
import { createSlashCommandListResult } from "../slash-commands.js";
import { listPromptTemplates } from "../../prompts/registry.js";
import { listSkills, getSkill } from "../../skills/registry.js";

export async function handleCoreRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, mcpHost: McpHost): Promise<void> {
	switch (request.method) {
	case "ping":
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: { message: "pong" }
		});
		break;

	case "backend.health":
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: createBackendHealthResult()
		});
		break;

	case "command.list":
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: createSlashCommandListResult()
		});
		break;

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

		default:
			throw new Error(`Unsupported core method: ${request.method}`);
	}
}
