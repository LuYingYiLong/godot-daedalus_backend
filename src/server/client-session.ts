import type { AiChatParams, ChatMessage, ModelProfile, ProviderId } from "../protocol/types.js";
import type { SessionMetadata } from "../session/session-store.js";
import type { PendingAiContinuation } from "../session/pending-continuation.js";
import { ApprovalGateway } from "../tools/approval-gateway.js";
import { getDefaultModelProfile } from "../tokens/model-profiles.js";
import type { WorkspaceConfig } from "../workspace/types.js";

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

export type { PendingAiContinuation } from "../session/pending-continuation.js";

export type ClientSession = {
	activeProvider: ProviderId;
	providerApiKey?: string | undefined;
	providerModel?: string | undefined;
	providerBaseUrl?: string | undefined;
	godotExecutablePath?: string | undefined;
	godotProjectPath?: string | undefined;
	messages: ChatMessage[];
	modelProfile: ModelProfile;
	approvalGateway: ApprovalGateway;
	activeWorkspace?: WorkspaceConfig | undefined;
	editorInstanceId?: string | undefined;
	sessionId?: string | undefined;
	sessionTitle?: string | undefined;
	summaryMessage?: ChatMessage | undefined;
	summaryCoveredMessageCount?: number | undefined;
	pendingAiContinuations: Map<string, PendingAiContinuation>;
	aiDeltaEventBuffers: Map<string, ThinkingEventBuffer>;
	thinkingEventBuffers: Map<string, ThinkingEventBuffer>;
	activeAbortControllers: Map<string, AbortController>;
	inFlightRequestIds: Set<string>;
	completedRequestIds: Map<string, number>;
	eventPersistQueue: Promise<void>;
	pendingGuides: PendingGuide[];
	fullSessionLoadPromise?: Promise<void> | undefined;
	activeRunRequestId?: string | undefined;
};

export function createClientSession(defaultWorkspace: WorkspaceConfig | undefined): ClientSession {
	return {
		activeProvider: "deepseek",
		messages: [],
		modelProfile: getDefaultModelProfile(),
		approvalGateway: new ApprovalGateway(),
		activeWorkspace: defaultWorkspace,
		pendingAiContinuations: new Map(),
		aiDeltaEventBuffers: new Map(),
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
	session.aiDeltaEventBuffers.clear();
	session.thinkingEventBuffers.clear();
}

export function applySessionMetadata(session: ClientSession, metadata: SessionMetadata): void {
	session.sessionId = metadata.id;
	session.sessionTitle = metadata.title;
}
