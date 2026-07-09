import type { ProviderAgentResult } from "../../providers/agent-types.js";
import type { AdditionalContextItem } from "../../protocol/types.js";
import type { WorkflowToolObservation } from "../../workflow/types.js";

export type WorkflowPhaseToolStats = {
	toolEvents: number;
	proposeToolEvents: number;
	writeToolEvents: number;
	approvalEvents: number;
};

export type WorkflowPhaseRunResult = {
	agentResult: ProviderAgentResult;
	toolStats: WorkflowPhaseToolStats;
	toolObservations: WorkflowToolObservation[];
	capturedAttachments: AdditionalContextItem[];
};
