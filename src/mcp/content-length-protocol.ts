import { Buffer } from "node:buffer";

const HEADER_SEPARATOR: string = "\r\n\r\n";

export function encodeContentLengthMessage(payload: unknown): Buffer {
	const body: string = JSON.stringify(payload);
	const bodyBuffer: Buffer = Buffer.from(body, "utf8");
	const header: string = `Content-Length: ${bodyBuffer.byteLength}\r\n\r\n`;
	return Buffer.concat([Buffer.from(header, "ascii"), bodyBuffer]);
}

export class ContentLengthMessageParser {
	private buffer: Buffer = Buffer.alloc(0);

	push(chunk: Buffer): unknown[] {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		const messages: unknown[] = [];

		while (true) {
			const headerEnd: number = this.buffer.indexOf(HEADER_SEPARATOR);
			if (headerEnd < 0) {
				break;
			}

			const headerText: string = this.buffer.subarray(0, headerEnd).toString("ascii");
			const contentLength: number | null = parseContentLength(headerText);
			if (contentLength === null) {
				throw new Error("Missing Content-Length header");
			}

			const bodyStart: number = headerEnd + Buffer.byteLength(HEADER_SEPARATOR, "ascii");
			const bodyEnd: number = bodyStart + contentLength;
			if (this.buffer.byteLength < bodyEnd) {
				break;
			}

			const bodyText: string = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
			messages.push(JSON.parse(bodyText) as unknown);
			this.buffer = this.buffer.subarray(bodyEnd);
		}

		return messages;
	}
}

function parseContentLength(headerText: string): number | null {
	const lines: string[] = headerText.split("\r\n");
	for (const line of lines) {
		const separatorIndex: number = line.indexOf(":");
		if (separatorIndex < 0) {
			continue;
		}

		const name: string = line.slice(0, separatorIndex).trim().toLowerCase();
		if (name !== "content-length") {
			continue;
		}

		const value: string = line.slice(separatorIndex + 1).trim();
		if (!/^\d+$/.test(value)) {
			throw new Error(`Invalid Content-Length header: ${value}`);
		}

		return Number.parseInt(value, 10);
	}

	return null;
}
