import type { AiChatParams, ChatMessage, ModelProfile } from "../protocol/types.js";
import type { DeepSeekAgentContinuation } from "../providers/deepseek-agent.js";
import type { DeepSeekChatOptions } from "../providers/deepseek-client.js";
import type { SessionMetadata } from "../session/session-store.js";
import { ApprovalGateway } from "../tools/approval-gateway.js";
import type { SkillId } from "../skills/registry.js";
import { getDefaultModelProfile } from "../tokens/model-profiles.js";
import type { WorkspaceConfig } from "../workspace/types.js";
import type { WorkflowRunState } from "../workflow/types.js";

export type PendingGuide = {
	id: string;
	clientGuideId: string;
	text: string;
	anchorRequestId?: string | undefined;
	createdAt: string;
	updatedAt: string;
};

export type ThinkingEventBuffer = {
	sessionId: string;
	requestId: string;
	text: string;
};

export type PendingAiContinuation = {
	params: AiChatParams;
	options: DeepSeekChatOptions;
	continuation: DeepSeekAgentContinuation;
	allowedToolNames?: readonly string[] | undefined;
	userMessage: string;
	requestId: string;
	userCreatedAt: string;
	stream: boolean;
	workflowState?: WorkflowRunState | undefined;
};

export type ClientSession = {
	deepseekApiKey?: string | undefined;
	deepseekModel?: string | undefined;
	deepseekBaseUrl?: string | undefined;
	godotExecutablePath?: string | undefined;
	godotProjectPath?: string | undefined;
	messages: ChatMessage[];
	modelProfile: ModelProfile;
	approvalGateway: ApprovalGateway;
	activeSkillId?: SkillId | undefined;
	activeWorkspace?: WorkspaceConfig | undefined;
	sessionId?: string | undefined;
	sessionTitle?: string | undefined;
	summaryMessage?: ChatMessage | undefined;
	summaryCoveredMessageCount?: number | undefined;
	pendingAiContinuations: Map<string, PendingAiContinuation>;
	thinkingEventBuffers: Map<string, ThinkingEventBuffer>;
	activeAbortControllers: Map<string, AbortController>;
	inFlightRequestIds: Set<string>;
	completedRequestIds: Map<string, number>;
	eventPersistQueue: Promise<void>;
	pendingGuides: PendingGuide[];
	fullSessionLoadPromise?: Promise<void> | undefined;
};

export function createClientSession(defaultWorkspace: WorkspaceConfig | undefined): ClientSession {
	return {
		messages: [],
		modelProfile: getDefaultModelProfile(),
		approvalGateway: new ApprovalGateway(),
		activeWorkspace: defaultWorkspace,
		pendingAiContinuations: new Map(),
		thinkingEventBuffers: new Map(),
		activeAbortControllers: new Map(),
		inFlightRequestIds: new Set(),
		completedRequestIds: new Map(),
		pendingGuides: [],
		eventPersistQueue: Promise.resolve()
	};
}

export function clearActiveSession(session: ClientSession): void {
	session.sessionId = undefined;
	session.sessionTitle = undefined;
	session.messages = [];
	session.fullSessionLoadPromise = undefined;
	session.summaryMessage = undefined;
	session.summaryCoveredMessageCount = undefined;
	session.pendingGuides = [];
}

export function applySessionMetadata(session: ClientSession, metadata: SessionMetadata): void {
	session.sessionId = metadata.id;
	session.sessionTitle = metadata.title;
	session.activeSkillId = metadata.activeSkillId as SkillId | undefined;
}
