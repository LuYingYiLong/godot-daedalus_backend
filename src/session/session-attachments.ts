import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AdditionalContextItem, AiChatParams } from "../protocol/types.js";
import { MAX_IMAGE_BYTES, SUPPORTED_IMAGE_MIME_TYPES } from "../protocol/image-attachments.js";
import { getSessionDir, openSession } from "./session-store.js";

const ATTACHMENT_ID_PATTERN: RegExp = /^image-[a-zA-Z0-9_-]+$/;

export type SaveImageAttachmentInput = {
	sessionId: string;
	mimeType: string;
	dataUrl: string;
	byteSize: number;
	width?: number | undefined;
	height?: number | undefined;
	title?: string | undefined;
};

export type ImageAttachmentMetadata = {
	id: string;
	mimeType: string;
	byteSize: number;
	width?: number | undefined;
	height?: number | undefined;
	title: string;
	createdAt: string;
	fileName: string;
};

function getAttachmentsDir(sessionId: string): string {
	return join(getSessionDir(sessionId), "attachments");
}

function assertSafeAttachmentId(attachmentId: string): string {
	if (!ATTACHMENT_ID_PATTERN.test(attachmentId)) {
		throw new Error(`Invalid image attachment id: ${attachmentId}`);
	}
	return attachmentId;
}

function attachmentImagePath(sessionId: string, attachmentId: string): string {
	return join(getAttachmentsDir(sessionId), `${assertSafeAttachmentId(attachmentId)}.png`);
}

function attachmentMetadataPath(sessionId: string, attachmentId: string): string {
	return join(getAttachmentsDir(sessionId), `${assertSafeAttachmentId(attachmentId)}.json`);
}

function parseImageDataUrl(mimeType: string, dataUrl: string): Buffer {
	const prefix: string = `data:${mimeType};base64,`;
	if (!dataUrl.startsWith(prefix)) {
		throw new Error("Image dataUrl must match mimeType.");
	}

	const base64Text: string = dataUrl.slice(prefix.length);
	if (base64Text.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64Text)) {
		throw new Error("Image dataUrl must contain valid base64 data.");
	}

	return Buffer.from(base64Text, "base64");
}

function formatByteSize(byteSize: number): string {
	if (byteSize >= 1024 * 1024) {
		return `${(byteSize / 1024 / 1024).toFixed(1)} MiB`;
	}
	if (byteSize >= 1024) {
		return `${Math.round(byteSize / 1024)} KiB`;
	}
	return `${byteSize} B`;
}

function createImageAttachmentContext(metadata: ImageAttachmentMetadata, thumbnailDataUrl?: string | undefined): AdditionalContextItem {
	const dimensionText: string = metadata.width !== undefined && metadata.height !== undefined
		? `${metadata.width}x${metadata.height}`
		: "未知尺寸";
	const data: Record<string, unknown> = {
		mimeType: metadata.mimeType,
		attachmentId: metadata.id,
		byteSize: metadata.byteSize
	};
	if (metadata.width !== undefined) {
		data.width = metadata.width;
	}
	if (metadata.height !== undefined) {
		data.height = metadata.height;
	}
	if (thumbnailDataUrl !== undefined) {
		data.thumbnailDataUrl = thumbnailDataUrl;
	}

	return {
		id: metadata.id,
		kind: "image",
		title: metadata.title,
		subtitle: `${metadata.mimeType} · ${formatByteSize(metadata.byteSize)} · ${dimensionText}`,
		pinned: false,
		source: "manual",
		summary: "用户为本轮消息附加了一张剪贴板图片；图片内容保存在当前会话附件中。",
		data
	};
}

export async function saveImageAttachment(input: SaveImageAttachmentInput): Promise<AdditionalContextItem> {
	await openSession(input.sessionId);
	if (!SUPPORTED_IMAGE_MIME_TYPES.includes(input.mimeType)) {
		throw new Error("Unsupported image mimeType.");
	}
	if (input.byteSize <= 0 || input.byteSize > MAX_IMAGE_BYTES) {
		throw new Error("Image is larger than 1 MiB.");
	}

	const bytes: Buffer = parseImageDataUrl(input.mimeType, input.dataUrl);
	if (bytes.byteLength !== input.byteSize) {
		throw new Error("Image byteSize does not match decoded data.");
	}

	const attachmentId: string = `image-${randomUUID()}`;
	const createdAt: string = new Date().toISOString();
	const metadata: ImageAttachmentMetadata = {
		id: attachmentId,
		mimeType: input.mimeType,
		byteSize: input.byteSize,
		title: input.title?.trim() || `Clipboard image ${createdAt.replace("T", " ").slice(0, 19)}`,
		createdAt,
		fileName: `${attachmentId}.png`
	};
	if (input.width !== undefined) {
		metadata.width = input.width;
	}
	if (input.height !== undefined) {
		metadata.height = input.height;
	}

	await mkdir(getAttachmentsDir(input.sessionId), { recursive: true });
	await writeFile(attachmentImagePath(input.sessionId, attachmentId), bytes);
	await writeFile(attachmentMetadataPath(input.sessionId, attachmentId), JSON.stringify(metadata, null, 2), "utf8");
	return createImageAttachmentContext(metadata, input.dataUrl);
}

export async function readImageAttachmentDataUrl(sessionId: string, attachmentId: string): Promise<string> {
	await openSession(sessionId);
	const metadataRaw: string = await readFile(attachmentMetadataPath(sessionId, attachmentId), "utf8");
	const metadata: ImageAttachmentMetadata = JSON.parse(metadataRaw) as ImageAttachmentMetadata;
	const bytes: Buffer = await readFile(attachmentImagePath(sessionId, attachmentId));
	return `data:${metadata.mimeType};base64,${bytes.toString("base64")}`;
}

export async function hydrateImageAttachmentContexts(sessionId: string | undefined, params: AiChatParams): Promise<AiChatParams> {
	if (sessionId === undefined || params.additionalContext === undefined) {
		return params;
	}

	let changed: boolean = false;
	const additionalContext: AdditionalContextItem[] = [];
	for (const item of params.additionalContext) {
		if (item.kind !== "image" || typeof item.data !== "object" || item.data === null || Array.isArray(item.data)) {
			additionalContext.push(item);
			continue;
		}

		const data: Record<string, unknown> = item.data as Record<string, unknown>;
		if (typeof data.dataUrl === "string" && data.dataUrl.length > 0) {
			additionalContext.push(item);
			continue;
		}
		if (typeof data.attachmentId !== "string" || data.attachmentId.length === 0) {
			additionalContext.push(item);
			continue;
		}

		const dataUrl: string = await readImageAttachmentDataUrl(sessionId, data.attachmentId);
		additionalContext.push({
			...item,
			data: {
				...data,
				dataUrl
			}
		});
		changed = true;
	}

	return changed ? { ...params, additionalContext } : params;
}
