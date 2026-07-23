import { isInsideGitWorkTree, readGitBranch, runGit, type GitResult } from "./git-utils.js";

const GIT_BRANCH_OPERATION_TIMEOUT_MS: number = 10000;

export type WorkspaceGitBranchItem = {
	name: string;
	fullName: string;
	current: boolean;
	remote: boolean;
	upstream: string | null;
	lastCommit: string | null;
	lastCommitDate: string | null;
};

export type WorkspaceGitBranchesResult = {
	workspaceId: string;
	hasGitRepository: boolean;
	currentBranch: string | null;
	branches: WorkspaceGitBranchItem[];
	generatedAt: string;
};

export type WorkspaceGitBranchOperationResult = {
	workspaceId: string;
	branch: string;
	previousBranch: string | null;
	stdout: string;
	stderr: string;
};

function assertSafeBranchInput(value: string, label: string): string {
	const branchName: string = value.trim();
	if (branchName.length === 0) {
		throw new Error(`${label} is required.`);
	}
	if (branchName.length > 240) {
		throw new Error(`${label} is too long.`);
	}
	if (branchName.startsWith("-") || /[\u0000-\u001f\u007f]/u.test(branchName)) {
		throw new Error(`${label} is not a valid Git branch reference.`);
	}
	return branchName;
}

async function assertGitBranchName(workspaceRoot: string, branchName: string): Promise<void> {
	await runGit(workspaceRoot, ["check-ref-format", "--branch", branchName], {
		timeoutMs: GIT_BRANCH_OPERATION_TIMEOUT_MS
	});
}

async function hasGitReference(workspaceRoot: string, refName: string): Promise<boolean> {
	const result: GitResult = await runGit(workspaceRoot, ["rev-parse", "--verify", "--quiet", refName], {
		allowedExitCodes: [0, 1],
		timeoutMs: GIT_BRANCH_OPERATION_TIMEOUT_MS
	});
	return result.exitCode === 0;
}

function parseBranchLine(line: string): WorkspaceGitBranchItem | null {
	const [refName = "", shortName = "", head = "", upstream = "", objectName = "", commitDate = ""] = line.split("\0");
	const name: string = shortName.trim();
	const fullName: string = refName.trim();
	if (name.length === 0 || fullName.length === 0 || fullName === "refs/remotes/origin/HEAD") {
		return null;
	}

	return {
		name,
		fullName,
		current: head.trim() === "*",
		remote: fullName.startsWith("refs/remotes/"),
		upstream: upstream.trim().length > 0 ? upstream.trim() : null,
		lastCommit: objectName.trim().length > 0 ? objectName.trim() : null,
		lastCommitDate: commitDate.trim().length > 0 ? commitDate.trim() : null
	};
}

function sortBranches(left: WorkspaceGitBranchItem, right: WorkspaceGitBranchItem): number {
	if (left.current !== right.current) {
		return left.current ? -1 : 1;
	}
	if (left.remote !== right.remote) {
		return left.remote ? 1 : -1;
	}
	return left.name.localeCompare(right.name);
}

export async function listWorkspaceGitBranches(workspaceId: string, workspaceRoot: string): Promise<WorkspaceGitBranchesResult> {
	if (!await isInsideGitWorkTree(workspaceRoot)) {
		return {
			workspaceId,
			hasGitRepository: false,
			currentBranch: null,
			branches: [],
			generatedAt: new Date().toISOString()
		};
	}

	const output: string = (await runGit(workspaceRoot, [
		"branch",
		"--all",
		"--format=%(refname)%00%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(objectname:short)%00%(committerdate:iso-strict)"
	])).stdout;
	const branches: WorkspaceGitBranchItem[] = output
		.split(/\r?\n/u)
		.map(parseBranchLine)
		.filter((branch: WorkspaceGitBranchItem | null): branch is WorkspaceGitBranchItem => branch !== null)
		.sort(sortBranches);

	return {
		workspaceId,
		hasGitRepository: true,
		currentBranch: await readGitBranch(workspaceRoot),
		branches,
		generatedAt: new Date().toISOString()
	};
}

export async function checkoutWorkspaceGitBranch(params: {
	workspaceId: string;
	workspaceRoot: string;
	branchName: string;
}): Promise<WorkspaceGitBranchOperationResult> {
	if (!await isInsideGitWorkTree(params.workspaceRoot)) {
		throw new Error("Workspace is not a Git repository.");
	}

	const branchName: string = assertSafeBranchInput(params.branchName, "Branch");
	await assertGitBranchName(params.workspaceRoot, branchName);
	const previousBranch: string | null = await readGitBranch(params.workspaceRoot);
	const hasLocalBranch: boolean = await hasGitReference(params.workspaceRoot, `refs/heads/${branchName}`);
	const hasRemoteBranch: boolean = await hasGitReference(params.workspaceRoot, `refs/remotes/${branchName}`);
	const args: string[] = !hasLocalBranch && hasRemoteBranch
		? ["checkout", "--track", branchName]
		: ["checkout", branchName];
	const result: GitResult = await runGit(params.workspaceRoot, args, {
		timeoutMs: GIT_BRANCH_OPERATION_TIMEOUT_MS
	});

	return {
		workspaceId: params.workspaceId,
		branch: branchName,
		previousBranch,
		stdout: result.stdout,
		stderr: result.stderr
	};
}

export async function createWorkspaceGitBranch(params: {
	workspaceId: string;
	workspaceRoot: string;
	branchName: string;
	startPoint?: string | undefined;
}): Promise<WorkspaceGitBranchOperationResult> {
	if (!await isInsideGitWorkTree(params.workspaceRoot)) {
		throw new Error("Workspace is not a Git repository.");
	}

	const branchName: string = assertSafeBranchInput(params.branchName, "Branch name");
	await assertGitBranchName(params.workspaceRoot, branchName);
	const previousBranch: string | null = await readGitBranch(params.workspaceRoot);
	const startPoint: string | undefined = params.startPoint === undefined
		? undefined
		: assertSafeBranchInput(params.startPoint, "Start point");
	const args: string[] = startPoint === undefined
		? ["checkout", "-b", branchName]
		: ["checkout", "-b", branchName, startPoint];
	const result: GitResult = await runGit(params.workspaceRoot, args, {
		timeoutMs: GIT_BRANCH_OPERATION_TIMEOUT_MS
	});

	return {
		workspaceId: params.workspaceId,
		branch: branchName,
		previousBranch,
		stdout: result.stdout,
		stderr: result.stderr
	};
}
