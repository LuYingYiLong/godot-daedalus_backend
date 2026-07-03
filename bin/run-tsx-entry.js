import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function runTsxEntry(entryRelativePath) {
	const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const entryPath = resolve(packageRoot, entryRelativePath);
	const child = spawn(process.execPath, ["--import", "tsx", entryPath, ...process.argv.slice(2)], {
		cwd: packageRoot,
		env: process.env,
		stdio: "inherit"
	});

	child.on("error", (error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});

	child.on("exit", (code, signal) => {
		if (signal !== null) {
			console.error(`Process exited from signal ${signal}`);
			process.exit(1);
		}
		process.exit(code ?? 1);
	});
}
