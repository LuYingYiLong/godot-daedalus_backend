import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AdditionalContextItem, AiChatParams } from "../protocol/types.js";
import { MAX_IMAGE_BYTES, SUPPORTED_IMAGE_MIME_TYPES } from "../protocol/image-attachments.js";
import { getSessionDir, openSession } from "./session-store.js";

const ATTACHMENT_ID_PATTERN: RegExp = /^image-[a-zA-Z0-9_-]+$/;
const GENERATED_IMAGE_ID_PATTERN: RegExp = /^generated-image-[a-zA-Z0-9_-]+$/;

export type SaveImageAttachmentInput = {
	sessionId: string;
	mimeType: string;
	dataUrl: string;
	byteSize: number;
	width?: number | undefined;
	height?: number | undefined;
	title?: string | undefined;
	source?: "editor" | "manual" | undefined;
	summary?: string | undefined;
};

export type ImageAttachmentMetadata = {
	id: string;
	mimeType: string;
	byteSize: number;
	width?: number | undefined;
	height?: number | undefined;
	title: string;
	source: "editor" | "manual";
	summary: string;
	createdAt: string;
	fileName: string;
};

export type GeneratedImageArtifactMetadata = {
	imageId: string;
	sessionId: string;
	mimeType: string;
	width?: number | undefined;
	height?: number | undefined;
	byteSize: number;
	provider: string;
	model: string;
	prompt: string;
	revisedPrompt?: string | undefined;
	createdAt: string;
	fileName: string;
};

export type SaveGeneratedImageArtifactInput = {
	sessionId: string;
	bytes: Buffer;
	mimeType: string;
	width?: number | undefined;
	height?: number | undefined;
	provider: string;
	model: string;
	prompt: string;
	revisedPrompt?: string | undefined;
};

function getAttachmentsDir(sessionId: string): string {
	return join(getSessionDir(sessionId), "attachments");
}

function getGeneratedImagesDir(sessionId: string): string {
	return join(getAttachmentsDir(sessionId), "images");
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

function assertSafeGeneratedImageId(imageId: string): string {
	if (!GENERATED_IMAGE_ID_PATTERN.test(imageId)) {
		throw new Error(`Invalid generated image id: ${imageId}`);
	}
	return imageId;
}

function getImageExtension(mimeType: string): string {
	if (mimeType === "image/jpeg") {
		return "jpg";
	}
	if (mimeType === "image/webp") {
		return "webp";
	}
	return "png";
}

function generatedImagePath(sessionId: string, imageId: string, mimeType: string): string {
	return join(getGeneratedImagesDir(sessionId), `${assertSafeGeneratedImageId(imageId)}.${getImageExtension(mimeType)}`);
}

function generatedImageMetadataPath(sessionId: string, imageId: string): string {
	return join(getGeneratedImagesDir(sessionId), `${assertSafeGeneratedImageId(imageId)}.json`);
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
		source: metadata.source,
		summary: metadata.summary,
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
		source: input.source ?? "manual",
		summary: input.summary?.trim() || "用户为本轮消息附加了一张剪贴板图片；图片内容保存在当前会话附件中。",
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

export async function saveGeneratedImageArtifact(input: SaveGeneratedImageArtifactInput): Promise<GeneratedImageArtifactMetadata> {
	await openSession(input.sessionId);
	if (!SUPPORTED_IMAGE_MIME_TYPES.includes(input.mimeType)) {
		throw new Error("Unsupported generated image mimeType.");
	}
	if (input.bytes.byteLength <= 0) {
		throw new Error("Generated image is empty.");
	}

	const imageId: string = `generated-image-${randomUUID()}`;
	const createdAt: string = new Date().toISOString();
	const fileName: string = `${imageId}.${getImageExtension(input.mimeType)}`;
	const metadata: GeneratedImageArtifactMetadata = {
		imageId,
		sessionId: input.sessionId,
		mimeType: input.mimeType,
		byteSize: input.bytes.byteLength,
		provider: input.provider,
		model: input.model,
		prompt: input.prompt,
		createdAt,
		fileName
	};
	if (input.width !== undefined) {
		metadata.width = input.width;
	}
	if (input.height !== undefined) {
		metadata.height = input.height;
	}
	if (input.revisedPrompt !== undefined && input.revisedPrompt.trim().length > 0) {
		metadata.revisedPrompt = input.revisedPrompt.trim();
	}

	await mkdir(getGeneratedImagesDir(input.sessionId), { recursive: true });
	await writeFile(generatedImagePath(input.sessionId, imageId, input.mimeType), input.bytes);
	await writeFile(generatedImageMetadataPath(input.sessionId, imageId), JSON.stringify(metadata, null, 2), "utf8");
	return metadata;
}

export async function readGeneratedImageDataUrl(sessionId: string, imageId: string): Promise<{ imageId: string; mimeType: string; dataUrl: string; metadata: GeneratedImageArtifactMetadata }> {
	await openSession(sessionId);
	const metadataRaw: string = await readFile(generatedImageMetadataPath(sessionId, imageId), "utf8");
	const metadata: GeneratedImageArtifactMetadata = JSON.parse(metadataRaw) as GeneratedImageArtifactMetadata;
	if (metadata.sessionId !== sessionId || metadata.imageId !== imageId) {
		throw new Error("Generated image metadata does not match request.");
	}
	const bytes: Buffer = await readFile(generatedImagePath(sessionId, imageId, metadata.mimeType));
	return {
		imageId,
		mimeType: metadata.mimeType,
		dataUrl: `data:${metadata.mimeType};base64,${bytes.toString("base64")}`,
		metadata
	};
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
