import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDefaultArchivedSessionsDir, getDefaultSessionsDir } from "../app-paths.js";
import { writeJsonFileAtomic } from "../json-file-store.js";
import type { ChatMessage } from "../protocol/types.js";
import type { WorkspaceConfig } from "../workspace/types.js";
import { buildCanonicalTimelineBlocks, type TimelineBlock, type TimelinePlanApproval, type TimelinePlanClarification } from "./timeline-blocks.js";

const SESSIONS_DIR: string = getDefaultSessionsDir();
const ARCHIVED_SESSIONS_DIR: string = getDefaultArchivedSessionsDir();
const SESSION_ID_PATTERN: RegExp = /^session-[a-zA-Z0-9_-]+$/;

export type SessionChatMode = "agent" | "ask" | "plan";

let ensureSessionsDirPromise: Promise<void> | null = null;
let ensureArchivedSessionsDirPromise: Promise<void> | null = null;

export type SessionMetadata = {
	id: string;
	title: string;
	workspaceId?: string | undefined;
	workspaceName?: string | undefined;
	workspaceKind?: "godot" | undefined;
	workspaceRoot?: string | undefined;
	godotExecutablePath?: string | undefined;
	activeSkillId?: string | undefined;
	provider?: string | undefined;
	model?: string | undefined;
	chatMode?: SessionChatMode | undefined;
	approvalMode?: "manual" | "auto-safe" | "full-trust" | undefined;
	workflowTodoCollapsed?: boolean | undefined;
	webSearchEnabled?: boolean | undefined;
	archivedAt?: string | undefined;
	createdAt: string;
	updatedAt: string;
};

export type StoredMessage = ChatMessage & {
	createdAt: string;
};

export type StoredSessionEvent = {
	id: string;
	requestId: string;
	event: string;
	data: unknown;
	createdAt: string;
};

export type StoredApprovalEvent = {
	id: string;
	schemaVersion: 1;
	approvalId: string;
	requestId: string;
	event: string;
	data: unknown;
	createdAt: string;
};

export type StoredWorkflowEvent = {
	id: string;
	schemaVersion: 1;
	workflowId: string;
	requestId: string;
	event: string;
	data: unknown;
	createdAt: string;
};

export type StoredAgentEvent = {
	id: string;
	schemaVersion: 1;
	runId: string;
	requestId: string;
	event: string;
	data: unknown;
	createdAt: string;
};

export type StoredSession = {
	metadata: SessionMetadata;
	messages: StoredMessage[];
	events: StoredSessionEvent[];
};

export type StoredSessionTimelinePage = {
	metadata: SessionMetadata;
	messages: StoredMessage[];
	timelineBlocks: TimelineBlock[];
	blockCount: number;
	blockOffset: number;
	eventCount: number;
	hasMoreBefore: boolean;
	hasMoreAfter: boolean;
	latestWorkflowSnapshot: unknown | null;
	latestAgentSnapshot: unknown | null;
	latestPlanClarification: TimelinePlanClarification | null;
	latestPlanApproval: TimelinePlanApproval | null;
};

type TimelineCacheEntry = {
	key: string;
	result: ReturnType<typeof buildCanonicalTimelineBlocks>;
};

const timelineCacheBySessionId: Map<string, TimelineCacheEntry> = new Map();
const transcriptWriteQueuesBySessionId: Map<string, Promise<void>> = new Map();

type RewindableEvent = {
	requestId: string;
	createdAt: string;
};

type StoredEventFileKind = "messages" | "events" | "approval-events" | "workflow-events" | "agent-events";

export type SessionIntegrityIssue = {
	file: StoredEventFileKind;
	line: number;
	expectedSessionId: string;
	actualSessionId: string;
	requestId?: string | undefined;
	event?: string | undefined;
};

export type SessionIntegrityCheckResult = {
	sessionId: string;
	ok: boolean;
	issues: SessionIntegrityIssue[];
	checkedFiles: StoredEventFileKind[];
};

type TranscriptUpdate<T> = {
	messages: ChatMessage[];
	metadata?: Partial<SessionMetadata> | undefined;
	result: T;
};

export type SessionSummary = {
	content: string;
	messageCount: number;
	tokenEstimate: number;
	generatedAt: string;
};

function assertSafeSessionId(sessionId: string): string {
	if (!SESSION_ID_PATTERN.test(sessionId)) {
		throw new Error(`Invalid session id: ${sessionId}`);
	}

	return sessionId;
}

