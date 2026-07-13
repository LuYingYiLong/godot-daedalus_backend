import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { sendJson } from "../send-json.js";
import {
	applyWorkbenchPatch,
	emitWorkbenchUpdated,
	serializeWorkbench,
	type WorkbenchPatch
} from "../workbench.js";

function sendWorkbenchResult(socket: WebSocket, request: ClientRequest, session: ClientSession, changed: boolean = false): void {
	sendJson(socket, {
		type: "response",
		id: request.id,
		ok: true,
		result: {
			workbench: serializeWorkbench(session),
			changed
		}
	});
}

export function handleWorkbenchRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, _mcpHost: McpHost): void {
	switch (request.method) {
	case "session.workbench.get":
		sendWorkbenchResult(socket, request, session);
		break;

	case "session.workbench.patch": {
		const changed: boolean = applyWorkbenchPatch(session, request.params as WorkbenchPatch);
		if (changed) {
			emitWorkbenchUpdated(socket, request.id, session);
		}
		sendWorkbenchResult(socket, request, session, changed);
		break;
	}

		default:
			throw new Error(`Unsupported workbench method: ${request.method}`);
	}
}
