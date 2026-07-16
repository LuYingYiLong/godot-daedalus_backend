import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { clientRequestSchema } from "../src/protocol/schema.js";
import { REQUEST_HANDLER_METHODS, REQUEST_HANDLERS } from "../src/server/request-dispatcher.js";

const pluginDir: string = process.env.GODOT_DAEDALUS_PLUGIN_DIR ?? "D:/GodotProjects/example/addons/godot_daedalus";

function unique(values: string[]): string[] {
	return Array.from(new Set(values)).sort();
}

function difference(left: string[], right: string[]): string[] {
	const rightSet: Set<string> = new Set(right);
	return left.filter((value: string): boolean => !rightSet.has(value)).sort();
}

async function readBackendSchemaMethods(): Promise<string[]> {
	const schemaPath: string = path.resolve("src/protocol/schema.ts");
	const source: string = await fs.readFile(schemaPath, "utf8");
	return unique([...source.matchAll(/method:\s*z\.literal\("([^"]+)"\)/g)].map((match: RegExpMatchArray): string => match[1]!));
}

async function readFrontendRpcMethods(): Promise<string[]> {
	const rpcMethodsPath: string = path.join(pluginDir, "scripts", "rpc_methods.gd");
	const source: string = await fs.readFile(rpcMethodsPath, "utf8");
	return unique([...source.matchAll(/const\s+[A-Z0-9_]+:\s+String\s+=\s+"([^"]+)"/g)].map((match: RegExpMatchArray): string => match[1]!));
}

test("backend protocol schema and WebSocket dispatcher stay in sync", async (): Promise<void> => {
	const schemaMethods: string[] = await readBackendSchemaMethods();
	const dispatcherMethods: string[] = unique([...REQUEST_HANDLER_METHODS]);

	assert.deepEqual(difference(schemaMethods, dispatcherMethods), [], "schema methods missing dispatcher handler");
	assert.deepEqual(difference(dispatcherMethods, schemaMethods), [], "dispatcher handlers missing schema method");
	for (const method of dispatcherMethods) {
		assert.equal(typeof REQUEST_HANDLERS.get(method as never), "function", `dispatcher handler missing implementation: ${method}`);
	}
	assert.ok(new Set([...REQUEST_HANDLERS.values()]).size > 1, "dispatcher must use domain-specific handlers");
});

test("frontend RPC constants match backend protocol schema", async (): Promise<void> => {
	const schemaMethods: string[] = await readBackendSchemaMethods();
	const frontendMethods: string[] = await readFrontendRpcMethods();

	assert.deepEqual(difference(schemaMethods, frontendMethods), [], "schema methods missing frontend RPC constant");
	assert.deepEqual(difference(frontendMethods, schemaMethods), [], "frontend RPC constants missing schema method");
});

test("session.timeline accepts omitted beforeOffset as latest page request", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "timeline-latest",
		method: "session.timeline",
		params: {
			sessionId: "session-test",
			limit: 20
		}
	}).success, true);
});

test("session.timeline accepts afterOffset page request", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "timeline-after",
		method: "session.timeline",
		params: {
			sessionId: "session-test",
			afterOffset: 80,
			limit: 20
		}
	}).success, true);
});

test("workspace.delete accepts workspace id", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "workspace-delete",
		method: "workspace.delete",
		params: {
			workspaceId: "workspace-a"
		}
	}).success, true);
});

test("session.workflow.todo.dismiss accepts optional workflow identity", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "todo-dismiss",
		method: "session.workflow.todo.dismiss",
		params: {
			workflowId: "workflow-a",
			runId: "workflow-run-a"
		}
	}).success, true);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "todo-dismiss-empty",
		method: "session.workflow.todo.dismiss"
	}).success, true);
});
