import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeJsonFileAtomic, writeJsonFileAtomicSync } from "../../../src/json-file-store.js";

test("writeJsonFileAtomic creates parent directory and writes utf8 json with trailing newline", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-json-store-"));
	const filePath: string = join(root, "nested", "config.json");
	const value = {
		name: "中文",
		enabled: true
	};

	try {
		await writeJsonFileAtomic(filePath, value);
		assert.equal(await readFile(filePath, "utf8"), `${JSON.stringify(value, null, 2)}\n`);
		assert.deepEqual(await readdir(join(root, "nested")), ["config.json"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("writeJsonFileAtomicSync creates parent directory and leaves no temp file after success", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-json-store-sync-"));
	const filePath: string = join(root, "nested", "config.json");
	const value = {
		version: 1,
		items: ["a", "b"]
	};

	try {
		writeJsonFileAtomicSync(filePath, value);
		assert.equal(await readFile(filePath, "utf8"), `${JSON.stringify(value, null, 2)}\n`);
		assert.deepEqual(await readdir(join(root, "nested")), ["config.json"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
