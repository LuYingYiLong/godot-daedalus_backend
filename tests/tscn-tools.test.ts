import assert from "node:assert/strict";
import test from "node:test";
import {
	addNodeToSceneTscn,
	applyScenePatchToTscn,
	attachScriptToSceneTscn,
	connectSignalInSceneTscn,
	findNodeInTscn,
	generateSceneTscn,
	parseTscn,
	validateSceneScriptReferences,
	validateTscnContent
} from "../src/mcp/tscn-tools.js";

const baseScene: string = [
	"[gd_scene format=3]",
	"",
	"[node name=\"Main\" type=\"Control\"]",
	""
].join("\n");

test("TSCN parser reads root nodes and validation catches malformed content", (): void => {
	const data = parseTscn(baseScene);
	assert.equal(data.header?.type, "gd_scene");
	assert.equal(data.nodes.length, 1);
	assert.equal(findNodeInTscn(data, ".")?.name, "Main");
	assert.deepEqual(validateTscnContent(baseScene), []);
	assert.match(validateTscnContent("[node name=\"Main\" type=\"Node\"]").join("\n"), /gd_scene/);
});

test("scene generation and node insertion preserve node structure", (): void => {
	const generated: string = generateSceneTscn("Node2D", "Game");
	assert.equal(findNodeInTscn(parseTscn(generated), ".")?.type, "Node2D");

	const withButton: string = addNodeToSceneTscn(baseScene, ".", "Button", "StartButton", { text: "\"Start\"" });
	const button = findNodeInTscn(parseTscn(withButton), "StartButton");
	assert.equal(button?.type, "Button");
	assert.equal(button?.properties.text, "\"Start\"");
	assert.throws(() => addNodeToSceneTscn(withButton, ".", "Button", "StartButton", {}), /already exists/);
});

test("script attachment rejects missing and already-scripted nodes", (): void => {
	const withButton: string = addNodeToSceneTscn(baseScene, ".", "Button", "StartButton", {});
	const scripted: string = attachScriptToSceneTscn(withButton, "StartButton", "res://scripts/start_button.gd");
	assert.match(scripted, /script = ExtResource\("res:\/\/scripts\/start_button\.gd"\)/);
	assert.throws(() => attachScriptToSceneTscn(scripted, "StartButton", "res://scripts/other.gd"), /already has a script/);
	assert.throws(() => attachScriptToSceneTscn(withButton, "Missing", "res://scripts/missing.gd"), /Node not found/);
});

test("signal connection validates nodes and duplicate connections", (): void => {
	const withButton: string = addNodeToSceneTscn(baseScene, ".", "Button", "StartButton", {});
	const connected: string = connectSignalInSceneTscn(withButton, "pressed", "StartButton", ".", "_on_start_button_pressed");
	const data = parseTscn(connected);

	assert.equal(data.connections.length, 1);
	assert.equal(data.connections[0]?.method, "_on_start_button_pressed");
	assert.throws(() => connectSignalInSceneTscn(connected, "pressed", "StartButton", ".", "_on_start_button_pressed"), /already exists/);
	assert.throws(() => connectSignalInSceneTscn(withButton, "pressed", "Missing", ".", "_on_missing"), /source node not found/);
});

test("scene patch applies ordered operations", (): void => {
	const result = applyScenePatchToTscn(baseScene, [
		{ type: "add_node", parentPath: ".", nodeType: "Button", nodeName: "StartButton", properties: { text: "\"Start\"" } },
		{ type: "connect_signal", signal: "pressed", fromNode: "StartButton", toNode: ".", method: "_on_start_button_pressed" }
	]);
	const data = parseTscn(result.content);

	assert.equal(result.applied.length, 2);
	assert.notEqual(findNodeInTscn(data, "StartButton"), null);
	assert.equal(data.connections.length, 1);
});

test("scene script reference validation catches unique node, path, and signal method issues", (): void => {
	const scene: string = [
		"[gd_scene format=3]",
		"",
		"[node name=\"Main\" type=\"Control\"]",
		"",
		"[node name=\"TitleLabel\" type=\"Label\" parent=\".\"]",
		"",
		"[node name=\"StartButton\" type=\"Button\" parent=\".\"]",
		"",
		"[connection signal=\"pressed\" from=\"StartButton\" to=\".\" method=\"_on_start_button_pressed\"]",
		""
	].join("\n");
	const result = validateSceneScriptReferences(scene, {
		".": [
			"extends Control",
			"",
			"func _ready() -> void:",
			"\t%TitleLabel.text = \"Guess\"",
			"\t$MissingLabel.text = \"Missing\""
		].join("\n")
	});

	assert.equal(result.ok, false);
	assert.deepEqual(result.missingUniqueNames, [".: %TitleLabel"]);
	assert.deepEqual(result.missingNodePaths, [".: $MissingLabel"]);
	assert.deepEqual(result.missingSignalMethods, ["._on_start_button_pressed"]);
});

test("scene script reference validation accepts unique names, paths, and signal methods", (): void => {
	const scene: string = [
		"[gd_scene format=3]",
		"",
		"[node name=\"Main\" type=\"Control\"]",
		"",
		"[node name=\"TitleLabel\" type=\"Label\" parent=\".\"]",
		"unique_name_in_owner = true",
		"",
		"[node name=\"StartButton\" type=\"Button\" parent=\".\"]",
		"",
		"[connection signal=\"pressed\" from=\"StartButton\" to=\".\" method=\"_on_start_button_pressed\"]",
		""
	].join("\n");
	const result = validateSceneScriptReferences(scene, {
		".": [
			"extends Control",
			"",
			"func _ready() -> void:",
			"\t%TitleLabel.text = \"Guess\"",
			"\t$StartButton.text = \"Start\"",
			"",
			"func _on_start_button_pressed() -> void:",
			"\tpass"
		].join("\n")
	});

	assert.equal(result.ok, true);
	assert.deepEqual(result.errors, []);
});
