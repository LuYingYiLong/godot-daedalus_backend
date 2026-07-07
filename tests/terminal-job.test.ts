import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startCommandJob, runCommandWait } from "../src/mcp/terminal/process-runner.js";
import { terminalJobStore } from "../src/mcp/terminal/job-store.js";
import type { CommandPreset, TerminalJobRecord } from "../src/mcp/terminal/types.js";
import { parseToolResultSummary } from "../src/tools/tool-result-parser.js";

function nodePreset(command: string): { preset: CommandPreset; command: string[] } {
	return {
		preset: {
			name: "test.node",
			description: "Node test command",
			command: [process.execPath, "-e", command],
			workingDirectory: process.cwd(),
			risk: "verify"
		},
		command: [process.execPath, "-e", command]
	};
}

async function withAppData<T>(fn: () => Promise<T>): Promise<T> {
	const previousAppData: string | undefined = process.env.APPDATA;
	const root: string = await mkdtemp(join(tmpdir(), "terminal-job-"));
	process.env.APPDATA = root;
	try {
		return await fn();
	} finally {
		if (previousAppData === undefined) {
			delete process.env.APPDATA;
		} else {
			process.env.APPDATA = previousAppData;
		}
		await rm(root, { recursive: true, force: true });
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve): void => {
		setTimeout(resolve, ms);
	});
}

test("terminal wait mode preserves immediate command result shape", async (): Promise<void> => {
	await withAppData(async (): Promise<void> => {
		const { preset, command } = nodePreset("console.log('wait-ok')");
		const result = await runCommandWait({
			preset,
			command,
			cwd: process.cwd(),
			timeoutMs: 5000
		});

		assert.equal(result.ok, true);
		assert.equal(result.exitCode, 0);
		assert.match(result.stdout, /wait-ok/);
		assert.equal(result.preset, "test.node");
	});
});

test("terminal job mode returns job id and later completed status", async (): Promise<void> => {
	await withAppData(async (): Promise<void> => {
		const { preset, command } = nodePreset("setTimeout(() => { console.log('job-ok') }, 50)");
		const started: TerminalJobRecord = startCommandJob({
			preset,
			command,
			cwd: process.cwd(),
			timeoutMs: 5000,
			wakeAfterMs: 100,
			tailLines: 10
		});

		assert.equal(started.status, "running");
		assert.match(started.jobId, /^terminal-job-/);
		await sleep(250);

		const record: TerminalJobRecord | null = await terminalJobStore.get(started.jobId);
		assert.notEqual(record, null);
		assert.equal(record?.status, "completed");
		assert.equal(record?.exitCode, 0);
		assert.match(record?.stdoutTail ?? "", /job-ok/);
	});
});

test("terminal job can be cancelled", async (): Promise<void> => {
	await withAppData(async (): Promise<void> => {
		const { preset, command } = nodePreset("setTimeout(() => { console.log('late') }, 5000)");
		const started: TerminalJobRecord = startCommandJob({
			preset,
			command,
			cwd: process.cwd(),
			timeoutMs: 10000,
			tailLines: 10
		});

		const cancelled: TerminalJobRecord = await terminalJobStore.cancel(started.jobId);
		assert.equal(cancelled.status, "cancelled");
	});
});

test("terminal job result parser exposes running job wakeup metadata", (): void => {
	const summary = parseToolResultSummary(
		"mcp_terminal_run_safe_preset",
		{ presetName: "backend.typecheck" },
		JSON.stringify({
			preset: "backend.typecheck",
			status: "running",
			jobId: "terminal-job-test",
			wakeAfterMs: 1000
		})
	);

	assert.equal(summary.validationStatus, "unknown");
	assert.equal(summary.terminalJobId, "terminal-job-test");
	assert.equal(summary.terminalJobStatus, "running");
	assert.equal(summary.terminalJobWakeAfterMs, 1000);
});