export function getSessionDir(sessionId: string): string {
	return join(SESSIONS_DIR, assertSafeSessionId(sessionId));
}

function invalidateTimelineCache(sessionId: string): void {
	timelineCacheBySessionId.delete(assertSafeSessionId(sessionId));
}

async function enqueueTranscriptWrite<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
	const safeSessionId: string = assertSafeSessionId(sessionId);
	const previousWrite: Promise<void> = transcriptWriteQueuesBySessionId.get(safeSessionId) ?? Promise.resolve();
	const nextWrite: Promise<T> = previousWrite.then(operation, operation);
	const queuedWrite: Promise<void> = nextWrite.then(
		(): void => undefined,
		(): void => undefined
	);
	transcriptWriteQueuesBySessionId.set(safeSessionId, queuedWrite);

	try {
		return await nextWrite;
	} finally {
		if (transcriptWriteQueuesBySessionId.get(safeSessionId) === queuedWrite) {
			transcriptWriteQueuesBySessionId.delete(safeSessionId);
		}
	}
}

function getArchivedSessionDir(sessionId: string): string {
	return join(ARCHIVED_SESSIONS_DIR, assertSafeSessionId(sessionId));
}

async function ensureSessionsDir(): Promise<void> {
	if (!ensureSessionsDirPromise) {
		ensureSessionsDirPromise = (async (): Promise<void> => {
			await mkdir(SESSIONS_DIR, { recursive: true });
		})();
	}

	await ensureSessionsDirPromise;
}

async function ensureArchivedSessionsDir(): Promise<void> {
	if (!ensureArchivedSessionsDirPromise) {
		ensureArchivedSessionsDirPromise = (async (): Promise<void> => {
			await mkdir(ARCHIVED_SESSIONS_DIR, { recursive: true });
		})();
	}

	await ensureArchivedSessionsDirPromise;
}

async function createSessionDir(sessionId: string): Promise<string> {
	await ensureSessionsDir();
	const dir: string = getSessionDir(sessionId);
	await mkdir(dir, { recursive: true });
	return dir;
}

function metaPath(sessionId: string): string {
	return join(getSessionDir(sessionId), "metadata.json");
}

function archivedMetaPath(sessionId: string): string {
	return join(getArchivedSessionDir(sessionId), "metadata.json");
}

function messagesPath(sessionId: string): string {
	return join(getSessionDir(sessionId), "messages.jsonl");
}

function eventsPath(sessionId: string): string {
	return join(getSessionDir(sessionId), "events.jsonl");
}

function approvalEventsPath(sessionId: string): string {
	return join(getSessionDir(sessionId), "approval-events.jsonl");
}

function workflowEventsPath(sessionId: string): string {
	return join(getSessionDir(sessionId), "workflow-events.jsonl");
}

function agentEventsPath(sessionId: string): string {
	return join(getSessionDir(sessionId), "agent-events.jsonl");
}

export function createWorkspaceMetadataSnapshot(workspace: WorkspaceConfig | undefined): Partial<SessionMetadata> {
	if (workspace === undefined) {
		return {};
	}

	const metadata: Partial<SessionMetadata> = {
		workspaceId: workspace.id,
		workspaceName: workspace.name,
		workspaceKind: workspace.kind,
		workspaceRoot: workspace.rootPath
	};

	if (workspace.godotExecutablePath !== undefined) {
		metadata.godotExecutablePath = workspace.godotExecutablePath;
	}

	return metadata;
}

function mergeSessionMetadata(existing: SessionMetadata, metadata?: Partial<SessionMetadata>): SessionMetadata {
	const updated: SessionMetadata = {
		...existing,
		updatedAt: new Date().toISOString()
	};

	if (metadata === undefined) {
		return updated;
	}

	for (const [key, value] of Object.entries(metadata) as [keyof SessionMetadata, SessionMetadata[keyof SessionMetadata]][]) {
		if (value !== undefined) {
			updated[key] = value as never;
		}
	}

	return updated;
}

