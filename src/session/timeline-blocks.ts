import type { ChatMessage } from "../protocol/types.js";
import type { StoredMessage, StoredSession, StoredSessionEvent } from "./session-store.js";

export type TimelineUserBlock = {
	id: string;
	type: "user";
	requestId: string;
	content: string;
	sentAtUtc: string;
	additionalContext?: ChatMessage["additionalContext"] | undefined;
	renderHints?: TimelineRenderHints | undefined;
};

export type TimelineAssistantBlock = {
	id: string;
	type: "assistant";
	requestId: string;
	content: string;
	startedAtUtc: string;
	completedAtUtc: string;
	status?: "failed" | undefined;
	bodyParts: TimelineBodyPart[];
	renderHints?: TimelineRenderHints | undefined;
};

export type TimelineBlock = TimelineUserBlock | TimelineAssistantBlock;

export type TimelineRenderHints = {
	estimatedHeight: number;
	contentChars: number;
	bodyPartCount: number;
	heavyPartCount: number;
};

export type TimelineMarkdownPart = {
	type: "markdown";
	text: string;
};

export type TimelineThinkingPart = {
	type: "thinking";
	text: string;
	done: boolean;
};

export type TimelineToolPart = {
	type: "tool";
	tool_call_id: string;
	events: Record<string, unknown>[];
};

export type TimelinePlanRecommendedReply = {
	label: string;
	text: string;
	description?: string | undefined;
};

export type TimelinePlanClarification = {
	planId: string;
	title: string;
	question: string;
	recommendedReplies: TimelinePlanRecommendedReply[];
};

export type TimelinePlanApproval = {
	planId: string;
	title: string;
	status: string;
	previewMarkdown: string;
	updatedAt: string;
};

export type TimelineSummaryStartPart = {
	type: "summary_start";
	runId: string;
	stepId: string;
	stepRunId: string;
	title: string;
	foldTitle: string;
};

export type TimelineStatusPart = {
	type: "status";
	status: string;
	title: string;
	details: string;
	actionLabel: string;
	actionId: string;
	code: string;
	iconUid: string;
	planId: string;
	recommendedReplies?: TimelinePlanRecommendedReply[] | undefined;
};

export type TimelinePlanPart = {
	type: "plan";
	planId: string;
	title: string;
	status: string;
	previewMarkdown: string;
};

export type TimelineInlineDiffPart = {
	type: "inline_diff";
	sessionId: string;
	batchIds: string[];
	editedFileCount: number;
	additions: number;
	deletions: number;
	undoable: boolean;
	editedFiles: Record<string, unknown>[];
};

export type TimelineImageGenerationPart = {
	type: "image_generation";
	status: "running" | "completed" | "failed";
	prompt: string;
	toolCallId?: string | undefined;
	artifacts?: Record<string, unknown>[] | undefined;
	provider?: string | undefined;
	model?: string | undefined;
	error?: string | undefined;
};

export type TimelineBodyPart =
	| TimelineMarkdownPart
	| TimelineThinkingPart
	| TimelineToolPart
	| TimelineSummaryStartPart
	| TimelineStatusPart
	| TimelinePlanPart
	| TimelineInlineDiffPart
	| TimelineImageGenerationPart;

export type TimelineBuildResult = {
	blocks: TimelineBlock[];
	eventCount: number;
	latestWorkflowSnapshot: unknown | null;
	latestAgentSnapshot: unknown | null;
	latestPlanClarification: TimelinePlanClarification | null;
	latestPlanApproval: TimelinePlanApproval | null;
};

type RequestEvents = {
	events: StoredSessionEvent[];
	firstEventAt: string;
	lastEventAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asBoolean(value: unknown, fallback: boolean = false): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
	return { ...value };
}

function getEventData(event: StoredSessionEvent): Record<string, unknown> {
	return isRecord(event.data) ? cloneRecord(event.data) : {};
}

function compareEvents(left: StoredSessionEvent, right: StoredSessionEvent): number {
	const timeCompare: number = left.createdAt.localeCompare(right.createdAt);
	if (timeCompare !== 0) {
		return timeCompare;
	}

	return left.id.localeCompare(right.id);
}

