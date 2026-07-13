import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDefaultArchivedSessionsDir, getDefaultSessionsDir } from "../app-paths.js";
import { writeJsonFileAtomic } from "../json-file-store.js";
import type { ChatMessage } from "../protocol/types.js";
import type { WorkspaceConfig } from "../workspace/types.js";
import { buildCanonicalTimelineBlocks, type TimelineBlock } from "./timeline-blocks.js";

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
	latestWorkflowSnapshot: unknown | null;
	latestAgentSnapshot: unknown | null;
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

function createTimelinePageFromStoredSession(stored: StoredSession, offset: number, limit: number): StoredSessionTimelinePage {
	const timeline = buildCanonicalTimelineBlocks(stored);
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
		latestWorkflowSnapshot: timeline.latestWorkflowSnapshot,
		latestAgentSnapshot: timeline.latestAgentSnapshot
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
	const timeline = buildCanonicalTimelineBlocks(stored);
	const blockOffset: number = Math.max(0, timeline.blocks.length - limit);
	return createTimelinePageFromStoredSession(stored, blockOffset, limit);
}

export async function openSessionTimelinePage(sessionId: string, beforeOffset: number, limit: number): Promise<StoredSessionTimelinePage> {
	const stored: StoredSession = await openSession(sessionId);
	const endOffset: number = Math.max(0, beforeOffset);
	const blockOffset: number = Math.max(0, endOffset - limit);
	return createTimelinePageFromStoredSession(stored, blockOffset, endOffset - blockOffset);
}

export async function saveSession(sessionId: string, messages: ChatMessage[], metadata?: Partial<SessionMetadata>): Promise<void> {
	const metaFile: string = metaPath(sessionId);
	const msgFile: string = messagesPath(sessionId);

	const existing: StoredSession = await openSession(sessionId);
	const updated: SessionMetadata = mergeSessionMetadata(existing.metadata, metadata);
	await writeJsonFileAtomic(metaFile, updated);

	const timestamp: string = new Date().toISOString();
	const lines: string[] = [];

	for (const message of messages) {
		lines.push(JSON.stringify({ ...message, createdAt: message.createdAt ?? timestamp }) + "\n");
	}

	await writeFile(msgFile, lines.join(""), "utf8");
}

export async function rewindSessionFromRequest(sessionId: string, requestId: string): Promise<StoredMessage[]> {
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
	const keptEvents: StoredSessionEvent[] = stored.events.filter((event: StoredSessionEvent): boolean => !removedRequestIds.has(event.requestId));
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
			.filter((event: StoredApprovalEvent): boolean => !removedRequestIds.has(event.requestId));
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
			.filter((event: StoredWorkflowEvent): boolean => !removedRequestIds.has(event.requestId));
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
			.filter((event: StoredAgentEvent): boolean => !removedRequestIds.has(event.requestId));
		await writeFile(
			agentEventsPath(sessionId),
			keptAgentEvents.map((event: StoredAgentEvent): string => JSON.stringify(event) + "\n").join(""),
			"utf8"
		);
	} catch {
		// Older sessions may not have agent persistence yet.
	}

	return keptMessages;
}

export async function appendMessage(sessionId: string, message: ChatMessage): Promise<void> {
	await ensureSessionsDir();
	const msgFile: string = messagesPath(sessionId);
	const line: string = JSON.stringify({ ...message, createdAt: message.createdAt ?? new Date().toISOString() }) + "\n";
	await writeFile(msgFile, line, { encoding: "utf8", flag: "a" });
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

export async function clearSessionEvents(sessionId: string): Promise<void> {
	await ensureSessionsDir();
	await writeFile(eventsPath(sessionId), "", "utf8");
	await writeFile(agentEventsPath(sessionId), "", "utf8").catch((): void => {});
	await writeFile(workflowEventsPath(sessionId), "", "utf8").catch((): void => {});
	await writeFile(approvalEventsPath(sessionId), "", "utf8").catch((): void => {});
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
