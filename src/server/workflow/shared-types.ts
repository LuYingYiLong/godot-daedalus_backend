import type { ProviderAgentResult } from "../../providers/agent-types.js";
import type { AdditionalContextItem } from "../../protocol/types.js";
import type { WorkflowToolObservation } from "../../workflow/types.js";

export type WorkflowPhaseToolStats = {
	toolEvents: number;
	proposeToolEvents: number;
	writeToolEvents: number;
	successfulProposeToolEvents: number;
	successfulWriteToolEvents: number;
	approvalEvents: number;
	toolCallRisks: Record<string, string | undefined>;
};

export type WorkflowPhaseRunResult = {
	agentResult: ProviderAgentResult;
	toolStats: WorkflowPhaseToolStats;
	toolObservations: WorkflowToolObservation[];
	capturedAttachments: AdditionalContextItem[];
};