function collectRequestAliases(events: StoredSessionEvent[]): Map<string, string> {
	const aliases: Map<string, string> = new Map();
	for (const event of events) {
		if (!event.event.startsWith("plan.") || event.event === "plan.execution.started") {
			continue;
		}

		const data: Record<string, unknown> = getEventData(event);
		const canonicalRequestId: string = asString(data.requestId).trim();
		if (event.requestId.length > 0 && canonicalRequestId.length > 0 && event.requestId !== canonicalRequestId) {
			aliases.set(event.requestId, canonicalRequestId);
		}
	}

	return aliases;
}

function normalizeEventRequestId(event: StoredSessionEvent, aliases: Map<string, string>): StoredSessionEvent {
	const canonicalRequestId: string | undefined = aliases.get(event.requestId);
	if (canonicalRequestId === undefined) {
		return event;
	}

	return {
		...event,
		requestId: canonicalRequestId
	};
}

function collectRequestEvents(events: StoredSessionEvent[]): Map<string, RequestEvents> {
	const aliases: Map<string, string> = collectRequestAliases(events);
	const grouped: Map<string, RequestEvents> = new Map();

	for (const sourceEvent of events) {
		const event: StoredSessionEvent = normalizeEventRequestId(sourceEvent, aliases);
		if (event.requestId.length === 0) {
			continue;
		}

		const existing: RequestEvents | undefined = grouped.get(event.requestId);
		if (existing === undefined) {
			grouped.set(event.requestId, {
				events: [event],
				firstEventAt: event.createdAt,
				lastEventAt: event.createdAt
			});
			continue;
		}

		existing.events.push(event);
		if (event.createdAt < existing.firstEventAt) {
			existing.firstEventAt = event.createdAt;
		}
		if (event.createdAt > existing.lastEventAt) {
			existing.lastEventAt = event.createdAt;
		}
	}

	for (const requestEvents of grouped.values()) {
		requestEvents.events.sort(compareEvents);
	}

	return grouped;
}

function appendMarkdownPart(parts: TimelineBodyPart[], text: string): void {
	if (text.length === 0) {
		return;
	}

	const lastPart: TimelineBodyPart | undefined = parts[parts.length - 1];
	if (lastPart?.type === "markdown") {
		lastPart.text += text;
		return;
	}

	parts.push({ type: "markdown", text });
}

function appendThinkingPart(parts: TimelineBodyPart[], text: string, done: boolean): void {
	for (let index: number = parts.length - 1; index >= 0; index -= 1) {
		const part: TimelineBodyPart = parts[index]!;
		if (part.type !== "thinking" || part.done) {
			continue;
		}

		if (text.length > 0) {
			part.text += text;
		}
		if (done) {
			part.done = true;
		}
		return;
	}

	parts.push({ type: "thinking", text, done });
}

function normalizeToolEventData(eventName: string, eventData: Record<string, unknown>, eventRecordId: string): Record<string, unknown> {
	const normalizedData: Record<string, unknown> = cloneRecord(eventData);
	if (eventName.startsWith("agent.tool.")) {
		normalizedData.type = eventName.replace("agent.tool.", "tool.");
	} else if (normalizedData.type === undefined) {
		normalizedData.type = eventName;
	}
	normalizedData._eventRecordId = eventRecordId;
	return normalizedData;
}

function getToolCallKey(eventData: Record<string, unknown>, requestId: string): string {
	const toolCallId: string = asString(eventData.toolCallId);
	const approvalId: string = asString(eventData.approvalId);
	const baseKey: string = toolCallId.length > 0
		? toolCallId
		: approvalId.length > 0
			? approvalId
			: `${asString(eventData.toolName) || "tool"}-${asNumber(eventData.step)}`;
	return requestId.length > 0 ? `${requestId}:${baseKey}` : baseKey;
}

function toolPartMatchesEvent(part: TimelineToolPart, toolCallKey: string, eventData: Record<string, unknown>): boolean {
	if (part.tool_call_id === toolCallKey) {
		return true;
	}

	const toolCallId: string = asString(eventData.toolCallId);
	const approvalId: string = asString(eventData.approvalId);
	return part.events.some((event: Record<string, unknown>): boolean => {
		if (toolCallId.length > 0 && asString(event.toolCallId) === toolCallId) {
			return true;
		}
		if (approvalId.length > 0 && asString(event.approvalId) === approvalId) {
			return true;
		}
		return false;
	});
}

