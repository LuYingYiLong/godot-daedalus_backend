import assert from "node:assert/strict";
import test from "node:test";
import { clientRequestEnvelopeSchema, clientRequestSchema } from "../src/protocol/schema.js";
import { isUnsupportedProtocolEnvelope } from "../src/server/websocket-server.js";

test("v2 envelope is required at the WebSocket boundary", (): void => {
	assert.equal(isUnsupportedProtocolEnvelope({ type: "request", id: "legacy", method: "ping", params: {} }), true);
	assert.equal(isUnsupportedProtocolEnvelope({ type: "request", id: "v2", method: "ping", protocolVersion: 2, params: {} }), false);
	assert.equal(isUnsupportedProtocolEnvelope({ type: "event", id: "v2", protocolVersion: 2 }), false);
});

test("v2 client hello explicitly declares its protocol version", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "hello-missing",
		method: "client.hello"
	}).success, false);
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "hello-v2",
		method: "client.hello",
		params: {
			protocolVersion: 2,
			godotExecutablePath: "D:/Godot/Godot.exe"
		}
	}).success, true);
});

test("v2 envelope schema rejects requests without a transport version", (): void => {
	assert.equal(clientRequestEnvelopeSchema.safeParse({
		type: "request",
		id: "missing-envelope",
		method: "ping"
	}).success, false);
	assert.equal(clientRequestEnvelopeSchema.safeParse({
		protocolVersion: 2,
		type: "request",
		id: "ping-v2",
		method: "ping"
	}).success, true);
});
