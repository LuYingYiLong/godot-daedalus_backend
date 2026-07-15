import OpenAI from "openai";
import type { Image, ImageGenerateParamsNonStreaming, ImagesResponse } from "openai/resources/images";
import type { ProviderId } from "../protocol/types.js";
import type { GeneratedImageArtifactMetadata } from "../session/session-attachments.js";
import { saveGeneratedImageArtifact } from "../session/session-attachments.js";
import { getProviderFallbackModels } from "./provider-registry.js";
import type { ProviderChatOptions, ProviderModelInfo } from "./provider-types.js";
import { normalizeConfiguredProviderBaseUrl, resolveProviderBaseUrl } from "./provider-base-url.js";
import { ProviderTaskModelError, resolveConfiguredProviderTaskModelOptions } from "./task-model-routing.js";

export type ImageGenerationAspectRatio = "1:1" | "16:9" | "9:16" | "4:3" | "3:4";

export type ImageGenerationInput = {
	sessionId: string;
	prompt: string;
	count?: number | undefined;
	aspectRatio?: ImageGenerationAspectRatio | undefined;
	style?: string | undefined;
	seed?: number | undefined;
};

export type ImageGenerationResult = {
	status: "completed";
	prompt: string;
	provider: ProviderId;
	model: string;
	artifacts: GeneratedImageArtifactMetadata[];
};

export class ImageGenerationError extends Error {
	readonly code: "image_generation_not_configured" | "image_generation_not_supported" | "image_generation_failed";

	constructor(code: ImageGenerationError["code"], message: string) {
		super(message);
		this.name = "ImageGenerationError";
		this.code = code;
	}
}

function getPositiveInteger(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.max(min, Math.min(max, Math.floor(value)));
}

function getPrompt(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new ImageGenerationError("image_generation_failed", "Image generation prompt is required.");
	}
	return value.trim().slice(0, 32000);
}

function normalizeAspectRatio(value: unknown): ImageGenerationAspectRatio {
	if (value === "16:9" || value === "9:16" || value === "4:3" || value === "3:4") {
		return value;
	}
	return "1:1";
}

function mapAspectRatioToOpenAIImageSize(aspectRatio: ImageGenerationAspectRatio): NonNullable<ImageGenerateParamsNonStreaming["size"]> {
	if (aspectRatio === "9:16" || aspectRatio === "3:4") {
		return "1024x1536";
	}
	if (aspectRatio === "16:9" || aspectRatio === "4:3") {
		return "1536x1024";
	}
	return "1024x1024";
}

function mapAspectRatioToZhipuImageSize(aspectRatio: ImageGenerationAspectRatio): string {
	if (aspectRatio === "9:16") {
		return "960x1728";
	}
	if (aspectRatio === "3:4") {
		return "1056x1568";
	}
	if (aspectRatio === "16:9") {
		return "1728x960";
	}
	if (aspectRatio === "4:3") {
		return "1568x1056";
	}
	return "1280x1280";
}

function getStyle(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed: string = value.trim();
	return trimmed.length > 0 ? trimmed.slice(0, 120) : undefined;
}

export function parseImageGenerationToolArgs(args: Record<string, unknown>, sessionId: string): ImageGenerationInput {
	return {
		sessionId,
		prompt: getPrompt(args.prompt),
		count: getPositiveInteger(args.count, 1, 1, 4),
		aspectRatio: normalizeAspectRatio(args.aspectRatio),
		style: getStyle(args.style),
		seed: typeof args.seed === "number" && Number.isFinite(args.seed) ? Math.floor(args.seed) : undefined
	};
}

function modelSupportsImageGeneration(provider: ProviderId, modelId: string): boolean {
	const fallback: ProviderModelInfo | undefined = getProviderFallbackModels(provider)
		.find((model: ProviderModelInfo): boolean => model.id === modelId);
	return fallback?.capabilities.imageGeneration === true;
}

function createOpenAIClient(options: ProviderChatOptions): OpenAI {
	const clientOptions: ConstructorParameters<typeof OpenAI>[0] = {
		apiKey: options.apiKey
	};
	const normalizedBaseUrl: string | undefined = normalizeConfiguredProviderBaseUrl(options.baseUrl);
	if (normalizedBaseUrl !== undefined) {
		clientOptions.baseURL = normalizedBaseUrl;
	}
	return new OpenAI(clientOptions);
}

function createPrompt(input: ImageGenerationInput): string {
	const segments: string[] = [input.prompt];
	if (input.style !== undefined) {
		segments.push(`Style: ${input.style}`);
	}
	if (input.seed !== undefined) {
		segments.push(`Seed hint: ${input.seed}`);
	}
	return segments.join("\n");
}

function guessMimeType(response: ImagesResponse, image: Image): string {
	if (response.output_format === "jpeg") {
		return "image/jpeg";
	}
	if (response.output_format === "webp") {
		return "image/webp";
	}
	const url: string | undefined = image.url;
	if (url !== undefined && /\.jpe?g(?:$|\?)/iu.test(url)) {
		return "image/jpeg";
	}
	if (url !== undefined && /\.webp(?:$|\?)/iu.test(url)) {
		return "image/webp";
	}
	return "image/png";
}

async function readImageBytes(response: ImagesResponse, image: Image): Promise<Buffer> {
	if (typeof image.b64_json === "string" && image.b64_json.length > 0) {
		return Buffer.from(image.b64_json, "base64");
	}
	if (typeof image.url === "string") {
		return readImageUrlBytes(image.url);
	}
	throw new ImageGenerationError("image_generation_failed", "Provider did not return image data.");
}

