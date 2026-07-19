import assert from "node:assert/strict";
import test from "node:test";
import { SessionRuntimeRegistry } from "../../../src/application/session-runtime-registry.js";

test("session runtime registry rejects binding one runtime object to multiple sessions", (): void => {
	const registry = new SessionRuntimeRegistry<{ sessionId?: string }>();
	const runtime = { sessionId: "session-a" };

	assert.equal(registry.bind("session-a", runtime), runtime);
	assert.throws(
		(): void => {
			registry.bind("session-b", runtime);
		},
		/Session runtime is already bound to session-a/
	);
});

test("session runtime registry reuses the existing runtime for the same session", (): void => {
	const registry = new SessionRuntimeRegistry<{ sessionId?: string; marker: string }>();
	const firstRuntime = { sessionId: "session-a", marker: "first" };
	const secondCandidate = { sessionId: "session-a", marker: "second" };

	assert.equal(registry.bind("session-a", firstRuntime), firstRuntime);
	assert.equal(registry.bind("session-a", secondCandidate), firstRuntime);
});
