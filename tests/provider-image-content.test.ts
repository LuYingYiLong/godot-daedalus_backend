import assert from "node:assert/strict";
import test from "node:test";
import type { ChatCompletionUserMessageParam } from "openai/resources/chat/completions";
import { aiChatParamsSchema } from "../src/protocol/schema.js";
import { createCurrentUserMessage, getImageAttachments, ProviderImageInputError } from "../src/providers/provider-image-content.js";

const VALID_IMAGE_CONTEXT = {
	id: "img-1",
	kind: "image",
	title: "scene_tree.png",
	subtitle: "image/png",
	source: "manual",
	resourcePath: "res://tests/images/scene_tree.png",
	data: {
		mimeType: "image/png",
		dataUrl: "data:image/png;base64,aGVsbG8=",
		byteSize: 5,
		width: 32,
		height: 24
	}
} as const;

test("schema accepts image additional context", (): void => {
	const result = aiChatParamsSchema.safeParse({
		message: "描述这张图",
		additionalContext: [VALID_IMAGE_CONTEXT]
	});

	assert.equal(result.success, true);
});

test("schema rejects invalid image mime and oversized byte size", (): void => {
	const badMime = aiChatParamsSchema.safeParse({
		message: "描述这张图",
		additionalContext: [{
			...VALID_IMAGE_CONTEXT,
			data: {
				...VALID_IMAGE_CONTEXT.data,
				mimeType: "image/bmp"
			}
		}]
	});
	assert.equal(badMime.success, false);

	const tooLarge = aiChatParamsSchema.safeParse({
		message: "描述这张图",
		additionalContext: [{
			...VALID_IMAGE_CONTEXT,
			data: {
				...VALID_IMAGE_CONTEXT.data,
				byteSize: 1024 * 1024 + 1
			}
		}]
	});
	assert.equal(tooLarge.success, false);
});

test("image content parts are sent only in current user message", (): void => {
	const message: ChatCompletionUserMessageParam = createCurrentUserMessage({
		message: "请识别图片内容",
		additionalContext: [VALID_IMAGE_CONTEXT]
	});

	assert.equal(message.role, "user");
	assert.ok(Array.isArray(message.content));
	assert.deepEqual(message.content, [
		{
			type: "image_url",
			image_url: {
				url: VALID_IMAGE_CONTEXT.data.dataUrl
			}
		},
		{
			type: "text",
			text: "请识别图片内容"
		}
	]);
});

test("image attachment validation rejects invalid base64 and too many images", (): void => {
	assert.throws(
		() => getImageAttachments([{
			...VALID_IMAGE_CONTEXT,
			data: {
				...VALID_IMAGE_CONTEXT.data,
				dataUrl: "data:image/png;base64,不是base64"
			}
		}]),
		(error: unknown): boolean => error instanceof ProviderImageInputError && error.code === "invalid_image_attachment"
	);

	assert.throws(
		() => getImageAttachments([VALID_IMAGE_CONTEXT, VALID_IMAGE_CONTEXT, VALID_IMAGE_CONTEXT, VALID_IMAGE_CONTEXT]),
		(error: unknown): boolean => error instanceof ProviderImageInputError && error.code === "too_many_image_attachments"
	);
});
