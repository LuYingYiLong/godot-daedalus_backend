import assert from "node:assert/strict";
import test from "node:test";
import {
	createFallbackSessionTitle,
	normalizeGeneratedSessionTitle,
	shouldApplyGeneratedSessionTitle
} from "../src/server/session-title.js";

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
