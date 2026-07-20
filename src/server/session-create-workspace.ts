import type { ClientType } from "./client-connections.js";

export function resolveSessionCreateWorkspaceId(params: {
	requestedWorkspaceId: string | null | undefined;
	clientType: ClientType | undefined;
	activeWorkspaceId: string | undefined;
}): string | undefined {
	if (params.requestedWorkspaceId === null) {
		return undefined;
	}
	if (params.requestedWorkspaceId !== undefined) {
		return params.requestedWorkspaceId;
	}
	return params.clientType === "godot_plugin" ? params.activeWorkspaceId : undefined;
}
