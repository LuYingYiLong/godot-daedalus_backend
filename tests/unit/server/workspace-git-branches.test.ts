import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
	checkoutWorkspaceGitBranch,
	createWorkspaceGitBranch,
	listWorkspaceGitBranches,
	type WorkspaceGitBranchesResult
} from "../../../src/server/workspace-git-branches.js";

const execFileAsync = promisify(execFile);

async function createTempDir(): Promise<string> {
	return await mkdtemp(path.join(tmpdir(), "daedalus-git-branches-"));
}

async function git(cwd: string, args: string[]): Promise<string> {
	const result = await execFileAsync("git", args, {
		cwd,
		windowsHide: true
	});
	return result.stdout;
}

async function initRepo(repoPath: string): Promise<void> {
	await git(repoPath, ["init"]);
	await git(repoPath, ["config", "user.email", "daedalus@example.test"]);
	await git(repoPath, ["config", "user.name", "Daedalus Test"]);
}

async function commitFile(repoPath: string, relativePath: string, content: string): Promise<void> {
	await writeFile(path.join(repoPath, relativePath), content, "utf8");
	await git(repoPath, ["add", relativePath]);
	await git(repoPath, ["commit", "-m", `Add ${relativePath}`]);
}

test("workspace git branches returns non repository state", async (): Promise<void> => {
	const repoPath: string = await createTempDir();
	try {
		const result: WorkspaceGitBranchesResult = await listWorkspaceGitBranches("workspace-a", repoPath);

		assert.equal(result.workspaceId, "workspace-a");
		assert.equal(result.hasGitRepository, false);
		assert.equal(result.currentBranch, null);
		assert.deepEqual(result.branches, []);
	} finally {
		await rm(repoPath, { recursive: true, force: true });
	}
});

test("workspace git branches lists local branches with the current branch first", async (): Promise<void> => {
	const repoPath: string = await createTempDir();
	try {
		await initRepo(repoPath);
		await commitFile(repoPath, "project.godot", "[application]\n");
		await git(repoPath, ["branch", "feature/dialog"]);

		const result: WorkspaceGitBranchesResult = await listWorkspaceGitBranches("workspace-a", repoPath);

		assert.equal(result.hasGitRepository, true);
		assert.equal(result.currentBranch, result.branches[0]?.name);
		assert.equal(result.branches[0]?.current, true);
		assert.ok(result.branches.some((branch): boolean => branch.name === "feature/dialog" && !branch.remote));
		assert.ok(result.branches.every((branch): boolean => branch.fullName.startsWith("refs/")));
	} finally {
		await rm(repoPath, { recursive: true, force: true });
	}
});

test("workspace git branch create checks out the new branch", async (): Promise<void> => {
	const repoPath: string = await createTempDir();
	try {
		await initRepo(repoPath);
		await commitFile(repoPath, "project.godot", "[application]\n");

		const result = await createWorkspaceGitBranch({
			workspaceId: "workspace-a",
			workspaceRoot: repoPath,
			branchName: "feature/dialog"
		});

		assert.equal(result.branch, "feature/dialog");
		assert.equal((await git(repoPath, ["branch", "--show-current"])).trim(), "feature/dialog");
	} finally {
		await rm(repoPath, { recursive: true, force: true });
	}
});

test("workspace git branch checkout switches existing local branches", async (): Promise<void> => {
	const repoPath: string = await createTempDir();
	try {
		await initRepo(repoPath);
		await commitFile(repoPath, "project.godot", "[application]\n");
		await git(repoPath, ["branch", "feature/dialog"]);

		const result = await checkoutWorkspaceGitBranch({
			workspaceId: "workspace-a",
			workspaceRoot: repoPath,
			branchName: "feature/dialog"
		});

		assert.equal(result.branch, "feature/dialog");
		assert.equal((await git(repoPath, ["branch", "--show-current"])).trim(), "feature/dialog");
	} finally {
		await rm(repoPath, { recursive: true, force: true });
	}
});
