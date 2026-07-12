import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { aiChatParamsSchema } from "../src/protocol/schema.js";

async function withTempAppData(run: () => Promise<void>): Promise<void> {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	process.env.USERPROFILE = await mkdtemp(join(tmpdir(), "daedalus-session-attachments-"));
	try {
		await run();
	} finally {
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
	}
}

test("schema accepts session-backed image additional context", (): void => {
	const result = aiChatParamsSchema.safeParse({
		message: "描述这张剪贴板图",
		additionalContext: [{
			id: "image-test",
			kind: "image",
			title: "Clipboard image",
			source: "manual",
			data: {
				mimeType: "image/png",
				attachmentId: "image-test",
				byteSize: 5,
				width: 16,
				height: 12
			}
		}]
	});

	assert.equal(result.success, true);
});

test("image attachments are saved under the session and hydrate to dataUrl", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		const sessionStore = await import("../src/session/session-store.js");
		const attachments = await import("../src/session/session-attachments.js");
		const metadata = await sessionStore.createSession("Attachment test");
		const dataUrl: string = "data:image/png;base64,aGVsbG8=";

		const context = await attachments.saveImageAttachment({
			sessionId: metadata.id,
			mimeType: "image/png",
			dataUrl,
			byteSize: 5,
			width: 32,
			height: 24,
			title: "Clipboard image test"
		});

		assert.equal(context.kind, "image");
		assert.equal(context.source, "manual");
		assert.equal((context.data as Record<string, unknown>).attachmentId !== undefined, true);
		assert.equal((context.data as Record<string, unknown>).dataUrl, undefined);
		assert.equal(typeof (context.data as Record<string, unknown>).thumbnailDataUrl, "string");

		const attachmentId: string = String((context.data as Record<string, unknown>).attachmentId);
		const rawMetadata: string = await readFile(join(sessionStore.getSessionDir(metadata.id), "attachments", `${attachmentId}.json`), "utf8");
		assert.equal(rawMetadata.includes("aGVsbG8="), false);

		const hydrated = await attachments.hydrateImageAttachmentContexts(metadata.id, {
			message: "描述图片",
			additionalContext: [context]
		});
		assert.equal((hydrated.additionalContext?.[0]?.data as Record<string, unknown>).dataUrl, dataUrl);
	});
});

test("timeline result hydrates session-backed image thumbnails without persisting base64", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		const sessionStore = await import("../src/session/session-store.js");
		const attachments = await import("../src/session/session-attachments.js");
		const sessionPreview = await import("../src/server/session-preview.js");
		const metadata = await sessionStore.createSession("Timeline attachment test");
		const context = await attachments.saveImageAttachment({
			sessionId: metadata.id,
			mimeType: "image/png",
			dataUrl: "data:image/png;base64,aGVsbG8=",
			byteSize: 5,
			width: 32,
			height: 24,
			title: "Clipboard image test"
		});
		const storedContext = {
			...context,
			data: {
				...(context.data as Record<string, unknown>),
				thumbnailDataUrl: undefined
			}
		};
		delete (storedContext.data as Record<string, unknown>).thumbnailDataUrl;

		await sessionStore.saveSession(metadata.id, [{
			role: "user",
			content: "看图",
			requestId: "request-image",
			additionalContext: [storedContext]
		}, {
			role: "assistant",
			content: "好的",
			requestId: "request-image"
		}]);

		const rawMessages: string = await readFile(join(sessionStore.getSessionDir(metadata.id), "messages.jsonl"), "utf8");
		assert.equal(rawMessages.includes("aGVsbG8="), false);

		const page = await sessionStore.openSessionRecentTimeline(metadata.id, 10);
		const result = await sessionPreview.createTimelinePageResult(page, 10);
		const blocks = result.timelineBlocks as Array<Record<string, unknown>>;
		const userBlock = blocks.find((block: Record<string, unknown>): boolean => block.type === "user");
		const additionalContext = userBlock?.additionalContext as Array<Record<string, unknown>>;
		const imageData = additionalContext[0]?.data as Record<string, unknown>;
		assert.equal(imageData.thumbnailDataUrl, "data:image/png;base64,aGVsbG8=");
	});
});

test("storage clone strips transient image data for session-backed attachments", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		const { cloneAdditionalContextItems } = await import("../src/server/additional-context.js");
		const cloned = cloneAdditionalContextItems([{
			id: "image-test",
			kind: "image",
			title: "Clipboard image",
			source: "manual",
			data: {
				mimeType: "image/png",
				attachmentId: "image-test",
				dataUrl: "data:image/png;base64,aGVsbG8=",
				thumbnailDataUrl: "data:image/png;base64,aGVsbG8=",
				byteSize: 5
			}
		}]);

		const data: Record<string, unknown> = cloned?.[0]?.data as Record<string, unknown>;
		assert.equal(data.attachmentId, "image-test");
		assert.equal(data.dataUrl, undefined);
		assert.equal(data.thumbnailDataUrl, undefined);
	});
});