export async function createSession(
	title: string,
	workspaceId?: string,
	skillId?: string,
	workspaceSnapshot?: WorkspaceConfig | undefined,
	initialMetadata?: Partial<SessionMetadata> | undefined
): Promise<SessionMetadata> {
	const timestamp: string = new Date().toISOString();
	const dateStr: string = timestamp.slice(0, 10).replace(/-/g, "");
	const id: string = `session-${dateStr}-${Date.now().toString(36)}`;

	const metadata: SessionMetadata = {
		...initialMetadata,
		id,
		title,
		workspaceId,
		...createWorkspaceMetadataSnapshot(workspaceSnapshot),
		createdAt: timestamp,
		updatedAt: timestamp
	};

	const dir: string = await createSessionDir(id);
	await writeJsonFileAtomic(join(dir, "metadata.json"), metadata);
	await writeFile(join(dir, "messages.jsonl"), "", "utf8");
	await writeFile(join(dir, "events.jsonl"), "", "utf8");
	await writeFile(join(dir, "approval-events.jsonl"), "", "utf8");
	await writeFile(join(dir, "workflow-events.jsonl"), "", "utf8");
	await writeFile(join(dir, "agent-events.jsonl"), "", "utf8");

	return metadata;
}

function parseJsonLines<T>(rawLines: string): T[] {
	const items: T[] = [];

	for (const line of rawLines.split("\n")) {
		const trimmed: string = line.trim();
		if (trimmed.length === 0) {
			continue;
		}

		try {
			items.push(JSON.parse(trimmed) as T);
		} catch {
			// Skip corrupted lines
		}
	}

	return items;
}

async function readSessionMetadata(sessionId: string): Promise<SessionMetadata> {
	await ensureSessionsDir();
	const metaFile: string = metaPath(sessionId);

	try {
		const raw: string = await readFile(metaFile, "utf8");
		return JSON.parse(raw) as SessionMetadata;
	} catch {
		throw new Error(`Session not found: ${sessionId}`);
	}
}