async function readImageUrlBytes(url: string): Promise<Buffer> {
	if (url.length === 0) {
		throw new ImageGenerationError("image_generation_failed", "Provider did not return image data.");
	}
	const imageResponse: Response = await fetch(url);
	if (!imageResponse.ok) {
		throw new ImageGenerationError("image_generation_failed", `Failed to download generated image: HTTP ${imageResponse.status}`);
	}
	return Buffer.from(await imageResponse.arrayBuffer());
}

async function generateOpenAIImages(options: ProviderChatOptions, input: ImageGenerationInput): Promise<ImageGenerationResult> {
	const model: string = options.model ?? "gpt-image-1";
	const client: OpenAI = createOpenAIClient(options);
	const response: ImagesResponse = await client.images.generate({
		model,
		prompt: createPrompt(input),
		n: input.count ?? 1,
		size: mapAspectRatioToOpenAIImageSize(input.aspectRatio ?? "1:1"),
		output_format: "png",
		stream: false
	});
	const images: Image[] = response.data ?? [];
	if (images.length === 0) {
		throw new ImageGenerationError("image_generation_failed", "Provider returned no generated images.");
	}

	const artifacts: GeneratedImageArtifactMetadata[] = [];
	for (const image of images) {
		const mimeType: string = guessMimeType(response, image);
		const bytes: Buffer = await readImageBytes(response, image);
		artifacts.push(await saveGeneratedImageArtifact({
			sessionId: input.sessionId,
			bytes,
			mimeType,
			provider: options.provider,
			model,
			prompt: input.prompt,
			revisedPrompt: image.revised_prompt ?? undefined
		}));
	}

	return {
		status: "completed",
		prompt: input.prompt,
		provider: options.provider,
		model,
		artifacts
	};
}

type ZhipuImageGenerationResponse = {
	data?: Array<{
		url?: string | undefined;
		b64_json?: string | undefined;
		revised_prompt?: string | undefined;
	}>;
	error?: {
		code?: string | undefined;
		message?: string | undefined;
	};
};

async function generateZhipuImages(options: ProviderChatOptions, input: ImageGenerationInput): Promise<ImageGenerationResult> {
	const model: string = options.model ?? "glm-image";
	const baseUrl: string = resolveProviderBaseUrl(options.provider, options.baseUrl);
	const response: Response = await fetch(`${baseUrl}/images/generations`, {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${options.apiKey}`,
			"Content-Type": "application/json"
		},
		body: JSON.stringify({
			model,
			prompt: createPrompt(input),
			size: mapAspectRatioToZhipuImageSize(input.aspectRatio ?? "1:1")
		})
	});
	const text: string = await response.text();
	let parsed: ZhipuImageGenerationResponse;
	try {
		parsed = JSON.parse(text) as ZhipuImageGenerationResponse;
	} catch {
		throw new ImageGenerationError("image_generation_failed", `Zhipu image generation returned invalid JSON: HTTP ${response.status}`);
	}
	if (!response.ok || parsed.error !== undefined) {
		throw new ImageGenerationError(
			"image_generation_failed",
			parsed.error?.message ?? `Zhipu image generation failed: HTTP ${response.status}`
		);
	}

	const images = parsed.data ?? [];
	if (images.length === 0) {
		throw new ImageGenerationError("image_generation_failed", "Provider returned no generated images.");
	}

	const artifacts: GeneratedImageArtifactMetadata[] = [];
	for (const image of images.slice(0, input.count ?? 1)) {
		const bytes: Buffer = typeof image.b64_json === "string" && image.b64_json.length > 0
			? Buffer.from(image.b64_json, "base64")
			: await readImageUrlBytes(image.url ?? "");
		artifacts.push(await saveGeneratedImageArtifact({
			sessionId: input.sessionId,
			bytes,
			mimeType: image.url !== undefined && /\.jpe?g(?:$|\?)/iu.test(image.url) ? "image/jpeg" : "image/png",
			provider: options.provider,
			model,
			prompt: input.prompt,
			revisedPrompt: image.revised_prompt
		}));
	}

	return {
		status: "completed",
		prompt: input.prompt,
		provider: options.provider,
		model,
		artifacts
	};
}

export async function generateImage(input: ImageGenerationInput): Promise<ImageGenerationResult> {
	try {
		const resolved = await resolveConfiguredProviderTaskModelOptions("imageGeneration");
		const options: ProviderChatOptions = resolved.options;
		if (!modelSupportsImageGeneration(options.provider, resolved.model)) {
			throw new ImageGenerationError(
				"image_generation_not_supported",
				`Model ${options.provider}/${resolved.model} does not support image generation.`
			);
		}

		if (options.provider === "zhipu") {
			return await generateZhipuImages(options, input);
		}

		if (options.provider !== "openai") {
			throw new ImageGenerationError(
				"image_generation_not_supported",
				`Provider ${options.provider} is not adapted for image generation.`
			);
		}

		return await generateOpenAIImages(options, input);
	} catch (error: unknown) {
		if (error instanceof ImageGenerationError) {
			throw error;
		}
		if (error instanceof ProviderTaskModelError) {
			throw new ImageGenerationError(
				error.code === "task_model_not_configured" ? "image_generation_not_configured" : "image_generation_failed",
				error.message
			);
		}
		throw new ImageGenerationError(
			"image_generation_failed",
			error instanceof Error ? error.message : "Image generation failed."
		);
	}
}
