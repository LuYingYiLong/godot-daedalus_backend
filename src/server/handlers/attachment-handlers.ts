import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { sendJson } from "../send-json.js";
import { readGeneratedImageDataUrl, saveImageAttachment } from "../../session/session-attachments.js";

export async function handleAttachmentRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, _mcpHost: McpHost): Promise<void> {
	switch (request.method) {
		case "attachment.image.save": {
			if (session.sessionId === undefined || session.sessionId !== request.params.sessionId) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "session_mismatch",
						message: "Image attachments can only be saved for the active session."
					}
				});
				return;
			}

			try {
				const context = await saveImageAttachment(request.params);
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result: {
						attachment: context
					}
				});
			} catch (error: unknown) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "attachment_image_save_failed",
						message: error instanceof Error ? error.message : "Failed to save image attachment"
					}
				});
			}
			return;
		}

		case "attachment.image.generated.get": {
			if (session.sessionId === undefined || session.sessionId !== request.params.sessionId) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "session_mismatch",
						message: "Generated images can only be read for the active session."
					}
				});
				return;
			}

			try {
				const image = await readGeneratedImageDataUrl(request.params.sessionId, request.params.imageId);
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result: image
				});
			} catch (error: unknown) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "generated_image_read_failed",
						message: error instanceof Error ? error.message : "Failed to read generated image"
					}
				});
			}
			return;
		}

		default:
			throw new Error(`Unsupported attachment method: ${request.method}`);
	}
}