async function readArchivedSessionMetadata(sessionId: string): Promise<SessionMetadata> {
	await ensureArchivedSessionsDir();
	const metaFile: string = archivedMetaPath(sessionId);

	try {
		const raw: string = await readFile(metaFile, "utf8");
		return JSON.parse(raw) as SessionMetadata;
	} catch {
		throw new Error(`Archived session not found: ${sessionId}`);
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function createTimelineCacheKey(sessionId: string): Promise<string> {
	const paths: string[] = [
		metaPath(sessionId),
		messagesPath(sessionId),
		eventsPath(sessionId),
		approvalEventsPath(sessionId),
		workflowEventsPath(sessionId),
		agentEventsPath(sessionId)
	];
	const parts: string[] = [];
	for (const filePath of paths) {
		try {
			const stats = await stat(filePath);
			parts.push(`${stats.mtimeMs}:${stats.size}`);
		} catch {
			parts.push("missing");
		}
	}
	return parts.join("|");
}

async function listSessionMetadataFromDir(rootDir: string): Promise<SessionMetadata[]> {
	const entries: string[] = await readdir(rootDir, { withFileTypes: true })
		.then((items) => items.filter((d) => d.isDirectory()).map((d) => d.name));

	const sessions: SessionMetadata[] = [];

	for (const entry of entries) {
		try {
			const raw: string = await readFile(join(rootDir, entry, "metadata.json"), "utf8");
			sessions.push(JSON.parse(raw) as SessionMetadata);
		} catch {
			// Skip invalid sessions
		}
	}

	sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	return sessions;
}

async function getCachedTimelineBuildResult(stored: StoredSession): Promise<ReturnType<typeof buildCanonicalTimelineBlocks>> {
	const sessionId: string = stored.metadata.id;
	const key: string = await createTimelineCacheKey(sessionId);
	const cached: TimelineCacheEntry | undefined = timelineCacheBySessionId.get(sessionId);
	if (cached !== undefined && cached.key === key) {
		return cached.result;
	}

	const result: ReturnType<typeof buildCanonicalTimelineBlocks> = buildCanonicalTimelineBlocks(stored);
	timelineCacheBySessionId.set(sessionId, { key, result });
	return result;
}

async function createTimelinePageFromStoredSession(stored: StoredSession, offset: number, limit: number): Promise<StoredSessionTimelinePage> {
	const timeline = await getCachedTimelineBuildResult(stored);
	const blockCount: number = timeline.blocks.length;
	const normalizedOffset: number = Math.max(0, Math.min(offset, blockCount));
	const normalizedLimit: number = Math.max(0, limit);
	const endOffset: number = Math.min(blockCount, normalizedOffset + normalizedLimit);
	const timelineBlocks: TimelineBlock[] = timeline.blocks.slice(normalizedOffset, endOffset);

	return {
		metadata: stored.metadata,
		messages: stored.messages,
		timelineBlocks,
		blockCount,
		blockOffset: normalizedOffset,
		eventCount: timeline.eventCount,
		hasMoreBefore: normalizedOffset > 0,
		hasMoreAfter: endOffset < blockCount,
		latestWorkflowSnapshot: timeline.latestWorkflowSnapshot,
		latestAgentSnapshot: timeline.latestAgentSnapshot,
		latestPlanClarification: timeline.latestPlanClarification,
		latestPlanApproval: timeline.latestPlanApproval
	};
}

export async function openSession(sessionId: string): Promise<StoredSession> {
	const metadata: SessionMetadata = await readSessionMetadata(sessionId);
	const msgFile: string = messagesPath(sessionId);

	let messages: StoredMessage[] = [];

	try {
		const rawLines: string = await readFile(msgFile, "utf8");
		messages = parseJsonLines<StoredMessage>(rawLines);
	} catch {
		// No messages yet
	}

	let events: StoredSessionEvent[] = [];

	try {
		const rawLines: string = await readFile(eventsPath(sessionId), "utf8");
		events = parseJsonLines<StoredSessionEvent>(rawLines);
	} catch {
		// No timeline events yet
	}

	return { metadata, messages, events };
}

export async function openSessionRecentTimeline(sessionId: string, limit: number): Promise<StoredSessionTimelinePage> {
	const stored: StoredSession = await openSession(sessionId);
	const timeline = await getCachedTimelineBuildResult(stored);
	const blockOffset: number = Math.max(0, timeline.blocks.length - limit);
	return createTimelinePageFromStoredSession(stored, blockOffset, limit);
}

export async function openSessionTimelinePage(sessionId: string, beforeOffset: number, limit: number): Promise<StoredSessionTimelinePage> {
	const stored: StoredSession = await openSession(sessionId);
	const endOffset: number = Math.max(0, beforeOffset);
	const blockOffset: number = Math.max(0, endOffset - limit);
	return createTimelinePageFromStoredSession(stored, blockOffset, endOffset - blockOffset);
}

export async function openSessionTimelinePageAfter(sessionId: string, afterOffset: number, limit: number): Promise<StoredSessionTimelinePage> {
	const stored: StoredSession = await openSession(sessionId);
	const blockOffset: number = Math.max(0, afterOffset);
	return createTimelinePageFromStoredSession(stored, blockOffset, limit);
}

async function writeSessionMessagesAndMetadata(sessionId: string, existing: StoredSession, messages: ChatMessage[], metadata?: Partial<SessionMetadata>): Promise<void> {
	const metaFile: string = metaPath(sessionId);
	const msgFile: string = messagesPath(sessionId);

	const updated: SessionMetadata = mergeSessionMetadata(existing.metadata, metadata);
	await writeJsonFileAtomic(metaFile, updated);

	const timestamp: string = new Date().toISOString();
	const lines: string[] = [];

	for (const message of messages) {
		lines.push(JSON.stringify({ ...message, createdAt: message.createdAt ?? timestamp }) + "\n");
	}

	await writeFile(msgFile, lines.join(""), "utf8");
	invalidateTimelineCache(sessionId);
}

export async function updateSessionTranscript<T>(
	sessionId: string,
	updater: (stored: StoredSession) => Promise<TranscriptUpdate<T>> | TranscriptUpdate<T>
): Promise<T> {
	return enqueueTranscriptWrite(sessionId, async (): Promise<T> => {
		const stored: StoredSession = await openSession(sessionId);
		const update: TranscriptUpdate<T> = await updater(stored);
		await writeSessionMessagesAndMetadata(sessionId, stored, update.messages, update.metadata);
		return update.result;
	});
}

export async function saveSession(sessionId: string, messages: ChatMessage[], metadata?: Partial<SessionMetadata>): Promise<void> {
	await updateSessionTranscript(sessionId, (): TranscriptUpdate<void> => ({
		messages,
		metadata,
		result: undefined
	}));
}

export async function updateSessionMetadata(sessionId: string, metadata: Partial<SessionMetadata>): Promise<SessionMetadata> {
	const metaFile: string = metaPath(sessionId);
	const existing: StoredSession = await openSession(sessionId);
	const updated: SessionMetadata = mergeSessionMetadata(existing.metadata, metadata);
	await writeJsonFileAtomic(metaFile, updated);
	invalidateTimelineCache(sessionId);
	return updated;
}

export async function rewindSessionFromRequest(sessionId: string, requestId: string): Promise<StoredMessage[]> {
	return enqueueTranscriptWrite(sessionId, async (): Promise<StoredMessage[]> => {
		const stored: StoredSession = await openSession(sessionId);
		const startIndex: number = stored.messages.findIndex((message: StoredMessage): boolean => message.requestId === requestId);
		if (startIndex < 0) {
			return stored.messages;
		}

		const keptMessages: StoredMessage[] = stored.messages.slice(0, startIndex);
		const removedRequestIds: Set<string> = new Set(
			stored.messages
				.slice(startIndex)
				.map((message: StoredMessage): string | undefined => message.requestId)
				.filter((value: string | undefined): value is string => value !== undefined && value.length > 0)
		);
		const rewindBoundaryCreatedAt: string = findRewindBoundaryCreatedAt(stored.events, removedRequestIds)
			?? stored.messages[startIndex]?.createdAt
			?? "";
		const keptEvents: StoredSessionEvent[] = stored.events.filter((event: StoredSessionEvent): boolean => shouldKeepEventAfterRewind(event, removedRequestIds, rewindBoundaryCreatedAt));
		const updatedMetadata: SessionMetadata = {
			...stored.metadata,
			updatedAt: new Date().toISOString()
		};

		await writeFile(metaPath(sessionId), JSON.stringify(updatedMetadata, null, 2), "utf8");
		await writeFile(
			messagesPath(sessionId),
			keptMessages.map((message: StoredMessage): string => JSON.stringify(message) + "\n").join(""),
			"utf8"
		);
		await writeFile(
			eventsPath(sessionId),
			keptEvents.map((event: StoredSessionEvent): string => JSON.stringify(event) + "\n").join(""),
			"utf8"
		);
		try {
			const rawApprovalEvents: string = await readFile(approvalEventsPath(sessionId), "utf8");
			const keptApprovalEvents: StoredApprovalEvent[] = parseJsonLines<StoredApprovalEvent>(rawApprovalEvents)
				.filter((event: StoredApprovalEvent): boolean => shouldKeepEventAfterRewind(event, removedRequestIds, rewindBoundaryCreatedAt));
			await writeFile(
				approvalEventsPath(sessionId),
				keptApprovalEvents.map((event: StoredApprovalEvent): string => JSON.stringify(event) + "\n").join(""),
				"utf8"
			);
		} catch {
			// Older sessions may not have approval persistence yet.
		}
		try {
			const rawWorkflowEvents: string = await readFile(workflowEventsPath(sessionId), "utf8");
			const keptWorkflowEvents: StoredWorkflowEvent[] = parseJsonLines<StoredWorkflowEvent>(rawWorkflowEvents)
				.filter((event: StoredWorkflowEvent): boolean => shouldKeepEventAfterRewind(event, removedRequestIds, rewindBoundaryCreatedAt));
			await writeFile(
				workflowEventsPath(sessionId),
				keptWorkflowEvents.map((event: StoredWorkflowEvent): string => JSON.stringify(event) + "\n").join(""),
				"utf8"
			);
		} catch {
			// Older sessions may not have workflow persistence yet.
		}
		try {
			const rawAgentEvents: string = await readFile(agentEventsPath(sessionId), "utf8");
			const keptAgentEvents: StoredAgentEvent[] = parseJsonLines<StoredAgentEvent>(rawAgentEvents)
				.filter((event: StoredAgentEvent): boolean => shouldKeepEventAfterRewind(event, removedRequestIds, rewindBoundaryCreatedAt));
			await writeFile(
				agentEventsPath(sessionId),
				keptAgentEvents.map((event: StoredAgentEvent): string => JSON.stringify(event) + "\n").join(""),
				"utf8"
			);
		} catch {
			// Older sessions may not have agent persistence yet.
		}

		invalidateTimelineCache(sessionId);
		return keptMessages;
	});
}

function findRewindBoundaryCreatedAt(events: RewindableEvent[], removedRequestIds: Set<string>): string | null {
	let boundaryCreatedAt: string | null = null;
	for (const event of events) {
		if (!removedRequestIds.has(event.requestId)) {
			continue;
		}
		if (boundaryCreatedAt === null || event.createdAt < boundaryCreatedAt) {
			boundaryCreatedAt = event.createdAt;
		}
	}

	return boundaryCreatedAt;
}

function shouldKeepEventAfterRewind(event: RewindableEvent, removedRequestIds: Set<string>, rewindBoundaryCreatedAt: string): boolean {
	if (removedRequestIds.has(event.requestId)) {
		return false;
	}
	if (rewindBoundaryCreatedAt.length === 0 || event.createdAt.length === 0) {
		return true;
	}

	return event.createdAt < rewindBoundaryCreatedAt;
}

export async function appendMessage(sessionId: string, message: ChatMessage): Promise<void> {
	await enqueueTranscriptWrite(sessionId, async (): Promise<void> => {
		await ensureSessionsDir();
		const msgFile: string = messagesPath(sessionId);
		const line: string = JSON.stringify({ ...message, createdAt: message.createdAt ?? new Date().toISOString() }) + "\n";
		await writeFile(msgFile, line, { encoding: "utf8", flag: "a" });
		invalidateTimelineCache(sessionId);
	});
}

export async function appendSessionEvent(sessionId: string, requestId: string, event: string, data: unknown): Promise<void> {
	await ensureSessionsDir();
	const eventFile: string = eventsPath(sessionId);
	const timestamp: string = new Date().toISOString();
	const record: StoredSessionEvent = {
		id: `event-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		requestId,
		event,
		data,
		createdAt: timestamp
	};
	const line: string = JSON.stringify(record) + "\n";
	await writeFile(eventFile, line, { encoding: "utf8", flag: "a" });
	invalidateTimelineCache(sessionId);
}

export async function appendApprovalEvent(sessionId: string, approvalId: string, requestId: string, event: string, data: unknown): Promise<void> {
	await ensureSessionsDir();
	const eventFile: string = approvalEventsPath(sessionId);
	const timestamp: string = new Date().toISOString();
	const record: StoredApprovalEvent = {
		id: `approval-event-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		schemaVersion: 1,
		approvalId,
		requestId,
		event,
		data,
		createdAt: timestamp
	};
	const line: string = JSON.stringify(record) + "\n";
	await writeFile(eventFile, line, { encoding: "utf8", flag: "a" });
	invalidateTimelineCache(sessionId);
}

export async function appendWorkflowEvent(sessionId: string, workflowId: string, requestId: string, event: string, data: unknown): Promise<void> {
	await ensureSessionsDir();
	const eventFile: string = workflowEventsPath(sessionId);
	const timestamp: string = new Date().toISOString();
	const record: StoredWorkflowEvent = {
		id: `workflow-event-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		schemaVersion: 1,
		workflowId,
		requestId,
		event,
		data,
		createdAt: timestamp
	};
	const line: string = JSON.stringify(record) + "\n";
	await writeFile(eventFile, line, { encoding: "utf8", flag: "a" });
	invalidateTimelineCache(sessionId);
}

export async function appendAgentEvent(sessionId: string, runId: string, requestId: string, event: string, data: unknown): Promise<void> {
	await ensureSessionsDir();
	const eventFile: string = agentEventsPath(sessionId);
	const timestamp: string = new Date().toISOString();
	const record: StoredAgentEvent = {
		id: `agent-event-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		schemaVersion: 1,
		runId,
		requestId,
		event,
		data,
		createdAt: timestamp
	};
	const line: string = JSON.stringify(record) + "\n";
	await writeFile(eventFile, line, { encoding: "utf8", flag: "a" });
	invalidateTimelineCache(sessionId);
}

export async function readApprovalEvents(sessionId: string): Promise<StoredApprovalEvent[]> {
	await ensureSessionsDir();
	try {
		const rawLines: string = await readFile(approvalEventsPath(sessionId), "utf8");
		return parseJsonLines<StoredApprovalEvent>(rawLines);
	} catch {
		return [];
	}
}

function getRecordSessionId(value: unknown): string | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}

	const record = value as Record<string, unknown>;
	if (typeof record.sessionId === "string") {
		return record.sessionId;
	}

	const data: unknown = record.data;
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return null;
	}

	const dataRecord = data as Record<string, unknown>;
	return typeof dataRecord.sessionId === "string" ? dataRecord.sessionId : null;
}

