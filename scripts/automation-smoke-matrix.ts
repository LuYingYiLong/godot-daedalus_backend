import { createAutomationConfig } from "../src/mcp/automation/config.js";
import { AutomationRpcClient, type AutomationServerMessage } from "../src/mcp/automation/rpc-client.js";

type Scenario = "health" | "runtime_status" | "plan_clarify";

type CliOptions = {
	backendUrl?: string | undefined;
	scenarios: Scenario[];
	useLlm: boolean;
	workspaceId?: string | undefined;
	projectPath?: string | undefined;
	godotExecutablePath?: string | undefined;
	prompt: string;
	timeoutMs: number;
};

const DEFAULT_TIMEOUT_MS: number = 180_000;
const DEFAULT_PLAN_PROMPT: string = "帮我做一个 godot ai 插件";

function parseRawArgs(argv: string[]): Map<string, string | boolean> {
	const values: Map<string, string | boolean> = new Map();
	for (const arg of argv) {
		const normalized: string = arg.startsWith("--") ? arg.slice(2) : arg;
		const equalsIndex: number = normalized.indexOf("=");
		if (equalsIndex >= 0) {
			values.set(normalized.slice(0, equalsIndex).trim(), normalized.slice(equalsIndex + 1));
		} else if (normalized.trim().length > 0) {
			values.set(normalized.trim(), true);
		}
	}
	return values;
}

function getStringArg(values: Map<string, string | boolean>, ...names: string[]): string | undefined {
	for (const name of names) {
		const value: string | boolean | undefined = values.get(name);
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	return undefined;
}

function parseBoolean(value: string | boolean | undefined): boolean {
	if (value === true) {
		return true;
	}
	if (typeof value !== "string") {
		return false;
	}
	const normalized: string = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parseTimeout(value: string | undefined): number {
	if (value === undefined) {
		return DEFAULT_TIMEOUT_MS;
	}
	const parsed: number = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 1000) {
		throw new Error(`Invalid timeout_ms: ${value}`);
	}
	return parsed;
}

function parseScenarios(value: string | undefined): Scenario[] {
	if (value === undefined || value === "matrix") {
		return ["health", "runtime_status"];
	}
	const scenarios: Scenario[] = [];
	for (const entry of value.split(",")) {
		const normalized: string = entry.trim();
		if (normalized === "") {
			continue;
		}
		if (normalized !== "health" && normalized !== "runtime_status" && normalized !== "plan_clarify") {
			throw new Error(`Unknown automation smoke scenario: ${entry}`);
		}
		scenarios.push(normalized as Scenario);
	}
	if (scenarios.length === 0) {
		throw new Error("At least one scenario is required.");
	}
	return scenarios;
}

function parseOptions(argv: string[]): CliOptions {
	const values: Map<string, string | boolean> = parseRawArgs(argv);
	return {
		backendUrl: getStringArg(values, "backend_url", "backend-url"),
		scenarios: parseScenarios(getStringArg(values, "scenario", "scenarios")),
		useLlm: values.has("use_llm") || values.has("usellm") || parseBoolean(values.get("llm")),
		workspaceId: getStringArg(values, "workspace_id", "workspace-id"),
		projectPath: getStringArg(values, "project", "project_path", "godot_project_path"),
		godotExecutablePath: getStringArg(values, "godot", "godot_executable_path"),
		prompt: getStringArg(values, "prompt", "message") ?? DEFAULT_PLAN_PROMPT,
		timeoutMs: parseTimeout(getStringArg(values, "timeout_ms", "timeout-ms"))
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new Error(`${label} did not return an object.`);
	}
	return value;
}

function createSessionId(result: unknown): string {
	const record: Record<string, unknown> = assertRecord(result, "session.create");
	for (const key of ["id", "sessionId"]) {
		const value: unknown = record[key];
		if (typeof value === "string" && value.length > 0) {
			return value;
		}
	}
	const session: unknown = record.session;
	if (isRecord(session) && typeof session.id === "string" && session.id.length > 0) {
		return session.id;
	}
	throw new Error("session.create response did not include a session id.");
}

function getEventName(message: AutomationServerMessage): string | undefined {
	return typeof message.raw.event === "string" ? message.raw.event : undefined;
}

async function waitForAnyEvent(
	client: AutomationRpcClient,
	eventNames: readonly string[],
	requestId: string,
	afterSequence: number,
	timeoutMs: number
): Promise<AutomationServerMessage> {
	const deadline: number = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const found: AutomationServerMessage | undefined = client.messages.find((message: AutomationServerMessage): boolean => {
			if (message.sequence <= afterSequence) {
				return false;
			}
			if (!eventNames.includes(getEventName(message) ?? "")) {
				return false;
			}
			const data: unknown = message.raw.data;
			return message.raw.requestId === requestId
				|| (isRecord(data) && data.requestId === requestId)
				|| JSON.stringify(message.raw).includes(requestId);
		});
		if (found !== undefined) {
			return found;
		}
		await new Promise<void>((resolve): void => {
			setTimeout(resolve, 250);
		});
	}
	throw new Error(`Timed out waiting for one of ${eventNames.join(", ")} for ${requestId}.`);
}

