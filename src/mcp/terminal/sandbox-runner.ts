import { accessSync, constants } from "node:fs";
import * as path from "node:path";

export type SandboxInvocation =
	| {
		available: true;
		command: string;
		args: string[];
		env: Record<string, string>;
		sandboxMode: "os-sandbox";
	}
	| {
		available: false;
		error: string;
		sandboxMode: "os-sandbox";
	};

function splitPathEnv(value: string | undefined): string[] {
	return (value ?? "").split(path.delimiter).filter((entry: string): boolean => entry.length > 0);
}

function findExecutable(name: string): string | null {
	for (const directory of splitPathEnv(process.env.PATH)) {
		const candidate: string = path.join(directory, name);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			continue;
		}
	}
	return null;
}

function createBaseEnv(extraEnv: Record<string, string> | undefined): Record<string, string> {
	const allowedKeys: string[] = process.platform === "win32"
		? ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE"]
		: ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SHELL"];
	const env: Record<string, string> = {};
	for (const key of allowedKeys) {
		const value: string | undefined = process.env[key];
		if (value !== undefined) {
			env[key] = value;
		}
	}
	for (const [key, value] of Object.entries(extraEnv ?? {})) {
		env[key] = value;
	}
	return env;
}

export function createSandboxInvocation(params: {
	commandLine: string;
	cwd: string;
	workspaceRoot: string;
	env?: Record<string, string> | undefined;
}): SandboxInvocation {
	const env: Record<string, string> = createBaseEnv(params.env);
	if (process.platform === "win32") {
		const helperPath: string | undefined = process.env.DAEDALUS_WINDOWS_SANDBOX_HELPER;
		if (helperPath === undefined || helperPath.trim().length === 0) {
			return {
				available: false,
				error: "sandbox_unavailable: DAEDALUS_WINDOWS_SANDBOX_HELPER is not configured.",
				sandboxMode: "os-sandbox"
			};
		}
		return {
			available: true,
			command: helperPath,
			args: ["--workspace", params.workspaceRoot, "--cwd", params.cwd, "--", params.commandLine],
			env,
			sandboxMode: "os-sandbox"
		};
	}

	if (process.platform === "linux") {
		const bwrapPath: string | null = findExecutable("bwrap");
		if (bwrapPath === null) {
			return {
				available: false,
				error: "sandbox_unavailable: bwrap is not installed or not in PATH.",
				sandboxMode: "os-sandbox"
			};
		}
		return {
			available: true,
			command: bwrapPath,
			args: [
				"--unshare-all",
				"--share-net",
				"--die-with-parent",
				"--proc", "/proc",
				"--dev", "/dev",
				"--tmpfs", "/tmp",
				"--ro-bind", "/bin", "/bin",
				"--ro-bind", "/usr", "/usr",
				"--ro-bind-try", "/lib", "/lib",
				"--ro-bind-try", "/lib64", "/lib64",
				"--bind", params.workspaceRoot, params.workspaceRoot,
				"--chdir", params.cwd,
				"/bin/sh",
				"-lc",
				params.commandLine
			],
			env,
			sandboxMode: "os-sandbox"
		};
	}

	if (process.platform === "darwin") {
		const sandboxExecPath: string | null = findExecutable("sandbox-exec");
		if (sandboxExecPath === null) {
			return {
				available: false,
				error: "sandbox_unavailable: sandbox-exec is not available.",
				sandboxMode: "os-sandbox"
			};
		}
		const profile: string = [
			"(version 1)",
			"(allow default)",
			"(allow file-read*)",
			`(allow file-write* (subpath "${params.workspaceRoot.replaceAll("\"", "\\\"")}"))`
		].join("\n");
		return {
			available: true,
			command: sandboxExecPath,
			args: ["-p", profile, "/bin/sh", "-lc", `cd "${params.cwd.replaceAll("\"", "\\\"")}" && ${params.commandLine}`],
			env,
			sandboxMode: "os-sandbox"
		};
	}

	return {
		available: false,
		error: `sandbox_unavailable: unsupported platform ${process.platform}.`,
		sandboxMode: "os-sandbox"
	};
}