function appendToolPart(parts: TimelineBodyPart[], eventData: Record<string, unknown>, requestId: string): void {
	const toolCallKey: string = getToolCallKey(eventData, requestId);
	for (const part of parts) {
		if (part.type === "tool" && toolPartMatchesEvent(part, toolCallKey, eventData)) {
			const eventRecordId: string = asString(eventData._eventRecordId);
			if (eventRecordId.length > 0 && part.events.some((event: Record<string, unknown>): boolean => event._eventRecordId === eventRecordId)) {
				return;
			}
			part.events.push(cloneRecord(eventData));
			return;
		}
	}

	parts.push({
		type: "tool",
		tool_call_id: toolCallKey,
		events: [cloneRecord(eventData)]
	});
}

function extractImageGenerationPrompt(eventData: Record<string, unknown>): string {
	const args: unknown = eventData.args;
	if (isRecord(args)) {
		return asString(args.prompt);
	}
	const imageGeneration: unknown = eventData.imageGeneration;
	if (isRecord(imageGeneration)) {
		return asString(imageGeneration.prompt);
	}
	return "";
}

function appendImageGenerationPart(parts: TimelineBodyPart[], eventData: Record<string, unknown>, requestId: string): void {
	if (asString(eventData.toolName) !== "mcp_image_generate") {
		return;
	}

	const toolCallId: string = getToolCallKey(eventData, requestId);
	const eventType: string = asString(eventData.type);
	let nextPart: TimelineImageGenerationPart | null = null;

	if (eventType === "tool.call" || eventType === "agent.tool.call") {
		nextPart = {
			type: "image_generation",
			status: "running",
			toolCallId,
			prompt: extractImageGenerationPrompt(eventData)
		};
	} else if (eventType === "tool.result" || eventType === "agent.tool.result") {
		const imageGeneration: unknown = eventData.imageGeneration;
		if (!isRecord(imageGeneration)) {
			return;
		}
		const artifactsValue: unknown = imageGeneration.artifacts;
		nextPart = {
			type: "image_generation",
			status: "completed",
			toolCallId,
			prompt: asString(imageGeneration.prompt) || extractImageGenerationPrompt(eventData),
			provider: asString(imageGeneration.provider),
			model: asString(imageGeneration.model),
			artifacts: Array.isArray(artifactsValue)
				? artifactsValue.filter(isRecord).map(cloneRecord)
				: []
		};
	} else if (eventType === "tool.error" || eventType === "agent.tool.error") {
		nextPart = {
			type: "image_generation",
			status: "failed",
			toolCallId,
			prompt: extractImageGenerationPrompt(eventData),
			error: asString(eventData.message)
		};
	}

	if (nextPart === null) {
		return;
	}

	for (let index: number = parts.length - 1; index >= 0; index -= 1) {
		const part: TimelineBodyPart = parts[index]!;
		if (part.type === "image_generation" && part.toolCallId === toolCallId) {
			if (nextPart.prompt.length === 0) {
				nextPart.prompt = part.prompt;
			}
			parts[index] = nextPart;
			return;
		}
	}

	parts.push(nextPart);
}

function appendSummaryStartPart(parts: TimelineBodyPart[], eventData: Record<string, unknown>): void {
	const runId: string = asString(eventData.runId);
	const stepId: string = asString(eventData.stepId);
	const stepRunId: string = asString(eventData.stepRunId);
	if (runId.length === 0 || stepRunId.length === 0) {
		return;
	}
	if (parts.some((part: TimelineBodyPart): boolean => part.type === "summary_start" && part.stepRunId === stepRunId)) {
		return;
	}

	parts.push({
		type: "summary_start",
		runId,
		stepId,
		stepRunId,
		title: asString(eventData.title),
		foldTitle: asString(eventData.foldTitle) || "总结前的过程"
	});
}

