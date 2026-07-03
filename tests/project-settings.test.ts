import assert from "node:assert/strict";
import test from "node:test";
import {
	applyProjectSettingSetToContent,
	applyProjectSettingUnsetToContent,
	findProjectSettingEntry,
	normalizeProjectSettingValueExpression,
	parseProjectSettings,
	proposeProjectSettingSet,
	proposeProjectSettingUnset,
	splitProjectSettingKey
} from "../src/mcp/godot-project-settings.js";

const projectConfig: string = [
	"[application]",
	"config/name=\"Daedalus\"",
	"",
	"[debug]",
	"file_logging/enable_file_logging.pc=true",
	""
].join("\n");

test("project settings parser reads sections and keys", (): void => {
	const document = parseProjectSettings(projectConfig);
	assert.equal(findProjectSettingEntry(document, "application/config/name")?.valueExpression, "\"Daedalus\"");
	assert.equal(findProjectSettingEntry(document, "debug/file_logging/enable_file_logging.pc")?.valueExpression, "true");
	assert.deepEqual(splitProjectSettingKey("debug/file_logging/log_path"), {
		section: "debug/file_logging",
		name: "log_path"
	});
});

test("project setting set updates existing keys and inserts new sections", (): void => {
	const renamed: string = applyProjectSettingSetToContent(projectConfig, "application/config/name", "\"Renamed\"");
	assert.equal(findProjectSettingEntry(parseProjectSettings(renamed), "application/config/name")?.valueExpression, "\"Renamed\"");

	const withNewSection: string = applyProjectSettingSetToContent(projectConfig, "display/window/size/viewport_width", "1280");
	assert.equal(findProjectSettingEntry(parseProjectSettings(withNewSection), "display/window/size/viewport_width")?.valueExpression, "1280");
	assert.match(withNewSection, /\[display\/window\/size\]/);
});

test("project setting unset removes only the requested entry", (): void => {
	const nextContent: string = applyProjectSettingUnsetToContent(projectConfig, "debug/file_logging/enable_file_logging.pc");
	const document = parseProjectSettings(nextContent);

	assert.equal(findProjectSettingEntry(document, "debug/file_logging/enable_file_logging.pc"), undefined);
	assert.equal(findProjectSettingEntry(document, "application/config/name")?.valueExpression, "\"Daedalus\"");
});

test("project setting proposals validate without mutating callers", (): void => {
	assert.equal(proposeProjectSettingSet(projectConfig, "application/config/name", "\"Next\"").valid, true);
	assert.equal(proposeProjectSettingUnset(projectConfig, "application/config/name").removed, true);
});

test("project setting value validation rejects unsafe expressions", (): void => {
	assert.throws(() => normalizeProjectSettingValueExpression("[section]\nvalue"), /section headers/);
	assert.throws(() => normalizeProjectSettingValueExpression("PackedStringArray(\"a\""), /unbalanced/);
	assert.throws(() => splitProjectSettingKey("invalid"), /Invalid project setting key/);
});
