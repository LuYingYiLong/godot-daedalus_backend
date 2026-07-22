import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { commitOrPushWorkspaceGit } from "../../../src/server/workspace-git-commit.js";

const execFileAsync = promisify(execFile);

async function createTempDir(prefix: string): Promise<string> {
	return await mkdtemp(path.join(tmpdir(), prefix));
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

test("workspace git commit rejects non repositories", async (): Promise<void> => {
	const repoPath: string = await createTempDir("daedalus-git-commit-nonrepo-");
	try {
		await assert.rejects(
			commitOrPushWorkspaceGit({
				workspaceId: "workspace-a",
				workspaceRoot: repoPath,
				action: "commit",
				message: "Add file",
				includeUnstagedChanges: true
			}),
			/Workspace is not a Git repository/u
		);
	} finally {
		await rm(repoPath, { recursive: true, force: true });
	}
});

test("workspace git commit uses staged changes only when requested", async (): Promise<void> => {
	const repoPath: string = await createTempDir("daedalus-git-commit-staged-");
	try {
		await initRepo(repoPath);
		await commitFile(repoPath, "script.gd", "extends Node\n");
		await writeFile(path.join(repoPath, "script.gd"), "extends Node2D\n", "utf8");
		await git(repoPath, ["add", "script.gd"]);
		await writeFile(path.join(repoPath, "script.gd"), "extends Control\n", "utf8");

		const result = await commitOrPushWorkspaceGit({
			workspaceId: "workspace-a",
			workspaceRoot: repoPath,
			action: "commit",
			message: "Update script base type\n\nUse staged content only.",
			includeUnstagedChanges: false
		});

		assert.equal(result.committed, true);
		assert.equal(result.pushed, false);
		assert.equal(typeof result.commitHash, "string");
		assert.equal((await git(repoPath, ["show", "HEAD:script.gd"])).trim(), "extends Node2D");
		assert.match((await git(repoPath, ["status", "--short"])), / M script\.gd/u);
		assert.equal(result.stdout.includes(repoPath), false);
		assert.equal(result.stderr.includes(repoPath), false);
	} finally {
		await rm(repoPath, { recursive: true, force: true });
	}
});

test("workspace git commit wraps body lines for commitlint-compatible messages", async (): Promise<void> => {
	const repoPath: string = await createTempDir("daedalus-git-commit-body-wrap-");
	try {
		await initRepo(repoPath);
		await commitFile(repoPath, "project.godot", "[application]\n");
		await writeFile(path.join(repoPath, "project.godot"), "[application]\nconfig/name=\"Demo\"\n", "utf8");

		const longBody: string = [
			"Introduce workspace.git.commit.message.generate and workspace.git.commitOrPush methods for the",
			"Commit or Push dialog while keeping the generated message flow deterministic."
		].join(" ");
		const result = await commitOrPushWorkspaceGit({
			workspaceId: "workspace-a",
			workspaceRoot: repoPath,
			action: "commit",
			message: `feat(git): add commit message generation\n\n${longBody}`,
			includeUnstagedChanges: true
		});

		const commitMessage: string = await git(repoPath, ["log", "-1", "--format=%B"]);
		const messageLines: string[] = commitMessage.trimEnd().split(/\r?\n/u);
		assert.equal(result.committed, true);
		assert.equal(messageLines[0], "feat(git): add commit message generation");
		assert.ok(messageLines.some((line: string): boolean => line.includes("workspace.git.commit.message.generate")));
		assert.ok(messageLines.every((line: string): boolean => Array.from(line).length <= 100));
	} finally {
		await rm(repoPath, { recursive: true, force: true });
	}
});

test("workspace git commit can include unstaged and untracked changes", async (): Promise<void> => {
	const repoPath: string = await createTempDir("daedalus-git-commit-all-");
	try {
		await initRepo(repoPath);
		await commitFile(repoPath, "project.godot", "[application]\n");
		await writeFile(path.join(repoPath, "project.godot"), "[application]\nconfig/name=\"Demo\"\n", "utf8");
		await writeFile(path.join(repoPath, "new_script.gd"), "extends Node\n", "utf8");

		const result = await commitOrPushWorkspaceGit({
			workspaceId: "workspace-a",
			workspaceRoot: repoPath,
			action: "commit",
			message: "Add demo project metadata",
			includeUnstagedChanges: true
		});

		assert.equal(result.committed, true);
		assert.equal((await git(repoPath, ["status", "--short"])).trim(), "");
		assert.match(await git(repoPath, ["show", "--name-only", "--format=%s", "HEAD"]), /new_script\.gd/u);
	} finally {
		await rm(repoPath, { recursive: true, force: true });
	}
});

test("workspace git push sets origin upstream when missing", async (): Promise<void> => {
	const repoPath: string = await createTempDir("daedalus-git-push-work-");
	const remotePath: string = await createTempDir("daedalus-git-push-remote-");
	try {
		await git(remotePath, ["init", "--bare"]);
		await initRepo(repoPath);
		await commitFile(repoPath, "project.godot", "[application]\n");
		await git(repoPath, ["remote", "add", "origin", remotePath]);

		const result = await commitOrPushWorkspaceGit({
			workspaceId: "workspace-a",
			workspaceRoot: repoPath,
			action: "push",
			includeUnstagedChanges: false
		});

		assert.equal(result.committed, false);
		assert.equal(result.pushed, true);
		assert.match((await git(repoPath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).trim(), /^origin\//u);
	} finally {
		await rm(repoPath, { recursive: true, force: true });
		await rm(remotePath, { recursive: true, force: true });
	}
});
