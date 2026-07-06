import { createHash } from "node:crypto";
import type { ClientSession } from "./client-session.js";

const CUSTOM_INSTRUCTIONS_TRACE_WARNING_CHARS: number = 4000;

export function fingerprintText(text: string): string {
	if (text.length === 0) {
		return "empty";
	}

	return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export function logPromptTrace(params: {
	requestId: string;
	promptId: string | undefined;
	skillId: string | undefined;
	phaseId?: string | undefined;
	customInstructions: string | undefined;
	systemPrompt: string;
	skillPrompt: string;
	mcpSystemContext: string;
	additionalContextSection?: string | undefined;
	guidePromptSection?: string | undefined;
	fullSystemPrompt: string;
}): void {
	const customInstructions: string = params.customInstructions?.trim() ?? "";
	const customTrace: string = customInstructions.length === 0
		? "none"
		: `${customInstructions.length}chars:${fingerprintText(customInstructions)}`;
	const phaseTrace: string = params.phaseId !== undefined ? ` phase=${params.phaseId}` : "";
	console.info(
		[
			`[prompt.trace] request=${params.requestId}${phaseTrace}`,
			`prompt=${params.promptId ?? "default"}`,
			`skill=${params.skillId ?? "none"}`,
			`custom=${customTrace}`,
			`system=${params.systemPrompt.length}chars:${fingerprintText(params.systemPrompt)}`,
			`skillPrompt=${params.skillPrompt.length}chars:${fingerprintText(params.skillPrompt)}`,
			`mcpContext=${params.mcpSystemContext.length}chars:${fingerprintText(params.mcpSystemContext)}`,
			`additionalContext=${(params.additionalContextSection ?? "").length}chars:${fingerprintText(params.additionalContextSection ?? "")}`,
			`guide=${(params.guidePromptSection ?? "").length}chars:${fingerprintText(params.guidePromptSection ?? "")}`,
			`full=${params.fullSystemPrompt.length}chars:${fingerprintText(params.fullSystemPrompt)}`
		].join(" ")
	);
	console.info(
		`[prompt.priority] request=${params.requestId}${phaseTrace} order=runtime_system_and_tool_safety > project_instructions > current_user_message > settings_custom_instructions > defaults`
	);

	if (customInstructions.length >= CUSTOM_INSTRUCTIONS_TRACE_WARNING_CHARS) {
		console.warn(
			`[prompt.warning] request=${params.requestId}${phaseTrace} custom_instructions_long=${customInstructions.length}chars:${fingerprintText(customInstructions)}`
		);
	}
}

export function logProjectInstructionTrace(session: ClientSession, serverId: string, fileName: string, content: string): void {
	const workspaceId: string = session.activeWorkspace?.id ?? "none";
	const sessionId: string = session.sessionId ?? "none";
	console.info(
		`[prompt.project-instruction] session=${sessionId} workspace=${workspaceId} server=${serverId} file=${fileName} chars=${content.length} sha256=${fingerprintText(content)}`
	);
}