async function runHealth(client: AutomationRpcClient, options: CliOptions): Promise<void> {
	const health: Record<string, unknown> = assertRecord(await client.sendRequest("backend.health", undefined, options.timeoutMs), "backend.health");
	if (health.name !== "godot-daedalus-backend" || !isRecord(health.multiClient)) {
		throw new Error(`backend.health did not report ok: ${JSON.stringify(health)}`);
	}
	console.log("[health] ok");
}

async function configureEnvironment(client: AutomationRpcClient, options: CliOptions): Promise<void> {
	if (options.projectPath === undefined) {
		return;
	}
	const params: Record<string, unknown> = {
		godotProjectPath: options.projectPath
	};
	if (options.godotExecutablePath !== undefined) {
		params.godotExecutablePath = options.godotExecutablePath;
	}
	const result: Record<string, unknown> = assertRecord(
		await client.sendRequest("environment.configure", params, options.timeoutMs),
		"environment.configure"
	);
	if (typeof result.workspaceId === "string" && result.workspaceId.length > 0) {
		options.workspaceId = result.workspaceId;
	}
	console.log(`[environment] ok workspace=${String(result.workspaceId ?? "none")}`);
}

async function createSmokeSession(client: AutomationRpcClient, options: CliOptions, title: string): Promise<string> {
	const params: Record<string, unknown> = { title };
	if (options.workspaceId !== undefined) {
		params.workspaceId = options.workspaceId;
	}
	const sessionId: string = createSessionId(await client.sendRequest("session.create", params, options.timeoutMs));
	await client.sendRequest("session.open", { sessionId, limit: 100 }, options.timeoutMs);
	return sessionId;
}

async function runRuntimeStatus(client: AutomationRpcClient, options: CliOptions): Promise<void> {
	const sessionId: string = await createSmokeSession(client, options, `Automation runtime smoke ${new Date().toISOString()}`);
	const info: Record<string, unknown> = assertRecord(await client.sendRequest("session.info", {}, options.timeoutMs), "session.info");
	if (!isRecord(info.godotRuntime)) {
		throw new Error("session.info did not include godotRuntime.");
	}
	if (!Array.isArray((info.godotRuntime as Record<string, unknown>).mcpServers)) {
		throw new Error("godotRuntime did not include mcpServers.");
	}
	console.log(`[runtime_status] ok session=${sessionId}`);
}

async function runPlanClarify(client: AutomationRpcClient, options: CliOptions): Promise<void> {
	if (!options.useLlm) {
		throw new Error("scenario=plan_clarify requires use_llm because it calls the configured provider.");
	}
	const sessionId: string = await createSmokeSession(client, options, `Automation plan smoke ${new Date().toISOString()}`);
	const afterSequence: number = client.messages.at(-1)?.sequence ?? 0;
	const requestId: string = await client.sendRequestNoWait("ai.chat", {
		message: options.prompt,
		mode: "plan"
	});
	const event: AutomationServerMessage = await waitForAnyEvent(
		client,
		["plan.clarification.required", "plan.generated", "plan.revised", "plan.error"],
		requestId,
		afterSequence,
		options.timeoutMs
	);
	if (getEventName(event) === "plan.error") {
		throw new Error(`Plan smoke returned plan.error: ${JSON.stringify(event.raw)}`);
	}
	console.log(`[plan_clarify] ok session=${sessionId} request=${requestId} event=${getEventName(event)}`);
}

async function main(): Promise<void> {
	const options: CliOptions = parseOptions(process.argv.slice(2));
	const env: NodeJS.ProcessEnv = {
		...process.env,
		DAEDALUS_AUTOMATION_MCP: "1",
		...(options.backendUrl === undefined ? {} : { DAEDALUS_AUTOMATION_BACKEND_URL: options.backendUrl }),
		DAEDALUS_AUTOMATION_REQUEST_TIMEOUT_MS: String(options.timeoutMs)
	};
	const client: AutomationRpcClient = new AutomationRpcClient(createAutomationConfig(env, []));
	try {
		await configureEnvironment(client, options);
		for (const scenario of options.scenarios) {
			if (scenario === "health") {
				await runHealth(client, options);
			} else if (scenario === "runtime_status") {
				await runRuntimeStatus(client, options);
			} else {
				await runPlanClarify(client, options);
			}
		}
		console.log("[automation-smoke] all scenarios passed");
	} finally {
		await client.close();
	}
}

main().catch((error: unknown): void => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
