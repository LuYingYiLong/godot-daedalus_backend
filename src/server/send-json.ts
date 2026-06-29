import WebSocket from "ws";
import type { ServerResponse } from "../protocol/types.js";

export function sendJson(socket: WebSocket, message: ServerResponse): void {
	if (socket.readyState === WebSocket.OPEN) {
		socket.send(JSON.stringify(message));
	}
}
