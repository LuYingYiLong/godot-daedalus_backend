import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getBackendConnectionPath } from "../../../src/app-paths.js";
import {
	clearRuntimeConnection,
	publishRuntimeConnection,
	readRuntimeConnectionAuthProtocol
} from "../../../src/runtime/connection-registry.js";
import {
	installMemorySecretStore,
	resetSecretStoreDriver
} from "../../helpers/secret-store.js";

const FIRST_CONNECTION_ID: string = "connection_AAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SECOND_CONNECTION_ID: string = "connection_BBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const FIRST_TOKEN: string = "first-runtime-token-0123456789-ABCDEFG";
const SECOND_TOKEN: string = "second-runtime-token-0123456789-ABCDE";

test("runtime connection metadata never persists the auth token", async (): Promise<void> => {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const profile: string = await mkdtemp(join(tmpdir(), "daedalus-connection-"));
	process.env.USERPROFILE = profile;
	const secrets: Map<string, string> = installMemorySecretStore();
	try {
		const metadata = await publishRuntimeConnection({
			connectionId: FIRST_CONNECTION_ID,
			authToken: FIRST_TOKEN,
			port: 38180
		});
		const fileText: string = await readFile(getBackendConnectionPath(), "utf8");

		assert.equal(metadata.connectionId, FIRST_CONNECTION_ID);
		assert.equal(metadata.tokenStorage, "credential-manager");
		assert.equal(fileText.includes(FIRST_TOKEN), false);
		assert.equal(
			await readRuntimeConnectionAuthProtocol(FIRST_CONNECTION_ID),
			`daedalus-auth.${FIRST_TOKEN}`
		);
		assert.equal(secrets.get(`connection:${FIRST_CONNECTION_ID}`), FIRST_TOKEN);

		await clearRuntimeConnection(FIRST_CONNECTION_ID);
		assert.equal(secrets.has(`connection:${FIRST_CONNECTION_ID}`), false);
		await assert.rejects(readFile(getBackendConnectionPath(), "utf8"));
	} finally {
		resetSecretStoreDriver();
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await rm(profile, { recursive: true, force: true });
	}
});

test("publishing a new runtime connection removes the stale credential", async (): Promise<void> => {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const profile: string = await mkdtemp(join(tmpdir(), "daedalus-connection-"));
	process.env.USERPROFILE = profile;
	const secrets: Map<string, string> = installMemorySecretStore();
	try {
		await publishRuntimeConnection({
			connectionId: FIRST_CONNECTION_ID,
			authToken: FIRST_TOKEN,
			port: 38180
		});
		await publishRuntimeConnection({
			connectionId: SECOND_CONNECTION_ID,
			authToken: SECOND_TOKEN,
			port: 38180
		});

		assert.equal(secrets.has(`connection:${FIRST_CONNECTION_ID}`), false);
		assert.equal(secrets.get(`connection:${SECOND_CONNECTION_ID}`), SECOND_TOKEN);
		await assert.rejects(
			readRuntimeConnectionAuthProtocol(FIRST_CONNECTION_ID),
			/requested runtime connection is not active/u
		);
	} finally {
		await clearRuntimeConnection(SECOND_CONNECTION_ID).catch((): void => {});
		resetSecretStoreDriver();
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await rm(profile, { recursive: true, force: true });
	}
});
