import assert from "node:assert/strict";
import test from "node:test";
import {
	matchesWebSocketAuth,
	WEBSOCKET_AUTH_PROTOCOL_PREFIX
} from "../../../src/server/websocket-server.js";

test("WebSocket authentication accepts main-process Bearer credentials", (): void => {
	assert.equal(matchesWebSocketAuth("Bearer studio-token", undefined, "studio-token"), true);
	assert.equal(matchesWebSocketAuth("Bearer wrong-token", undefined, "studio-token"), false);
});

test("WebSocket authentication accepts the renderer subprotocol credential", (): void => {
	assert.equal(
		matchesWebSocketAuth(
			undefined,
			`chat, ${WEBSOCKET_AUTH_PROTOCOL_PREFIX}studio-token`,
			"studio-token"
		),
		true
	);
	assert.equal(
		matchesWebSocketAuth(
			undefined,
			`${WEBSOCKET_AUTH_PROTOCOL_PREFIX}wrong-token`,
			"studio-token"
		),
		false
	);
});

test("WebSocket authentication stays optional in source development mode", (): void => {
	assert.equal(matchesWebSocketAuth(undefined, undefined, undefined), true);
	assert.equal(matchesWebSocketAuth(undefined, undefined, ""), true);
	assert.equal(matchesWebSocketAuth(undefined, undefined, "studio-token"), false);
});