function getRecordRequestId(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}

	const requestId: unknown = (value as Record<string, unknown>).requestId;
	return typeof requestId === "string" ? requestId : undefined;
}

function getRecordEventName(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}

	const eventName: unknown = (value as Record<string, unknown>).event;
	return typeof eventName === "string" ? eventName : undefined;
}

async function collectSessionIntegrityIssues(sessionId: string, file: StoredEventFileKind, filePath: string): Promise<SessionIntegrityIssue[]> {
	const issues: SessionIntegrityIssue[] = [];
	let rawLines: string;
	try {
		rawLines = await readFile(filePath, "utf8");
	} catch {
		return issues;
	}

	const lines: string[] = rawLines.split("\n");
	for (let index: number = 0; index < lines.length; index += 1) {
		const line: string = lines[index]!.trim();
		if (line.length === 0) {
			continue;
		}

		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}

		const actualSessionId: string | null = getRecordSessionId(record);
		if (actualSessionId === null || actualSessionId === sessionId) {
			continue;
		}

		issues.push({
			file,
			line: index + 1,
			expectedSessionId: sessionId,
			actualSessionId,
			requestId: getRecordRequestId(record),
			event: getRecordEventName(record)
		});
	}

	return issues;
}

export async function checkSessionIntegrity(sessionId: string): Promise<SessionIntegrityCheckResult> {
	const safeSessionId: string = assertSafeSessionId(sessionId);
	await openSession(safeSessionId);
	const files: Array<{ kind: StoredEventFileKind; path: string }> = [
		{ kind: "messages", path: messagesPath(safeSessionId) },
		{ kind: "events", path: eventsPath(safeSessionId) },
		{ kind: "approval-events", path: approvalEventsPath(safeSessionId) },
		{ kind: "workflow-events", path: workflowEventsPath(safeSessionId) },
		{ kind: "agent-events", path: agentEventsPath(safeSessionId) }
	];
	const issues: SessionIntegrityIssue[] = [];
	for (const file of files) {
		issues.push(...await collectSessionIntegrityIssues(safeSessionId, file.kind, file.path));
	}

	return {
		sessionId: safeSessionId,
		ok: issues.length === 0,
		issues,
		checkedFiles: files.map((file): StoredEventFileKind => file.kind)
	};
}