function appendStatusPart(parts: TimelineBodyPart[], statusData: Partial<TimelineStatusPart>): void {
	parts.push({
		type: "status",
		status: statusData.status ?? "message",
		title: statusData.title ?? "",
		details: statusData.details ?? "",
		actionLabel: statusData.actionLabel ?? "",
		actionId: statusData.actionId ?? "",
		code: statusData.code ?? "",
		iconUid: statusData.iconUid ?? "",
		planId: statusData.planId ?? "",
		recommendedReplies: statusData.recommendedReplies
	});
}

function parsePlanRecommendedReplies(value: unknown): TimelinePlanRecommendedReply[] {
	if (!Array.isArray(value)) {
		return [];
	}

	const replies: TimelinePlanRecommendedReply[] = [];
	for (const item of value.slice(0, 3)) {
		if (!isRecord(item)) {
			continue;
		}
		const label: string = asString(item.label).trim();
		const text: string = asString(item.text).trim();
		const description: string = asString(item.description).trim();
		if (label.length === 0 || text.length === 0) {
			continue;
		}
		replies.push({
			label,
			text,
			description: description.length > 0 ? description : undefined
		});
	}
	return replies;
}

function createPlanClarificationSnapshot(data: Record<string, unknown>): TimelinePlanClarification | null {
	const planId: string = asString(data.planId).trim();
	const question: string = asString(data.question).trim();
	if (planId.length === 0 || question.length === 0) {
		return null;
	}

	const title: string = asString(data.title).trim();
	return {
		planId,
		title: title.length > 0 ? title : "Plan clarification",
		question,
		recommendedReplies: parsePlanRecommendedReplies(data.recommendedReplies)
	};
}

function createPlanPart(eventData: Record<string, unknown>): TimelinePlanPart | null {
	const planId: string = asString(eventData.planId).trim();
	if (planId.length === 0) {
		return null;
	}

	return {
		type: "plan",
		planId,
		title: asString(eventData.title) || "Plan",
		status: asString(eventData.status),
		previewMarkdown: asString(eventData.previewMarkdown) || asString(eventData.markdown)
	};
}

function replaceOrAppendPlanPart(parts: TimelineBodyPart[], planPart: TimelinePlanPart): void {
	const existingIndex: number = parts.findIndex((part: TimelineBodyPart): boolean => {
		return part.type === "plan" && part.planId === planPart.planId;
	});

	if (existingIndex < 0) {
		parts.push(planPart);
		return;
	}

	parts[existingIndex] = planPart;
}

function createPlanApprovalSnapshot(eventData: Record<string, unknown>): TimelinePlanApproval | null {
	const planPart: TimelinePlanPart | null = createPlanPart(eventData);
	if (planPart === null || planPart.status !== "ready") {
		return null;
	}

	return {
		planId: planPart.planId,
		title: planPart.title,
		status: planPart.status,
		previewMarkdown: planPart.previewMarkdown,
		updatedAt: asString(eventData.updatedAt)
	};
}

function getFileEditKey(fileSummary: Record<string, unknown>): string {
	const absolutePath: string = asString(fileSummary.absolutePath);
	if (absolutePath.length > 0) {
		return absolutePath.replaceAll("\\", "/").toLowerCase();
	}

	return asString(fileSummary.path).replaceAll("\\", "/").toLowerCase();
}

function formatFileEditDisplayPath(fileSummary: Record<string, unknown>): string {
	const pathText: string = asString(fileSummary.path).replaceAll("\\", "/");
	const absolutePath: string = asString(fileSummary.absolutePath).replaceAll("\\", "/");
	const workspaceRoot: string = asString(fileSummary.workspaceRoot).replaceAll("\\", "/").replace(/\/+$/u, "");
	if (absolutePath.length > 0 && workspaceRoot.length > 0) {
		const rootPrefix: string = `${workspaceRoot}/`;
		if (absolutePath.toLowerCase().startsWith(rootPrefix.toLowerCase())) {
			return absolutePath.slice(rootPrefix.length);
		}
	}
	if (pathText.length > 0) {
		return pathText;
	}
	return absolutePath;
}

function appendFileEditBatch(fileEditBatches: Record<string, unknown>[], eventData: Record<string, unknown>): void {
	const batch: unknown = eventData.fileEditBatch;
	if (!isRecord(batch) || asString(batch.batchId).length === 0) {
		return;
	}
	fileEditBatches.push(cloneRecord(batch));
}

