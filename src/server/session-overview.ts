import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { getSessionDir, openSession, type SessionMetadata } from "../session/session-store.js";
import type { GeneratedImageArtifactMetadata, ImageAttachmentMetadata } from "../session/session-attachments.js";
import type { StoredPlanMetadata } from "./plan-store.js";
import { isInsideGitWorkTree, readGitBranch, runGit } from "./git-utils.js";

const DEFAULT_OVERVIEW_LIMIT: number = 3;
const MAX_OVERVIEW_LIMIT: number = 100;

export type SessionOverviewGitInfo = {
	hasGitRepository: boolean;
	branch: string | null;
	additions: number;
	deletions: number;
	changedFiles: number;
};

export type SessionOverviewPlanItem = {
	planId: string;
	title: string;
	status: string;
	updatedAt: string;
	planPath: string;
	previewMarkdown: string;
};

export type SessionOverviewSourceItem = {
	id: string;
	kind: "image_attachment" | "generated_image";
	title: string;
	mimeType: string;
	createdAt: string;
	width?: number | undefined;
	height?: number | undefined;
	byteSize: number;
	thumbnailDataUrl: string;
};

export type SessionOverviewResult = {
	sessionId: string;
	envInfo: SessionOverviewGitInfo | null;
	plans: {
		total: number;
		items: SessionOverviewPlanItem[];
	};
	sources: {
		total: number;
		items: SessionOverviewSourceItem[];
	};
};

function clampLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) {
		return DEFAULT_OVERVIEW_LIMIT;
	}
	return Math.max(0, Math.min(MAX_OVERVIEW_LIMIT, Math.trunc(limit)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: Record<string, unknown>, key: string): string {
	const raw: unknown = value[key];
	return typeof raw === "string" ? raw : "";
}

function getOptionalNumber(value: Record<string, unknown>, key: string): number | undefined {
	const raw: unknown = value[key];
	return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
	try {
		const raw: string = await readFile(filePath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

async function loadGitInfo(workspaceRoot: string | undefined): Promise<SessionOverviewGitInfo | null> {
	if (workspaceRoot === undefined || workspaceRoot.trim().length === 0) {
		return null;
	}

	if (!await isInsideGitWorkTree(workspaceRoot)) {
		return null;
	}

	const branch: string | null = await readGitBranch(workspaceRoot);

	let additions: number = 0;
	let deletions: number = 0;
	try {
		const diffOutput: string = (await runGit(workspaceRoot, ["diff", "--numstat", "HEAD", "--"])).stdout;
		for (const line of diffOutput.split(/\r?\n/)) {
			const [addedText, deletedText] = line.split(/\s+/, 2);
			const added: number = Number.parseInt(addedText ?? "", 10);
			const deleted: number = Number.parseInt(deletedText ?? "", 10);
			if (Number.isFinite(added)) {
				additions += added;
			}
			if (Number.isFinite(deleted)) {
				deletions += deleted;
			}
		}
	} catch {
		// 空仓库没有 HEAD 时 diff 可能失败；仍然显示分支和 changed file count。
	}

	let changedFiles: number = 0;
	try {
		const statusOutput: string = (await runGit(workspaceRoot, ["status", "--porcelain=v1"])).stdout;
		changedFiles = statusOutput.split(/\r?\n/).filter((line: string): boolean => line.trim().length > 0).length;
	} catch {
		changedFiles = 0;
	}

	return {
		hasGitRepository: true,
		branch,
		additions,
		deletions,
		changedFiles
	};
}

async function listPlanItems(sessionId: string, limit: number): Promise<{ total: number; items: SessionOverviewPlanItem[] }> {
	const plansDir: string = path.join(getSessionDir(sessionId), "plans");
	let entries;
	try {
		entries = await readdir(plansDir, { withFileTypes: true });
	} catch {
		return { total: 0, items: [] };
	}

	const items: SessionOverviewPlanItem[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith("plan-")) {
			continue;
		}
		const planDir: string = path.join(plansDir, entry.name);
		const metadata = await readJsonFile(path.join(planDir, "metadata.json"));
		if (metadata === null) {
			continue;
		}
		let markdown: string;
		try {
			markdown = await readFile(path.join(planDir, "PLAN.md"), "utf8");
		} catch {
			continue;
		}
		const planId: string = getString(metadata, "planId") || entry.name;
		const updatedAt: string = getString(metadata, "updatedAt") || getString(metadata, "createdAt") || "";
		items.push({
			planId,
			title: getString(metadata, "title") || "Untitled plan",
			status: getString(metadata, "status") || "unknown",
			updatedAt,
			planPath: getString(metadata, "planPath") || `plans/${planId}/PLAN.md`,
			previewMarkdown: getString(metadata, "previewMarkdown") || markdown.slice(0, 4000)
		});
	}

	items.sort((left: SessionOverviewPlanItem, right: SessionOverviewPlanItem): number => right.updatedAt.localeCompare(left.updatedAt));
	return {
		total: items.length,
		items: items.slice(0, limit)
	};
}

function createDataUrl(mimeType: string, bytes: Buffer): string {
	return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

async function readAttachmentSource(sessionId: string, metadataPath: string): Promise<SessionOverviewSourceItem | null> {
	const metadataRaw: Record<string, unknown> | null = await readJsonFile(metadataPath);
	if (metadataRaw === null) {
		return null;
	}
	const metadata: ImageAttachmentMetadata = metadataRaw as ImageAttachmentMetadata;
	if (!metadata.id?.startsWith("image-") || typeof metadata.mimeType !== "string") {
		return null;
	}

	try {
		const imagePath: string = path.join(getSessionDir(sessionId), "attachments", metadata.fileName || `${metadata.id}.png`);
		const bytes: Buffer = await readFile(imagePath);
		return {
			id: metadata.id,
			kind: "image_attachment",
			title: metadata.title || metadata.fileName || metadata.id,
			mimeType: metadata.mimeType,
			createdAt: metadata.createdAt || "",
			width: getOptionalNumber(metadataRaw, "width"),
			height: getOptionalNumber(metadataRaw, "height"),
			byteSize: metadata.byteSize,
			thumbnailDataUrl: createDataUrl(metadata.mimeType, bytes)
		};
	} catch {
		return null;
	}
}

async function readGeneratedImageSource(sessionId: string, metadataPath: string): Promise<SessionOverviewSourceItem | null> {
	const metadataRaw: Record<string, unknown> | null = await readJsonFile(metadataPath);
	if (metadataRaw === null) {
		return null;
	}
	const metadata: GeneratedImageArtifactMetadata = metadataRaw as GeneratedImageArtifactMetadata;
	if (!metadata.imageId?.startsWith("generated-image-") || metadata.sessionId !== sessionId || typeof metadata.mimeType !== "string") {
		return null;
	}

	try {
		const imagePath: string = path.join(getSessionDir(sessionId), "attachments", "images", metadata.fileName);
		const bytes: Buffer = await readFile(imagePath);
		return {
			id: metadata.imageId,
			kind: "generated_image",
			title: metadata.prompt || metadata.fileName || metadata.imageId,
			mimeType: metadata.mimeType,
			createdAt: metadata.createdAt || "",
			width: getOptionalNumber(metadataRaw, "width"),
			height: getOptionalNumber(metadataRaw, "height"),
			byteSize: metadata.byteSize,
			thumbnailDataUrl: createDataUrl(metadata.mimeType, bytes)
		};
	} catch {
		return null;
	}
}

async function listSourceItems(sessionId: string, limit: number): Promise<{ total: number; items: SessionOverviewSourceItem[] }> {
	const attachmentsDir: string = path.join(getSessionDir(sessionId), "attachments");
	const generatedImagesDir: string = path.join(attachmentsDir, "images");
	const items: SessionOverviewSourceItem[] = [];

	try {
		const attachmentEntries = await readdir(attachmentsDir, { withFileTypes: true });
		for (const entry of attachmentEntries) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) {
				continue;
			}
			const item: SessionOverviewSourceItem | null = await readAttachmentSource(sessionId, path.join(attachmentsDir, entry.name));
			if (item !== null) {
				items.push(item);
			}
		}
	} catch {
		// 会话没有附件目录时 source 为空。
	}

	try {
		const generatedEntries = await readdir(generatedImagesDir, { withFileTypes: true });
		for (const entry of generatedEntries) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) {
				continue;
			}
			const item: SessionOverviewSourceItem | null = await readGeneratedImageSource(sessionId, path.join(generatedImagesDir, entry.name));
			if (item !== null) {
				items.push(item);
			}
		}
	} catch {
		// 会话没有生成图目录时 source 为空。
	}

	items.sort((left: SessionOverviewSourceItem, right: SessionOverviewSourceItem): number => right.createdAt.localeCompare(left.createdAt));
	return {
		total: items.length,
		items: items.slice(0, limit)
	};
}

export async function createSessionOverview(params: {
	sessionId: string;
	planLimit?: number | undefined;
	sourceLimit?: number | undefined;
}): Promise<SessionOverviewResult> {
	const session = await openSession(params.sessionId);
	const metadata: SessionMetadata = session.metadata;
	const [envInfo, plans, sources] = await Promise.all([
		loadGitInfo(metadata.workspaceRoot),
		listPlanItems(params.sessionId, clampLimit(params.planLimit)),
		listSourceItems(params.sessionId, clampLimit(params.sourceLimit))
	]);

	return {
		sessionId: params.sessionId,
		envInfo,
		plans,
		sources
	};
}
