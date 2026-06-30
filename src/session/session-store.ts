import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDefaultSessionsDir } from "../app-paths.js";
import type { ChatMessage } from "../protocol/types.js";

const SESSIONS_DIR: string = getDefaultSessionsDir();
const SESSION_ID_PATTERN: RegExp = /^session-[a-zA-Z0-9_-]+$/;

let ensureSessionsDirPromise: Promise<void> | null = null;

export type SessionMetadata = {
	id: string;
	title: string;
	workspaceId?: string | undefined;
	activeSkillId?: string | undefined;
	provider?: string | undefined;
	model?: string | undefined;
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

export type StoredSession = {
	metadata: SessionMetadata;
	messages: StoredMessage[];
	events: StoredSessionEvent[];
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

function getSessionDir(sessionId: string): string {
	return join(SESSIONS_DIR, assertSafeSessionId(sessionId));
}

async function ensureSessionsDir(): Promise<void> {
	if (!ensureSessionsDirPromise) {
		ensureSessionsDirPromise = (async (): Promise<void> => {
			await mkdir(SESSIONS_DIR, { recursive: true });
		})();
	}

	await ensureSessionsDirPromise;
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

function messagesPath(sessionId: string): string {
	return join(getSessionDir(sessionId), "messages.jsonl");
}

function eventsPath(sessionId: string): string {
	return join(getSessionDir(sessionId), "events.jsonl");
}

export async function createSession(title: string, workspaceId?: string, skillId?: string): Promise<SessionMetadata> {
	const timestamp: string = new Date().toISOString();
	const dateStr: string = timestamp.slice(0, 10).replace(/-/g, "");
	const id: string = `session-${dateStr}-${Date.now().toString(36)}`;

	const metadata: SessionMetadata = {
		id,
		title,
		workspaceId,
		activeSkillId: skillId,
		createdAt: timestamp,
		updatedAt: timestamp
	};

	const dir: string = await createSessionDir(id);
	await writeFile(join(dir, "metadata.json"), JSON.stringify(metadata, null, 2), "utf8");
	await writeFile(join(dir, "messages.jsonl"), "", "utf8");
	await writeFile(join(dir, "events.jsonl"), "", "utf8");

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

export async function openSession(sessionId: string): Promise<StoredSession> {
	await ensureSessionsDir();
	const metaFile: string = metaPath(sessionId);
	const msgFile: string = messagesPath(sessionId);

	let metadata: SessionMetadata;

	try {
		const raw: string = await readFile(metaFile, "utf8");
		metadata = JSON.parse(raw) as SessionMetadata;
	} catch {
		throw new Error(`Session not found: ${sessionId}`);
	}

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

export async function saveSession(sessionId: string, messages: ChatMessage[], metadata?: Partial<SessionMetadata>): Promise<void> {
	const metaFile: string = metaPath(sessionId);
	const msgFile: string = messagesPath(sessionId);

	const existing: StoredSession = await openSession(sessionId);
	const updated: SessionMetadata = {
		...existing.metadata,
		...(metadata ?? {}),
		updatedAt: new Date().toISOString()
	};
	await writeFile(metaFile, JSON.stringify(updated, null, 2), "utf8");

	const timestamp: string = new Date().toISOString();
	const lines: string[] = [];

	for (const message of messages) {
		lines.push(JSON.stringify({ ...message, createdAt: timestamp }) + "\n");
	}

	await writeFile(msgFile, lines.join(""), "utf8");
}

export async function appendMessage(sessionId: string, message: ChatMessage): Promise<void> {
	await ensureSessionsDir();
	const msgFile: string = messagesPath(sessionId);
	const line: string = JSON.stringify({ ...message, createdAt: new Date().toISOString() }) + "\n";
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

export async function clearSessionEvents(sessionId: string): Promise<void> {
	await ensureSessionsDir();
	await writeFile(eventsPath(sessionId), "", "utf8");
}

export async function listSessions(): Promise<SessionMetadata[]> {
	await ensureSessionsDir();

	const entries: string[] = await readdir(SESSIONS_DIR, { withFileTypes: true })
		.then((items) => items.filter((d) => d.isDirectory()).map((d) => d.name));

	const sessions: SessionMetadata[] = [];

	for (const entry of entries) {
		try {
			const raw: string = await readFile(join(SESSIONS_DIR, entry, "metadata.json"), "utf8");
			sessions.push(JSON.parse(raw) as SessionMetadata);
		} catch {
			// Skip invalid sessions
		}
	}

	sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	return sessions;
}

export async function deleteSession(sessionId: string): Promise<void> {
	await ensureSessionsDir();
	const dir: string = getSessionDir(sessionId);
	await rm(dir, { recursive: true, force: true });
}

export async function renameSession(sessionId: string, newTitle: string): Promise<SessionMetadata> {
	const stored: StoredSession = await openSession(sessionId);
	const updated: SessionMetadata = {
		...stored.metadata,
		title: newTitle,
		updatedAt: new Date().toISOString()
	};

	const metaFile: string = metaPath(sessionId);
	await writeFile(metaFile, JSON.stringify(updated, null, 2), "utf8");

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