function createInlineDiffPart(sessionId: string, fileEditBatches: Record<string, unknown>[]): TimelineInlineDiffPart | null {
	if (fileEditBatches.length === 0) {
		return null;
	}

	const batchIds: string[] = [];
	const editedFilesByKey: Map<string, Record<string, unknown>> = new Map();
	const editedFileKeys: string[] = [];
	let undoable: boolean = true;

	for (const batch of fileEditBatches) {
		const batchId: string = asString(batch.batchId);
		if (batchId.length === 0 || batchIds.includes(batchId)) {
			continue;
		}
		batchIds.push(batchId);

		const editedFiles: unknown = batch.editedFiles;
		if (!Array.isArray(editedFiles)) {
			continue;
		}

		for (const fileValue of editedFiles) {
			if (!isRecord(fileValue)) {
				continue;
			}

			const fileSummary: Record<string, unknown> = cloneRecord(fileValue);
			const fileAdditions: number = asNumber(fileSummary.additions);
			const fileDeletions: number = asNumber(fileSummary.deletions);
			const fileKey: string = getFileEditKey(fileSummary);
			if (fileKey.length === 0) {
				continue;
			}

			if (!editedFilesByKey.has(fileKey)) {
				fileSummary.displayPath = formatFileEditDisplayPath(fileSummary);
				fileSummary.additions = 0;
				fileSummary.deletions = 0;
				editedFilesByKey.set(fileKey, fileSummary);
				editedFileKeys.push(fileKey);
			}

			const mergedFile: Record<string, unknown> = editedFilesByKey.get(fileKey)!;
			mergedFile.additions = asNumber(mergedFile.additions) + fileAdditions;
			mergedFile.deletions = asNumber(mergedFile.deletions) + fileDeletions;
			mergedFile.existsAfter = asBoolean(fileSummary.existsAfter, asBoolean(mergedFile.existsAfter));
			mergedFile.afterSha256 = asString(fileSummary.afterSha256) || asString(mergedFile.afterSha256);
			mergedFile.undoable = asBoolean(mergedFile.undoable, true) && asBoolean(fileSummary.undoable, true);
		}
	}

	if (batchIds.length === 0 || editedFileKeys.length === 0) {
		return null;
	}

	const editedFiles: Record<string, unknown>[] = [];
	let additions: number = 0;
	let deletions: number = 0;
	for (const fileKey of editedFileKeys) {
		const editedFile: Record<string, unknown> = editedFilesByKey.get(fileKey)!;
		additions += asNumber(editedFile.additions);
		deletions += asNumber(editedFile.deletions);
		undoable = undoable && asBoolean(editedFile.undoable, true);
		editedFiles.push(editedFile);
	}

	return {
		type: "inline_diff",
		sessionId,
		batchIds,
		editedFileCount: editedFiles.length,
		additions,
		deletions,
		undoable,
		editedFiles
	};
}

function createRunErrorStatus(eventData: Record<string, unknown>): Partial<TimelineStatusPart> {
	return {
		status: "error",
		title: "后端返回错误",
		details: asString(eventData.message) || "Unknown backend error",
		code: asString(eventData.code) || "agent_run_error"
	};
}

function createFailedMessageStatus(message: StoredMessage): Partial<TimelineStatusPart> | null {
	if (message.status !== "failed") {
		return null;
	}

	const errorValue: unknown = message.error;
	const errorRecord: Record<string, unknown> = isRecord(errorValue) ? errorValue : {};
	return {
		status: "error",
		title: "后端返回错误",
		details: asString(errorRecord.message) || "Unknown backend error",
		code: asString(errorRecord.code) || "agent_run_error"
	};
}

