import type { ChatCompletionMessageToolCall } from "openai/resources/chat/completions";

const DSML_PREFIX_PATTERN: string = "[｜|]+\\s*DSML\\s*[｜|]+";
const TOOL_CALLS_START_PATTERN: RegExp = new RegExp(`<\\s*${DSML_PREFIX_PATTERN}\\s*tool_calls\\s*>`, "i");
const TOOL_CALLS_BLOCK_PATTERN: RegExp = new RegExp(
	`<\\s*${DSML_PREFIX_PATTERN}\\s*tool_calls\\s*>([\\s\\S]*?)(?:<\\/\\s*${DSML_PREFIX_PATTERN}\\s*tool_calls\\s*>|$)`,
	"gi"
);
const INVOKE_PATTERN: RegExp = new RegExp(
	`<\\s*${DSML_PREFIX_PATTERN}\\s*invoke\\s+name="([^"]+)"\\s*>([\\s\\S]*?)<\\/\\s*${DSML_PREFIX_PATTERN}\\s*invoke\\s*>`,
	"gi"
);
const PARAMETER_PATTERN: RegExp = new RegExp(
	`<\\s*${DSML_PREFIX_PATTERN}\\s*parameter\\s+name="([^"]+)"(?:\\s+string="([^"]+)")?\\s*>([\\s\\S]*?)<\\/\\s*${DSML_PREFIX_PATTERN}\\s*parameter\\s*>`,
	"gi"
);

function decodeXmlEntities(text: string): string {
	return text
		.replaceAll("&quot;", "\"")
		.replaceAll("&apos;", "'")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&");
}

function parseParameterValue(rawValue: string, stringFlag: string | undefined): unknown {
	const decoded: string = decodeXmlEntities(rawValue);

	if (stringFlag === undefined || stringFlag.toLowerCase() === "true") {
		return decoded;
	}

	try {
		return JSON.parse(decoded) as unknown;
	} catch {
		return decoded;
	}
}

export function containsDsmlToolCalls(text: string | null | undefined): boolean {
	return text !== null && text !== undefined && TOOL_CALLS_START_PATTERN.test(text);
}

export function stripDsmlToolCalls(text: string): string {
	return text.replace(TOOL_CALLS_BLOCK_PATTERN, "").trim();
}

export function parseDsmlToolCalls(text: string, idPrefix: string = "dsml-tool"): ChatCompletionMessageToolCall[] {
	const toolCalls: ChatCompletionMessageToolCall[] = [];
	let blockMatch: RegExpExecArray | null;

	TOOL_CALLS_BLOCK_PATTERN.lastIndex = 0;
	while ((blockMatch = TOOL_CALLS_BLOCK_PATTERN.exec(text)) !== null) {
		const block: string = blockMatch[1] ?? "";
		let invokeMatch: RegExpExecArray | null;

		INVOKE_PATTERN.lastIndex = 0;
		while ((invokeMatch = INVOKE_PATTERN.exec(block)) !== null) {
			const toolName: string = invokeMatch[1] ?? "";
			const invokeBody: string = invokeMatch[2] ?? "";
			const args: Record<string, unknown> = {};
			let parameterMatch: RegExpExecArray | null;

			PARAMETER_PATTERN.lastIndex = 0;
			while ((parameterMatch = PARAMETER_PATTERN.exec(invokeBody)) !== null) {
				const parameterName: string = parameterMatch[1] ?? "";
				const stringFlag: string | undefined = parameterMatch[2];
				const parameterValue: string = parameterMatch[3] ?? "";

				if (parameterName.length > 0) {
					args[parameterName] = parseParameterValue(parameterValue, stringFlag);
				}
			}

			if (toolName.length > 0) {
				toolCalls.push({
					id: `${idPrefix}-${toolCalls.length + 1}`,
					type: "function",
					function: {
						name: toolName,
						arguments: JSON.stringify(args)
					}
				});
			}
		}
	}

	return toolCalls;
}
