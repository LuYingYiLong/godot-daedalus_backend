import type WebSocket from "ws";
import type { ServerEvent } from "../protocol/types.js";
import { sendJson } from "./send-json.js";

export function sendOk(socket: WebSocket, id: string, result: unknown): void {
	sendJson(socket, {
		type: "response",
		id,
		ok: true,
		result
	});
}

export function sendError(socket: WebSocket, id: string, code: string, message: string): void {
	sendJson(socket, {
		type: "response",
		id,
		ok: false,
		error: {
			code,
			message
		}
	});
}

export function sendEvent(socket: WebSocket, id: string, event: ServerEvent["event"], data: unknown): void {
	sendJson(socket, {
		type: "event",
		id,
		event,
		data
	});
}
