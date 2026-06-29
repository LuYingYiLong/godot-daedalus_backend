import type { McpHost } from "../mcp/mcp-host.js";
import { evaluateToolCall, type ApprovalDecision, type ApprovalMode, getToolPolicy } from "./tool-policy.js";
import { resolveToolMapping, MAX_TOOL_RESULT_CHARS } from "./llm-tools.js";

export type PendingApproval = {
	approvalId: string;
	toolCallId: string;
	toolName: string;
	llmToolName: string;
	args: Record<string, unknown>;
	reason: string;
	createdAt: number;
};

export type ApprovalResult =
	| { status: "executed"; content: string }
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
		reason: string
	): PendingApproval {
		const approvalId: string = `approval-${this.approvalIdCounter}`;
		this.approvalIdCounter += 1;

		const pending: PendingApproval = {
			approvalId,
			toolCallId,
			toolName: llmToolName,
			llmToolName,
			args,
			reason,
			createdAt: Date.now()
		};

		this.pendingApprovals.set(approvalId, pending);
		return pending;
	}

	async approve(approvalId: string, mcpHost: McpHost): Promise<{ content: string }> {
		const pending: PendingApproval | undefined = this.pendingApprovals.get(approvalId);

		if (!pending) {
			throw new Error(`Approval not found: ${approvalId}`);
		}

		this.pendingApprovals.delete(approvalId);

		const mapping = resolveToolMapping(pending.llmToolName);
		const result = await mcpHost.callTool(mapping.serverId, mapping.toolName, pending.args) as {
			content: Array<{ type: string; text?: string }>;
		};
		const firstContent = result.content[0];
		let textResult: string;

		if (firstContent !== undefined && "text" in firstContent) {
			textResult = firstContent.text as string;
		} else {
			textResult = JSON.stringify(result);
		}

		if (textResult.length > MAX_TOOL_RESULT_CHARS) {
			textResult = textResult.slice(0, MAX_TOOL_RESULT_CHARS) + `\n\n[结果已截断，原始长度 ${textResult.length} 字符]`;
		}

		return { content: textResult };
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
