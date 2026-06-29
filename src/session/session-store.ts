import { mkdir, readFile, writeFile, readdir, rm, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ChatMessage } from "../protocol/types.js";

const SESSIONS_DIR: string = resolve(process.env.SESSIONS_DIR ?? "data/sessions");

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

export type StoredSession = {
	metadata: SessionMetadata;
	messages: StoredMessage[];
};

async function sessionDir(sessionId: string): Promise<string> {
	const dir: string = join(SESSIONS_DIR, sessionId);
	await mkdir(dir, { recursive: true });
	return dir;
}

async function metaPath(sessionId: string): Promise<string> {
	return join(await sessionDir(sessionId), "metadata.json");
}

async function messagesPath(sessionId: string): Promise<string> {
	return join(await sessionDir(sessionId), "messages.jsonl");
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

	const dir: string = await sessionDir(id);
	await writeFile(join(dir, "metadata.json"), JSON.stringify(metadata, null, 2), "utf8");
	await writeFile(join(dir, "messages.jsonl"), "", "utf8");

	return metadata;
}

export async function openSession(sessionId: string): Promise<StoredSession> {
	const metaFile: string = await metaPath(sessionId);
	const msgFile: string = await messagesPath(sessionId);

	let metadata: SessionMetadata;

	try {
		const raw: string = await readFile(metaFile, "utf8");
		metadata = JSON.parse(raw) as SessionMetadata;
	} catch {
		throw new Error(`Session not found: ${sessionId}`);
	}

	const messages: StoredMessage[] = [];

	try {
		const rawLines: string = await readFile(msgFile, "utf8");

		for (const line of rawLines.split("\n")) {
			const trimmed: string = line.trim();
			if (trimmed.length === 0) {
				continue;
			}

			try {
				messages.push(JSON.parse(trimmed) as StoredMessage);
			} catch {
				// Skip corrupted lines
			}
		}
	} catch {
		// No messages yet
	}

	return { metadata, messages };
}

export async function saveSession(sessionId: string, messages: ChatMessage[], metadata?: Partial<SessionMetadata>): Promise<void> {
	const metaFile: string = await metaPath(sessionId);
	const msgFile: string = await messagesPath(sessionId);

	if (metadata && Object.keys(metadata).length > 0) {
		const existing: StoredSession = await openSession(sessionId);
		const updated: SessionMetadata = {
			...existing.metadata,
			...metadata,
			updatedAt: new Date().toISOString()
		};
		await writeFile(metaFile, JSON.stringify(updated, null, 2), "utf8");
	}

	const timestamp: string = new Date().toISOString();
	const lines: string[] = [];

	for (const message of messages) {
		lines.push(JSON.stringify({ ...message, createdAt: timestamp }) + "\n");
	}

	await writeFile(msgFile, lines.join(""), "utf8");
}

export async function appendMessage(sessionId: string, message: ChatMessage): Promise<void> {
	const msgFile: string = await messagesPath(sessionId);
	const line: string = JSON.stringify({ ...message, createdAt: new Date().toISOString() }) + "\n";
	await writeFile(msgFile, line, { flag: "a" });
}

export async function listSessions(): Promise<SessionMetadata[]> {
	try {
		await mkdir(SESSIONS_DIR, { recursive: true });
	} catch {
		// Already exists
	}

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
	const dir: string = await sessionDir(sessionId);
	await rm(dir, { recursive: true, force: true });
}

export async function renameSession(sessionId: string, newTitle: string): Promise<SessionMetadata> {
	const stored: StoredSession = await openSession(sessionId);
	const updated: SessionMetadata = {
		...stored.metadata,
		title: newTitle,
		updatedAt: new Date().toISOString()
	};

	const metaFile: string = await metaPath(sessionId);
	await writeFile(metaFile, JSON.stringify(updated, null, 2), "utf8");

	return updated;
}

export async function sessionExists(sessionId: string): Promise<boolean> {
	try {
		await access(join(SESSIONS_DIR, sessionId));
		return true;
	} catch {
		return false;
	}
}
