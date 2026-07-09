import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { getSessionDir } from "../session/session-store.js";

const PLAN_ID_PATTERN: RegExp = /^plan-[a-zA-Z0-9_-]+$/;

export type PlanStatus = "clarification_required" | "ready" | "approved" | "executing";

export type PlanRecommendedReply = {
	label: string;
	text: string;
	description?: string | undefined;
};

export type StoredPlanMetadata = {
	schemaVersion: 1;
	planId: string;
	sessionId: string;
	requestId: string;
	status: PlanStatus;
	title: string;
	originalMessage: string;
	previewMarkdown: string;
	clarificationQuestion?: string | undefined;
	recommendedReplies?: PlanRecommendedReply[] | undefined;
	clarifications: string[];
	revisions: string[];
	createdAt: string;
	updatedAt: string;
	approvedAt?: string | undefined;
	executedRequestId?: string | undefined;
	planPath: string;
};

export type StoredPlan = {
	metadata: StoredPlanMetadata;
	markdown: string;
};

function assertSafePlanId(planId: string): string {
	if (!PLAN_ID_PATTERN.test(planId)) {
		throw new Error(`Invalid plan id: ${planId}`);
	}
	return planId;
}

export function createPlanId(): string {
	return `plan-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

export function getPlanDir(sessionId: string, planId: string): string {
	return path.join(getSessionDir(sessionId), "plans", assertSafePlanId(planId));
}

function getPlanMetadataPath(sessionId: string, planId: string): string {
	return path.join(getPlanDir(sessionId, planId), "metadata.json");
}

function getPlanMarkdownPath(sessionId: string, planId: string): string {
	return path.join(getPlanDir(sessionId, planId), "PLAN.md");
}

export function createPlanMetadata(params: {
	sessionId: string;
	requestId: string;
	status: PlanStatus;
	title: string;
	originalMessage: string;
	previewMarkdown?: string | undefined;
	clarificationQuestion?: string | undefined;
	recommendedReplies?: PlanRecommendedReply[] | undefined;
	clarifications?: string[] | undefined;
	revisions?: string[] | undefined;
	now?: string | undefined;
}): StoredPlanMetadata {
	const planId: string = createPlanId();
	const timestamp: string = params.now ?? new Date().toISOString();
	return {
		schemaVersion: 1,
		planId,
		sessionId: params.sessionId,
		requestId: params.requestId,
		status: params.status,
		title: params.title,
		originalMessage: params.originalMessage,
		previewMarkdown: params.previewMarkdown ?? "",
		clarificationQuestion: params.clarificationQuestion,
		recommendedReplies: params.recommendedReplies,
		clarifications: params.clarifications ?? [],
		revisions: params.revisions ?? [],
		createdAt: timestamp,
		updatedAt: timestamp,
		planPath: `plans/${planId}/PLAN.md`
	};
}

export async function writeStoredPlan(metadata: StoredPlanMetadata, markdown: string): Promise<StoredPlan> {
	const planDir: string = getPlanDir(metadata.sessionId, metadata.planId);
	await fs.mkdir(planDir, { recursive: true });
	await fs.writeFile(getPlanMarkdownPath(metadata.sessionId, metadata.planId), markdown, "utf8");
	await fs.writeFile(getPlanMetadataPath(metadata.sessionId, metadata.planId), JSON.stringify(metadata, null, 2), "utf8");
	return {
		metadata,
		markdown
	};
}

export async function readStoredPlan(sessionId: string, planId: string): Promise<StoredPlan> {
	const metadataRaw: string = await fs.readFile(getPlanMetadataPath(sessionId, planId), "utf8");
	const metadata: StoredPlanMetadata = JSON.parse(metadataRaw) as StoredPlanMetadata;
	if (metadata.sessionId !== sessionId || metadata.planId !== planId) {
		throw new Error("Plan metadata does not match requested session or plan id.");
	}
	const markdown: string = await fs.readFile(getPlanMarkdownPath(sessionId, planId), "utf8");
	return {
		metadata,
		markdown
	};
}

export async function updateStoredPlan(
	sessionId: string,
	planId: string,
	update: (plan: StoredPlan) => StoredPlan | Promise<StoredPlan>
): Promise<StoredPlan> {
	const current: StoredPlan = await readStoredPlan(sessionId, planId);
	const next: StoredPlan = await update(current);
	const updatedMetadata: StoredPlanMetadata = {
		...next.metadata,
		updatedAt: new Date().toISOString()
	};
	return writeStoredPlan(updatedMetadata, next.markdown);
}

export function createPlanEventPayload(plan: StoredPlan): Record<string, unknown> {
	return {
		planId: plan.metadata.planId,
		sessionId: plan.metadata.sessionId,
		requestId: plan.metadata.requestId,
		status: plan.metadata.status,
		title: plan.metadata.title,
		previewMarkdown: plan.metadata.previewMarkdown,
		question: plan.metadata.clarificationQuestion ?? "",
		recommendedReplies: plan.metadata.recommendedReplies ?? [],
		createdAt: plan.metadata.createdAt,
		updatedAt: plan.metadata.updatedAt
	};
}

export function createPlanGetResult(plan: StoredPlan): Record<string, unknown> {
	return {
		...createPlanEventPayload(plan),
		markdown: plan.markdown,
		metadata: plan.metadata
	};
}