export async function clearSessionEvents(sessionId: string): Promise<void> {
	await ensureSessionsDir();
	await writeFile(eventsPath(sessionId), "", "utf8");
	await writeFile(agentEventsPath(sessionId), "", "utf8").catch((): void => {});
	await writeFile(workflowEventsPath(sessionId), "", "utf8").catch((): void => {});
	await writeFile(approvalEventsPath(sessionId), "", "utf8").catch((): void => {});
	invalidateTimelineCache(sessionId);
}

export async function listSessions(): Promise<SessionMetadata[]> {
	await ensureSessionsDir();
	return listSessionMetadataFromDir(SESSIONS_DIR);
}

export async function listArchivedSessions(): Promise<SessionMetadata[]> {
	await ensureArchivedSessionsDir();
	return listSessionMetadataFromDir(ARCHIVED_SESSIONS_DIR);
}

export async function archiveSession(sessionId: string): Promise<SessionMetadata> {
	const safeSessionId: string = assertSafeSessionId(sessionId);
	await ensureSessionsDir();
	await ensureArchivedSessionsDir();

	const sourceDir: string = getSessionDir(safeSessionId);
	const targetDir: string = getArchivedSessionDir(safeSessionId);
	if (await pathExists(targetDir)) {
		throw new Error(`Archived session already exists: ${safeSessionId}`);
	}

	const existingMetadata: SessionMetadata = await readSessionMetadata(safeSessionId);
	const archivedAt: string = new Date().toISOString();
	const metadata: SessionMetadata = {
		...existingMetadata,
		archivedAt,
		updatedAt: archivedAt
	};
	await rename(sourceDir, targetDir);
	await writeJsonFileAtomic(join(targetDir, "metadata.json"), metadata);
	return metadata;
}

