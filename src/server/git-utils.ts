import { spawn } from "node:child_process";

export type GitResult = {
	stdout: string;
	stderr: string;
	exitCode: number | null;
};

export type RunGitOptions = {
	allowedExitCodes?: readonly number[] | undefined;
	timeoutMs?: number | undefined;
};

const DEFAULT_GIT_COMMAND_TIMEOUT_MS: number = 5000;

export function runGit(workspaceRoot: string, args: string[], options: RunGitOptions = {}): Promise<GitResult> {
	const allowedExitCodes: readonly number[] = options.allowedExitCodes ?? [0];
	const timeoutMs: number = options.timeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS;

	return new Promise((resolve: (result: GitResult) => void, reject: (error: Error) => void): void => {
		const child = spawn("git", args, {
			cwd: workspaceRoot,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"]
		});
		let stdout: string = "";
		let stderr: string = "";
		const timeout = setTimeout((): void => {
			child.kill();
			reject(new Error("Git command timed out."));
		}, timeoutMs);

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string): void => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string): void => {
			stderr += chunk;
		});
		child.on("error", (error: Error): void => {
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (code: number | null): void => {
			clearTimeout(timeout);
			if (code !== null && allowedExitCodes.includes(code)) {
				resolve({ stdout, stderr, exitCode: code });
				return;
			}
			reject(new Error(stderr.trim() || `Git exited with code ${code ?? "unknown"}.`));
		});
	});
}

export async function isInsideGitWorkTree(workspaceRoot: string): Promise<boolean> {
	try {
		const repoCheck: GitResult = await runGit(workspaceRoot, ["rev-parse", "--is-inside-work-tree"]);
		return repoCheck.stdout.trim() === "true";
	} catch {
		return false;
	}
}

export async function readGitBranch(workspaceRoot: string): Promise<string | null> {
	try {
		const branch: string = (await runGit(workspaceRoot, ["branch", "--show-current"])).stdout.trim();
		if (branch.length > 0) {
			return branch;
		}
		const revision: string = (await runGit(workspaceRoot, ["rev-parse", "--short", "HEAD"])).stdout.trim();
		return revision.length > 0 ? revision : null;
	} catch {
		return null;
	}
}
