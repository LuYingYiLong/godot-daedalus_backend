import type { McpHost } from "../mcp/mcp-host.js";
import { evaluateToolCall, type ApprovalDecision, type ApprovalMode } from "./tool-policy.js";
import { executeLlmToolWithIdempotency, getLlmToolExecutionIdentity } from "./tool-idempotency.js";

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
	| { status: "executed"; content: string; cached?: boolean | undefined }
	| { status: "pending"; approval: PendingApproval }
	| { status: "denied"; reason: string };

export class ApprovalGateway {
	private pendingApprovals: Map<string, PendingApproval> = new Map();
	private approvalIdCounter: number = 0;
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

		const approvalId: string = `approval-${this.approvalIdCounter}`;
		this.approvalIdCounter += 1;

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

	async approve(approvalId: string, mcpHost: McpHost): Promise<{ content: string; cached?: boolean | undefined }> {
		const pending: PendingApproval | undefined = this.pendingApprovals.get(approvalId);

		if (!pending) {
			throw new Error(`Approval not found: ${approvalId}`);
		}

		this.pendingApprovals.delete(approvalId);

		const result = await executeLlmToolWithIdempotency(mcpHost, pending.llmToolName, pending.args);
		return { content: result.content, cached: result.reused };
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