export async function restoreArchivedSession(sessionId: string): Promise<SessionMetadata> {
	const safeSessionId: string = assertSafeSessionId(sessionId);
	await ensureSessionsDir();
	await ensureArchivedSessionsDir();

	const sourceDir: string = getArchivedSessionDir(safeSessionId);
	const targetDir: string = getSessionDir(safeSessionId);
	if (await pathExists(targetDir)) {
		throw new Error(`Session already exists: ${safeSessionId}`);
	}

	const archivedMetadata: SessionMetadata = await readArchivedSessionMetadata(safeSessionId);
	const metadata: SessionMetadata = {
		...archivedMetadata,
		archivedAt: undefined,
		updatedAt: new Date().toISOString()
	};
	await rename(sourceDir, targetDir);
	await writeJsonFileAtomic(join(targetDir, "metadata.json"), metadata);
	return metadata;
}

export async function deleteSession(sessionId: string): Promise<void> {
	const safeSessionId: string = assertSafeSessionId(sessionId);
	await ensureSessionsDir();
	const dir: string = getSessionDir(safeSessionId);
	if (!await pathExists(dir)) {
		throw new Error(`Session not found: ${safeSessionId}`);
	}

	await rm(dir, { recursive: true });
}

export async function deleteArchivedSession(sessionId: string): Promise<void> {
	const safeSessionId: string = assertSafeSessionId(sessionId);
	await ensureArchivedSessionsDir();
	const dir: string = getArchivedSessionDir(safeSessionId);
	if (!await pathExists(dir)) {
		throw new Error(`Archived session not found: ${safeSessionId}`);
	}

	await rm(dir, { recursive: true });
}

