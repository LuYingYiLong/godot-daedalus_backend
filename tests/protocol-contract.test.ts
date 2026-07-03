import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

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

async function readBackendServerCases(): Promise<string[]> {
	const serverPath: string = path.resolve("src/server/websocket-server.ts");
	const source: string = await fs.readFile(serverPath, "utf8");
	return unique([...source.matchAll(/case "([^"]+)":/g)].map((match: RegExpMatchArray): string => match[1]!));
}

async function readFrontendRpcMethods(): Promise<string[]> {
	const rpcMethodsPath: string = path.join(pluginDir, "scripts", "rpc_methods.gd");
	const source: string = await fs.readFile(rpcMethodsPath, "utf8");
	return unique([...source.matchAll(/const\s+[A-Z0-9_]+:\s+String\s+=\s+"([^"]+)"/g)].map((match: RegExpMatchArray): string => match[1]!));
}

test("backend protocol schema and WebSocket dispatcher stay in sync", async (): Promise<void> => {
	const schemaMethods: string[] = await readBackendSchemaMethods();
	const serverCases: string[] = await readBackendServerCases();

	assert.deepEqual(difference(schemaMethods, serverCases), [], "schema methods missing server case");
	assert.deepEqual(difference(serverCases, schemaMethods), [], "server cases missing schema method");
});

test("frontend RPC constants match backend protocol schema", async (): Promise<void> => {
	const schemaMethods: string[] = await readBackendSchemaMethods();
	const frontendMethods: string[] = await readFrontendRpcMethods();

	assert.deepEqual(difference(schemaMethods, frontendMethods), [], "schema methods missing frontend RPC constant");
	assert.deepEqual(difference(frontendMethods, schemaMethods), [], "frontend RPC constants missing schema method");
});
