import WebSocket from "ws";
import type { ServerEvent, ServerResponse } from "../protocol/types.js";

export function sendJson(socket: WebSocket, message: ServerResponse | ServerEvent): void {
	if (socket.readyState === WebSocket.OPEN) {
		socket.send(JSON.stringify({ protocolVersion: 2, ...message }));
	}
}
