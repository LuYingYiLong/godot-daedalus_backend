import assert from "node:assert/strict";
import test from "node:test";
import {
	createFallbackSessionTitle,
	isFirstSessionUserTurn,
	normalizeGeneratedSessionTitle,
	shouldApplyGeneratedSessionTitle
} from "../../../src/server/session-title.js";
import type { ChatMessage } from "../../../src/protocol/types.js";

test("fallback session title is language-neutral and based on user message", (): void => {
	assert.equal(createFallbackSessionTitle("/skill   修复 Godot 启动流程"), "修复 Godot 启动流程");
	assert.equal(createFallbackSessionTitle("abcdefghijklmnopqrstuvwxyz0123456789"), "abcdefghijklmnopqrstuvwxyz01");
	assert.equal(createFallbackSessionTitle(""), "Untitled");
});

test("auto title applies only when title has not changed since scheduling", (): void => {
	assert.equal(shouldApplyGeneratedSessionTitle("Any localized placeholder", "Any localized placeholder"), true);
	assert.equal(shouldApplyGeneratedSessionTitle("任意语言的临时标题", "任意语言的临时标题"), true);
	assert.equal(shouldApplyGeneratedSessionTitle("Temporary", "User renamed"), false);
});

test("generated title is cleaned and clipped", (): void => {
	assert.equal(normalizeGeneratedSessionTitle("\"标题：修复后端启动失败。\""), "修复后端启动失败");
	const clipped: string = normalizeGeneratedSessionTitle("abcdefghijklmnopqrstuvwxyz0123456789");
	assert.equal(clipped, "abcdefghijklmnopqrstuvwxyz01");
	assert.equal(clipped.length, 28);
});

test("first-turn detection ignores a user message pre-persisted for the current request", (): void => {
	const currentRequestMessage: ChatMessage = {
		role: "user",
		content: "创建一个井字棋",
		requestId: "request-current"
	};

	assert.equal(isFirstSessionUserTurn([], "request-current"), true);
	assert.equal(isFirstSessionUserTurn([currentRequestMessage], "request-current"), true);
	assert.equal(isFirstSessionUserTurn([
		currentRequestMessage,
		{ role: "user", content: "上一轮消息", requestId: "request-previous" }
	], "request-current"), false);
});

test("title generation is scheduled before plan and agent execution branch", async (): Promise<void> => {
	const source: string = await import("node:fs/promises").then(({ readFile }) => (
		readFile(new URL("../../../src/server/chat-orchestrator.ts", import.meta.url), "utf8")
	));
	const scheduleIndex: number = source.indexOf("maybeScheduleSessionTitleGeneration(socket, request.id");
	const planBranchIndex: number = source.indexOf('if (effectiveParams.mode === "plan")');
	const userPersistenceIndex: number = source.indexOf("await appendUserMessageToSession(");

	assert.ok(scheduleIndex >= 0);
	assert.ok(planBranchIndex > scheduleIndex);
	assert.ok(userPersistenceIndex > scheduleIndex);
});