function buildAssistantBodyParts(
	sessionId: string,
	events: StoredSessionEvent[],
	messageContent: string,
	requestId: string,
	assistantMessage?: StoredMessage | undefined
): TimelineBodyPart[] {
	const parts: TimelineBodyPart[] = [];
	const fileEditBatches: Record<string, unknown>[] = [];
	let hasMarkdownDelta: boolean = false;
	let hasErrorStatus: boolean = false;
	const recordsHaveMarkdownDelta: boolean = events.some((event: StoredSessionEvent): boolean => event.event === "ai.delta" || event.event === "agent.message.delta");

	if (!recordsHaveMarkdownDelta && messageContent.length > 0) {
		appendMarkdownPart(parts, messageContent);
	}

	for (const event of events) {
		const eventData: Record<string, unknown> = getEventData(event);
		if (eventData.type === undefined) {
			eventData.type = event.event;
		}
		eventData._eventRecordId = event.id;

		if (event.event === "ai.delta" || event.event === "agent.message.delta") {
			const deltaText: string = asString(eventData.text);
			if (deltaText.length > 0) {
				appendMarkdownPart(parts, deltaText);
				hasMarkdownDelta = true;
			}
		} else if (event.event.startsWith("tool.") || event.event.startsWith("agent.tool.")) {
			const normalizedToolEvent: Record<string, unknown> = normalizeToolEventData(event.event, eventData, event.id);
			appendToolPart(parts, normalizedToolEvent, requestId);
			appendImageGenerationPart(parts, normalizedToolEvent, requestId);
			appendFileEditBatch(fileEditBatches, normalizedToolEvent);
		} else if (event.event === "agent.summary.started") {
			appendSummaryStartPart(parts, eventData);
		} else if (event.event === "ai.thinking.delta" || event.event === "agent.thinking.delta") {
			appendThinkingPart(parts, asString(eventData.text), false);
		} else if (event.event === "ai.thinking.done" || event.event === "agent.thinking.done") {
			appendThinkingPart(parts, "", true);
		} else if (event.event === "ai.status") {
			appendStatusPart(parts, {
				status: asString(eventData.status) || "message",
				title: asString(eventData.title),
				details: asString(eventData.details) || asString(eventData.detail),
				actionLabel: asString(eventData.actionLabel) || asString(eventData.action_label),
				actionId: asString(eventData.actionId) || asString(eventData.action_id),
				code: asString(eventData.code),
				iconUid: asString(eventData.iconUid) || asString(eventData.icon_uid),
				planId: asString(eventData.planId)
			});
		} else if (event.event === "agent.run.error" || event.event === "workflow.error") {
			appendStatusPart(parts, createRunErrorStatus(eventData));
			hasErrorStatus = true;
		} else if (event.event === "plan.generated" || event.event === "plan.revised") {
			const planPart: TimelinePlanPart | null = createPlanPart(eventData);
			if (planPart !== null) {
				replaceOrAppendPlanPart(parts, planPart);
			}
		} else if (event.event === "plan.approved") {
			appendStatusPart(parts, {
				status: "success",
				title: "计划已批准",
				details: asString(eventData.title),
				code: "plan.approved",
				planId: asString(eventData.planId)
			});
		}
	}

	if (!hasMarkdownDelta && recordsHaveMarkdownDelta && messageContent.length > 0) {
		appendMarkdownPart(parts, messageContent);
	}

	if (!hasErrorStatus && assistantMessage !== undefined) {
		const failedStatus: Partial<TimelineStatusPart> | null = createFailedMessageStatus(assistantMessage);
		if (failedStatus !== null) {
			appendStatusPart(parts, failedStatus);
		}
	}

	const inlineDiffPart: TimelineInlineDiffPart | null = createInlineDiffPart(sessionId, fileEditBatches);
	if (inlineDiffPart !== null) {
		parts.push(inlineDiffPart);
	}

	return parts;
}

function createUserBlock(message: StoredMessage): TimelineUserBlock {
	const requestId: string = message.requestId ?? "";
	return {
		id: `message:${requestId}:user:${message.createdAt}`,
		type: "user",
		requestId,
		content: message.content,
		sentAtUtc: message.createdAt,
		additionalContext: message.additionalContext
	};
}

