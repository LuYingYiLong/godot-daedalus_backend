import assert from "node:assert/strict";
import test from "node:test";
import {
	getStudioParentPidFromEnv,
	startStudioParentMonitor
} from "../../../src/runtime/parent-monitor.js";

test("Studio parent PID parsing is optional and rejects unsafe values", (): void => {
	assert.equal(getStudioParentPidFromEnv({}), null);
	assert.equal(getStudioParentPidFromEnv({ DAEDALUS_STUDIO_PID: "4242" }), 4242);
	assert.throws(
		() => getStudioParentPidFromEnv({ DAEDALUS_STUDIO_PID: "not-a-pid" }),
		/must be a positive process ID/u
	);
	assert.throws(
		() => getStudioParentPidFromEnv({ DAEDALUS_STUDIO_PID: String(process.pid) }),
		/must identify another live process/u
	);
});

test("Studio parent monitor notifies once when its parent disappears", async (): Promise<void> => {
	const previousParentPid: string | undefined = process.env.DAEDALUS_STUDIO_PID;
	process.env.DAEDALUS_STUDIO_PID = "4242";
	let notificationCount: number = 0;
	try {
		const notified = new Promise<void>((resolveNotification): void => {
			startStudioParentMonitor((): void => {
				notificationCount += 1;
				resolveNotification();
			}, {
				intervalMs: 1,
				isAlive: (): boolean => false
			});
		});
		await notified;
		await new Promise((resolveWait): void => {
			setTimeout(resolveWait, 5);
		});
		assert.equal(notificationCount, 1);
	} finally {
		if (previousParentPid === undefined) {
			delete process.env.DAEDALUS_STUDIO_PID;
		} else {
			process.env.DAEDALUS_STUDIO_PID = previousParentPid;
		}
	}
});
