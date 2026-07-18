import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	assertWritableProjectPath,
	getGodotUserDataDir,
	redactSensitivePaths,
	resolveGodotPath,
	resolveProjectPath,
	type GodotPathContext
} from "../../../src/mcp/godot/tools/paths.js";

function makeContext(): GodotPathContext {
	return {
		projectRoot: path.resolve(os.tmpdir(), "daedalus-project"),
		appDataPath: path.resolve(os.tmpdir(), "daedalus-appdata"),
		userProfilePath: path.resolve(os.tmpdir(), "profile-user"),
		projectName: "Daedalus: Test"
	};
}

test("project path resolution rejects traversal", (): void => {
	const context: GodotPathContext = makeContext();
	assert.equal(resolveProjectPath(context.projectRoot, "scripts/player.gd"), path.join(context.projectRoot, "scripts", "player.gd"));
	assert.throws(() => resolveProjectPath(context.projectRoot, "../outside.gd"), /Path traversal denied/);
});

test("writable project paths reject hidden, addons, and unsupported targets", (): void => {
	const context: GodotPathContext = makeContext();
	assert.equal(assertWritableProjectPath(context.projectRoot, "scripts/player.gd"), path.join(context.projectRoot, "scripts", "player.gd"));
	assert.throws(() => assertWritableProjectPath(context.projectRoot, ".godot/editor.cfg"), /hidden directory|Writing to \.godot/);
	assert.throws(() => assertWritableProjectPath(context.projectRoot, "addons/plugin.gd"), /Writing to addons/);
	assert.throws(() => assertWritableProjectPath(context.projectRoot, "textures/icon.png"), /Unsupported writable extension/);
});

test("Godot resource path resolution stays inside allowed roots", (): void => {
	const context: GodotPathContext = makeContext();
	const userDataDir: string = getGodotUserDataDir(context);

	assert.equal(resolveGodotPath("res://scenes/main.tscn", context).absolutePath, path.join(context.projectRoot, "scenes", "main.tscn"));
	assert.equal(resolveGodotPath("user://logs/godot.log", context).absolutePath, path.join(userDataDir, "logs", "godot.log"));
	assert.equal(resolveGodotPath("logs/godot.log", context).absolutePath, path.join(userDataDir, "logs", "godot.log"));
	assert.throws(() => resolveGodotPath("res://../secret.txt", context), /res:\/\/ path traversal denied/);
	assert.throws(() => resolveGodotPath("user://../secret.txt", context), /user:\/\/ path traversal denied/);
	assert.throws(() => resolveGodotPath(path.resolve(os.tmpdir(), "outside.log"), context), /outside allowed Godot project/);
});

test("path redaction hides user paths while preserving project paths", (): void => {
	const context: GodotPathContext = makeContext();
	const projectFile: string = path.join(context.projectRoot, "scripts", "player.gd");
	const privateFile: string = path.join(context.userProfilePath!, "Desktop", "secret.txt");
	const redacted: string = redactSensitivePaths(`${projectFile}\n${privateFile}`, context, false);

	assert.match(redacted, /daedalus-project\/scripts\/player\.gd/);
	assert.doesNotMatch(redacted, /profile-user/);
	assert.match(redacted, /\[user\]/);
	assert.match(redactSensitivePaths(privateFile, context, true), /profile-user/);
});