function createAssistantBlock(
	sessionId: string,
	requestId: string,
	content: string,
	startedAtUtc: string,
	completedAtUtc: string,
	events: StoredSessionEvent[],
	assistantMessage?: StoredMessage | undefined
): TimelineAssistantBlock {
	const messageCreatedAt: string = assistantMessage?.createdAt ?? completedAtUtc;
	return {
		id: assistantMessage !== undefined
			? `message:${requestId}:assistant:${messageCreatedAt}`
			: `assistant-events:${requestId}:${completedAtUtc}`,
		type: "assistant",
		requestId,
		content,
		startedAtUtc,
		completedAtUtc,
		status: assistantMessage?.status === "failed" ? "failed" : undefined,
		bodyParts: buildAssistantBodyParts(sessionId, events, content, requestId, assistantMessage)
	};
}

function getRequestEvents(groupedEvents: Map<string, RequestEvents>, requestId: string): StoredSessionEvent[] {
	return groupedEvents.get(requestId)?.events ?? [];
}

function getRequestFirstEventAt(groupedEvents: Map<string, RequestEvents>, requestId: string): string {
	return groupedEvents.get(requestId)?.firstEventAt ?? "";
}

function getRequestLastEventAt(groupedEvents: Map<string, RequestEvents>, requestId: string): string {
	return groupedEvents.get(requestId)?.lastEventAt ?? "";
}

function collectAssistantRequestIds(messages: StoredMessage[]): Set<string> {
	const ids: Set<string> = new Set();
	for (const message of messages) {
		if (message.role === "assistant" && message.requestId !== undefined && message.requestId.length > 0) {
			ids.add(message.requestId);
		}
	}
	return ids;
}

function getSnapshotTodoIdentity(snapshot: unknown): string | null {
	if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
		return null;
	}

	const record = snapshot as { workflowId?: unknown; runId?: unknown };
	if (typeof record.workflowId === "string" && record.workflowId.length > 0) {
		return record.workflowId;
	}
	if (typeof record.runId === "string" && record.runId.length > 0) {
		return record.runId;
	}

	return null;
}

function getDismissedTodoIdentity(data: unknown): string | null {
	return getSnapshotTodoIdentity(data);
}

function shouldClearDismissedSnapshot(snapshot: unknown | null, dismissedIdentity: string | null): boolean {
	if (snapshot === null) {
		return false;
	}
	if (dismissedIdentity === null) {
		return true;
	}

	const snapshotIdentity: string | null = getSnapshotTodoIdentity(snapshot);
	return snapshotIdentity === null || snapshotIdentity === dismissedIdentity;
}

function findLatestSnapshots(events: StoredSessionEvent[]): { latestWorkflowSnapshot: unknown | null; latestAgentSnapshot: unknown | null; latestPlanClarification: TimelinePlanClarification | null; latestPlanApproval: TimelinePlanApproval | null } {
	let latestWorkflowSnapshot: unknown | null = null;
	let latestAgentSnapshot: unknown | null = null;
	let latestPlanClarification: TimelinePlanClarification | null = null;
	let latestPlanApproval: TimelinePlanApproval | null = null;
	for (const event of events) {
		if (event.event === "workflow.todo.updated") {
			latestWorkflowSnapshot = event.data;
		}
		if (event.event === "agent.run.snapshot") {
			latestAgentSnapshot = event.data;
		}
		if (event.event === "plan.clarification.required" && isRecord(event.data)) {
			latestPlanClarification = createPlanClarificationSnapshot(event.data);
			latestPlanApproval = null;
		}
		if ((event.event === "plan.generated" || event.event === "plan.revised") && isRecord(event.data)) {
			latestPlanApproval = createPlanApprovalSnapshot(event.data);
		}
		if ((event.event === "plan.generated" || event.event === "plan.revised" || event.event === "plan.approved" || event.event === "plan.execution.started") && isRecord(event.data)) {
			const planId: string = asString(event.data.planId);
			if (planId.length === 0 || planId === latestPlanClarification?.planId) {
				latestPlanClarification = null;
			}
			if ((event.event === "plan.approved" || event.event === "plan.execution.started") && (planId.length === 0 || planId === latestPlanApproval?.planId)) {
				latestPlanApproval = null;
			}
		}
		if (event.event === "workflow.todo.dismissed") {
			const dismissedIdentity: string | null = getDismissedTodoIdentity(event.data);
			if (shouldClearDismissedSnapshot(latestWorkflowSnapshot, dismissedIdentity)) {
				latestWorkflowSnapshot = null;
			}
			if (shouldClearDismissedSnapshot(latestAgentSnapshot, dismissedIdentity)) {
				latestAgentSnapshot = null;
			}
		}
	}

	return { latestWorkflowSnapshot, latestAgentSnapshot, latestPlanClarification, latestPlanApproval };
}