export async function deleteSessionsByWorkspace(workspaceId: string): Promise<{ deletedSessionIds: string[]; deletedArchivedSessionIds: string[] }> {
	const sessions: SessionMetadata[] = await listSessions();
	const archivedSessions: SessionMetadata[] = await listArchivedSessions();
	const deletedSessionIds: string[] = sessions
		.filter((metadata: SessionMetadata): boolean => metadata.workspaceId === workspaceId)
		.map((metadata: SessionMetadata): string => metadata.id);
	const deletedArchivedSessionIds: string[] = archivedSessions
		.filter((metadata: SessionMetadata): boolean => metadata.workspaceId === workspaceId)
		.map((metadata: SessionMetadata): string => metadata.id);

	for (const sessionId of deletedSessionIds) {
		await deleteSession(sessionId);
	}
	for (const sessionId of deletedArchivedSessionIds) {
		await deleteArchivedSession(sessionId);
	}

	return { deletedSessionIds, deletedArchivedSessionIds };
}

export async function renameSession(sessionId: string, newTitle: string): Promise<SessionMetadata> {
	const stored: StoredSession = await openSession(sessionId);
	const updated: SessionMetadata = {
		...stored.metadata,
		title: newTitle,
		updatedAt: new Date().toISOString()
	};

	const metaFile: string = metaPath(sessionId);
	await writeJsonFileAtomic(metaFile, updated);

	return updated;
}

export async function sessionExists(sessionId: string): Promise<boolean> {
	await ensureSessionsDir();
	try {
		await access(getSessionDir(sessionId));
		return true;
	} catch {
		return false;
	}
}

function summaryPath(sessionId: string): string {
	return join(getSessionDir(sessionId), "summary.md");
}

function parseSummaryFrontmatter(raw: string): SessionSummary {
	if (!raw.startsWith("---\n")) {
		return {
			content: raw.trim(),
			messageCount: 0,
			tokenEstimate: 0,
			generatedAt: ""
		};
	}

	const endIndex: number = raw.indexOf("\n---\n", 4);
	if (endIndex === -1) {
		return {
			content: raw.trim(),
			messageCount: 0,
			tokenEstimate: 0,
			generatedAt: ""
		};
	}

	const header: string = raw.slice(4, endIndex);
	const content: string = raw.slice(endIndex + 5).trim();
	const metadata: Record<string, string> = {};

	for (const line of header.split("\n")) {
		const colonIndex: number = line.indexOf(":");
		if (colonIndex === -1) {
			continue;
		}

		const key: string = line.slice(0, colonIndex).trim();
		const value: string = line.slice(colonIndex + 1).trim();
		metadata[key] = value;
	}

	return {
		content,
		messageCount: Number.parseInt(metadata.messageCount ?? "0", 10),
		tokenEstimate: Number.parseInt(metadata.tokenEstimate ?? "0", 10),
		generatedAt: metadata.generatedAt ?? ""
	};
}

function formatSummaryMarkdown(summary: SessionSummary): string {
	return [
		"---",
		`messageCount: ${summary.messageCount}`,
		`tokenEstimate: ${summary.tokenEstimate}`,
		`generatedAt: ${summary.generatedAt}`,
		"---",
		"",
		summary.content.trim(),
		""
	].join("\n");
}

export async function readSummary(sessionId: string): Promise<SessionSummary | null> {
	try {
		const filePath: string = summaryPath(sessionId);
		const raw: string = await readFile(filePath, "utf8");
		return parseSummaryFrontmatter(raw);
	} catch {
		return null;
	}
}

export async function writeSummary(sessionId: string, summary: SessionSummary): Promise<void> {
	await ensureSessionsDir();
	const filePath: string = summaryPath(sessionId);
	await writeFile(filePath, formatSummaryMarkdown(summary), "utf8");
}

export async function deleteSummary(sessionId: string): Promise<void> {
	try {
		const filePath: string = summaryPath(sessionId);
		await rm(filePath, { force: true });
	} catch {
		// Already gone
	}
}
