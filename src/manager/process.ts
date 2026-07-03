import { spawn } from "node:child_process";

export type CommandResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
};

export function runCommand(command: string, args: readonly string[], options: {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
} = {}): Promise<CommandResult> {
	return new Promise<CommandResult>((resolve): void => {
		const invocation = buildInvocation(command, args);
		const child = spawn(invocation.command, invocation.args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"]
		});
		let stdout: string = "";
		let stderr: string = "";
		let settled: boolean = false;
		const timeout = options.timeoutMs === undefined
			? null
			: setTimeout((): void => {
				if (settled) {
					return;
				}
				child.kill("SIGTERM");
			}, options.timeoutMs);

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string): void => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string): void => {
			stderr += chunk;
		});
		child.on("error", (error: Error): void => {
			if (settled) {
				return;
			}
			settled = true;
			if (timeout !== null) {
				clearTimeout(timeout);
			}
			resolve({ exitCode: 1, stdout, stderr: stderr + error.message });
		});
		child.on("exit", (code: number | null): void => {
			if (settled) {
				return;
			}
			settled = true;
			if (timeout !== null) {
				clearTimeout(timeout);
			}
			resolve({ exitCode: code ?? 1, stdout, stderr });
		});
	});
}

function buildInvocation(command: string, args: readonly string[]): { command: string; args: string[] } {
	if (process.platform !== "win32" || (!command.endsWith(".cmd") && !command.endsWith(".bat"))) {
		return { command, args: [...args] };
	}

	const comspec: string = process.env.COMSPEC ?? "cmd.exe";
	const commandLine: string = [command, ...args].map(quoteWindowsCommandPart).join(" ");
	return { command: comspec, args: ["/d", "/s", "/c", commandLine] };
}

function quoteWindowsCommandPart(value: string): string {
	if (!/[ \t&()^"]/u.test(value)) {
		return value;
	}

	return `"${value.replaceAll("\"", "\\\"")}"`;
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export async function stopProcess(pid: number): Promise<CommandResult> {
	if (process.platform === "win32") {
		return runCommand("taskkill", ["/PID", String(pid), "/T", "/F"], { timeoutMs: 10000 });
	}

	return runCommand("kill", ["-TERM", String(pid)], { timeoutMs: 10000 });
}