function withRenderHints(block: TimelineBlock): TimelineBlock {
	return {
		...block,
		renderHints: createRenderHints(block)
	};
}

function createRenderHints(block: TimelineBlock): TimelineRenderHints {
	if (block.type === "user") {
		const contextCount: number = block.additionalContext?.length ?? 0;
		const textRows: number = Math.max(1, Math.ceil(block.content.length / 72));
		return {
			estimatedHeight: Math.max(88, 44 + textRows * 20 + contextCount * 32),
			contentChars: block.content.length,
			bodyPartCount: 0,
			heavyPartCount: contextCount
		};
	}

	let contentChars: number = block.content.length;
	let heavyPartCount: number = 0;
	for (const part of block.bodyParts) {
		if (part.type === "markdown" || part.type === "thinking") {
			contentChars += part.text.length;
		}
		if (part.type === "tool") {
			heavyPartCount += Math.max(1, part.events.length);
		} else if (part.type === "thinking" || part.type === "inline_diff" || part.type === "plan" || part.type === "image_generation") {
			heavyPartCount += 1;
		}
	}

	const textRows: number = Math.max(1, Math.ceil(contentChars / 80));
	return {
		estimatedHeight: Math.max(140, 64 + textRows * 18 + block.bodyParts.length * 34 + heavyPartCount * 20),
		contentChars,
		bodyPartCount: block.bodyParts.length,
		heavyPartCount
	};
}

export function buildCanonicalTimelineBlocks(session: StoredSession): TimelineBuildResult {
	const sourceEvents: StoredSessionEvent[] = [...session.events].sort(compareEvents);
	const groupedEvents: Map<string, RequestEvents> = collectRequestEvents(sourceEvents);
	const assistantRequestIds: Set<string> = collectAssistantRequestIds(session.messages);
	const consumedRequestIds: Set<string> = new Set();
	const blocks: TimelineBlock[] = [];
	const requestStartedAt: Map<string, string> = new Map();

	for (const message of session.messages) {
		const requestId: string = message.requestId ?? "";
		if (message.role === "user") {
			blocks.push(createUserBlock(message));
			if (requestId.length > 0) {
				requestStartedAt.set(requestId, message.createdAt);
				if (!assistantRequestIds.has(requestId) && groupedEvents.has(requestId)) {
					blocks.push(createAssistantBlock(
						session.metadata.id,
						requestId,
						"",
						message.createdAt,
						getRequestLastEventAt(groupedEvents, requestId),
						getRequestEvents(groupedEvents, requestId)
					));
					consumedRequestIds.add(requestId);
				}
			}
			continue;
		}

		if (message.role === "assistant") {
			const events: StoredSessionEvent[] = requestId.length > 0 ? getRequestEvents(groupedEvents, requestId) : [];
			blocks.push(createAssistantBlock(
				session.metadata.id,
				requestId,
				message.content,
				requestStartedAt.get(requestId) ?? getRequestFirstEventAt(groupedEvents, requestId),
				message.createdAt,
				events,
				message
			));
			if (requestId.length > 0) {
				consumedRequestIds.add(requestId);
			}
		}
	}

	for (const [requestId, requestEvents] of groupedEvents.entries()) {
		if (consumedRequestIds.has(requestId)) {
			continue;
		}

		blocks.push(createAssistantBlock(
			session.metadata.id,
			requestId,
			"",
			requestEvents.firstEventAt,
			requestEvents.lastEventAt,
			requestEvents.events
		));
	}

	const snapshots = findLatestSnapshots(sourceEvents);
	return {
		blocks: blocks.map(withRenderHints),
		eventCount: sourceEvents.length,
		latestWorkflowSnapshot: snapshots.latestWorkflowSnapshot,
		latestAgentSnapshot: snapshots.latestAgentSnapshot,
		latestPlanClarification: snapshots.latestPlanClarification,
		latestPlanApproval: snapshots.latestPlanApproval
	};
}
