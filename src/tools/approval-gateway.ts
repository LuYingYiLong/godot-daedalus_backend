import type { McpHost } from "../mcp/mcp-host.js";
import { evaluateToolCall, type ApprovalDecision, type ApprovalMode } from "./tool-policy.js";
import { getEffectiveToolPolicy } from "./tool-policy.js";
import { isPlanSafeDynamicMcpToolName } from "./dynamic-mcp-tools.js";
import { executeLlmToolWithIdempotency, getLlmToolExecutionIdentity } from "./tool-idempotency.js";
import type { FileEditBatchDraft } from "./file-edit-snapshots.js";

export type PendingApproval = {
	approvalId: string;
	toolCallId: string;
	toolName: string;
	llmToolName: string;
	args: Record<string, unknown>;
	reason: string;
	createdAt: number;
	executionFingerprint?: string | undefined;
};

export type ApprovalResult =
	| { status: "executed"; content: string; cached?: boolean | undefined; fileEditDraft?: FileEditBatchDraft | undefined }
	| { status: "pending"; approval: PendingApproval }
	| { status: "denied"; reason: string };

export class ApprovalGateway {
	private pendingApprovals: Map<string, PendingApproval> = new Map();
	private mode: ApprovalMode;

	constructor(mode: ApprovalMode = "manual") {
		this.mode = mode;
	}

	setMode(mode: ApprovalMode): void {
		this.mode = mode;
	}

	getMode(): ApprovalMode {
		return this.mode;
	}

	listPending(): PendingApproval[] {
		return Array.from(this.pendingApprovals.values());
	}

	getPending(approvalId: string): PendingApproval | undefined {
		return this.pendingApprovals.get(approvalId);
	}

	replacePending(pendingApprovals: PendingApproval[]): void {
		this.pendingApprovals.clear();
		for (const pendingApproval of pendingApprovals) {
			this.pendingApprovals.set(pendingApproval.approvalId, pendingApproval);
		}
	}

	upsertPending(pendingApproval: PendingApproval): void {
		this.pendingApprovals.set(pendingApproval.approvalId, pendingApproval);
	}

	removePending(approvalId: string): PendingApproval | undefined {
		const pending: PendingApproval | undefined = this.pendingApprovals.get(approvalId);
		if (pending !== undefined) {
			this.pendingApprovals.delete(approvalId);
		}

		return pending;
	}

	async evaluate(
		llmToolName: string,
		args: Record<string, unknown>,
		toolCallId: string
	): Promise<ApprovalDecision> {
		return evaluateToolCall(this.mode, llmToolName, args);
	}

	requestApproval(
		llmToolName: string,
		args: Record<string, unknown>,
		toolCallId: string,
		reason: string,
		executionScope: string = "workspace:none"
	): PendingApproval {
		const executionFingerprint: string | undefined = getLlmToolExecutionIdentity(llmToolName, args, executionScope)?.fingerprint;
		if (executionFingerprint !== undefined) {
			for (const pendingApproval of this.pendingApprovals.values()) {
				if (pendingApproval.executionFingerprint === executionFingerprint) {
					return pendingApproval;
				}
			}
		}

		const approvalId: string = `approval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

		const pending: PendingApproval = {
			approvalId,
			toolCallId,
			toolName: llmToolName,
			llmToolName,
			args,
			reason,
			createdAt: Date.now(),
			executionFingerprint
		};

		this.pendingApprovals.set(approvalId, pending);
		return pending;
	}

	async approve(approvalId: string, mcpHost: McpHost): Promise<{ content: string; cached?: boolean | undefined; fileEditDraft?: FileEditBatchDraft | undefined }> {
		const pending: PendingApproval | undefined = this.pendingApprovals.get(approvalId);

		if (!pending) {
			throw new Error(`Approval not found: ${approvalId}`);
		}

		const result = await executeLlmToolWithIdempotency(mcpHost, pending.llmToolName, pending.args);
		this.pendingApprovals.delete(approvalId);
		return { content: result.content, cached: result.reused, fileEditDraft: result.fileEditDraft };
	}

	reject(approvalId: string): PendingApproval {
		const pending: PendingApproval | undefined = this.pendingApprovals.get(approvalId);

		if (!pending) {
			throw new Error(`Approval not found: ${approvalId}`);
		}

		this.pendingApprovals.delete(approvalId);
		return pending;
	}
}

export class ReadOnlyToolApprovalGateway extends ApprovalGateway {
	private readonly allowedToolNames: ReadonlySet<string>;

	constructor(allowedToolNames: readonly string[]) {
		super("manual");
		this.allowedToolNames = new Set(allowedToolNames);
	}

	override async evaluate(
		llmToolName: string,
		args: Record<string, unknown>,
		_toolCallId: string
	): Promise<ApprovalDecision> {
		if (!this.allowedToolNames.has(llmToolName)) {
			return {
				action: "deny",
				reason: `只读上下文只允许显式授权的 read/verify 工具: ${llmToolName}`
			};
		}
		if (isPlanSafeDynamicMcpToolName(llmToolName)) {
			return { action: "allow" };
		}

		const policy = getEffectiveToolPolicy(llmToolName, args);
		if (policy?.risk === "read" || policy?.risk === "verify") {
			return { action: "allow" };
		}

		return {
			action: "deny",
			reason: `只读上下文禁止 ${policy?.risk ?? "unknown"} 风险工具: ${llmToolName}`
		};
	}

	override requestApproval(
		_llmToolName: string,
		_args: Record<string, unknown>,
		_toolCallId: string,
		_reason: string,
		_executionScope: string = "workspace:none"
	): PendingApproval {
		throw new Error("只读上下文不允许触发人工审批。");
	}
}
