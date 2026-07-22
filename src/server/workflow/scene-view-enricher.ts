import type { AdditionalContextItem } from "../../protocol/types.js";
import type { ProviderChatOptions } from "../../providers/deepseek-client.js";
import { chatWithProvider } from "../../providers/deepseek-client.js";
import { getProviderDisplayName } from "../../providers/provider-registry.js";
import { modelSupportsImageInput } from "../../providers/provider-image-content.js";
import { resolveProviderTaskModelOptions } from "../../providers/task-model-routing.js";
import { saveImageAttachment } from "../../session/session-attachments.js";
import type { IdempotentToolExecutionResult } from "../../tools/tool-idempotency.js";
import type { ToolResultEnricher } from "../../tools/tool-dispatcher.js";
import type { ClientSession } from "../client-session.js";
import { withProviderUsageContext } from "../../usage/provider-recorder.js";

const SCENE_VIEW_TOOL: string = "mcp_godot_editor_capture_scene_view";
const MAX_OBSERVATION_CHARS: number = 2400;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getString(record: JsonRecord, key: string): string | undefined {
	const value: unknown = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getPositiveInteger(record: JsonRecord, key: string): number | undefined {
	const value: unknown = record[key];
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function clipText(value: string): string {
	return value.length <= MAX_OBSERVATION_CHARS ? value : `${value.slice(0, MAX_OBSERVATION_CHARS)}\n\n[视觉观察已截断]`;
}

function parseCaptureResult(content: string): JsonRecord {
	let outer: unknown;
	try {
		outer = JSON.parse(content);
	} catch {
		throw new Error("scene_view_capture_invalid_result");
	}

	if (!isRecord(outer)) {
		throw new Error("scene_view_capture_invalid_result");
	}

	const nested: unknown = outer.result;
	if (isRecord(nested)) {
		return nested;
	}
	return outer;
}

function createUnavailableResult(attachment: AdditionalContextItem, capture: JsonRecord, reason: string): IdempotentToolExecutionResult {
	const content: string = JSON.stringify({
		ok: true,
		capture: {
			status: "available",
			attachmentId: attachment.id,
			view: getString(capture, "view") ?? "unknown",
			width: getPositiveInteger(capture, "width") ?? null,
			height: getPositiveInteger(capture, "height") ?? null
		},
		analysis: {
			status: "unavailable",
			reason
		},
		artifactRefs: [attachment.id]
	}, null, 2);
	return { content, rawContentLength: content.length, truncated: false, reused: false };
}

export type SceneViewToolResultEnricher = {
	enricher: ToolResultEnricher;
	getCapturedAttachments: () => AdditionalContextItem[];
};

export function createSceneViewToolResultEnricher(params: {
	session: ClientSession;
	options: ProviderChatOptions;
	phaseInstruction: string;
	abortSignal?: AbortSignal | undefined;
}): SceneViewToolResultEnricher {
	const capturedAttachments: AdditionalContextItem[] = [];

	const enricher: ToolResultEnricher = async (input): Promise<IdempotentToolExecutionResult> => {
		if (input.toolName !== SCENE_VIEW_TOOL) {
			return input.result;
		}
		if (params.session.sessionId === undefined) {
			throw new Error("scene_view_capture_requires_session");
		}

		const capture: JsonRecord = parseCaptureResult(input.result.content);
		const mimeType: string | undefined = getString(capture, "mimeType");
		const dataUrl: string | undefined = getString(capture, "dataUrl");
		const byteSize: number | undefined = getPositiveInteger(capture, "byteSize");
		if (mimeType !== "image/png" || dataUrl === undefined || byteSize === undefined) {
			throw new Error("scene_view_capture_invalid_image");
		}

		input.onProgress?.({
			status: "message",
			title: "保存场景视图",
			details: "正在保存当前编辑器视口截图。",
			code: "scene_view.capture.started"
		});
		const view: string = getString(capture, "view") ?? "scene";
		const attachment: AdditionalContextItem = await saveImageAttachment({
			sessionId: params.session.sessionId,
			mimeType,
			dataUrl,
			byteSize,
			width: getPositiveInteger(capture, "width"),
			height: getPositiveInteger(capture, "height"),
			title: `Editor ${view.toUpperCase()} scene view`,
			source: "editor",
			summary: "工作流在本轮按需截取的 Godot 编辑器场景视图。"
		});
		capturedAttachments.push(attachment);
		input.onProgress?.({
			status: "success",
			title: "场景视图已保存",
			details: "截图已作为当前会话附件保存。",
			code: "scene_view.capture.completed"
		});

		try {
			const imageModel = await resolveProviderTaskModelOptions("imageRecognition", params.options);
			const imageOptions: ProviderChatOptions = withProviderUsageContext(imageModel.options, {
				operation: "scene_view_image_recognition"
			});
			if (!await modelSupportsImageInput(imageModel.provider, imageModel.model)) {
				input.onProgress?.({
					status: "error",
					title: "场景视图解释不可用",
					details: "当前未配置可用的图片识别模型。",
					code: "scene_view.analysis.unavailable"
				});
				return createUnavailableResult(attachment, capture, "当前未配置可用的图片识别模型。");
			}

			input.onProgress?.({
				status: "message",
				title: "解释场景视图",
				details: `使用 ${getProviderDisplayName(imageModel.provider)} / ${imageModel.model} 分析截图。`,
				code: "scene_view.analysis.started"
			});
			const observation: string = clipText(await chatWithProvider({
				message: [
					"请作为 Godot 场景视图观察助手，客观描述截图中可见的节点布局、UI 层级、空间关系、遮挡、错误提示和可能需要关注的视觉问题。",
					"不要编造不可见的代码、属性或运行状态。输出给后续主模型阅读的简洁中文观察。",
					"当前工作流阶段：",
					params.phaseInstruction
				].join("\n"),
				additionalContext: [{
					...attachment,
					data: {
						...(attachment.data as JsonRecord),
						dataUrl
					}
				}],
				options: { temperature: 0.1, maxTokens: MAX_OBSERVATION_CHARS, workflow: "single" }
			}, imageOptions, [], "你是严谨的 Godot 编辑器视觉观察助手。", params.abortSignal));
			input.onProgress?.({
				status: "success",
				title: "场景视图解释完成",
				details: clipText(observation).slice(0, 500),
				code: "scene_view.analysis.completed"
			});
			const content: string = JSON.stringify({
				ok: true,
				capture: {
					status: "available",
					attachmentId: attachment.id,
					view,
					width: getPositiveInteger(capture, "width") ?? null,
					height: getPositiveInteger(capture, "height") ?? null
				},
				analysis: {
					status: "completed",
					provider: imageModel.provider,
					model: imageModel.model,
					observation
				},
				artifactRefs: [attachment.id]
			}, null, 2);
			return { content, rawContentLength: content.length, truncated: false, reused: false };
		} catch (error: unknown) {
			if (params.abortSignal?.aborted) {
				throw error;
			}
			const reason: string = error instanceof Error ? error.message : "图片识别失败";
			input.onProgress?.({
				status: "error",
				title: "场景视图解释不可用",
				details: reason,
				code: "scene_view.analysis.unavailable"
			});
			return createUnavailableResult(attachment, capture, reason);
		}
	};

	return {
		enricher,
		getCapturedAttachments: (): AdditionalContextItem[] => [...capturedAttachments]
	};
}
