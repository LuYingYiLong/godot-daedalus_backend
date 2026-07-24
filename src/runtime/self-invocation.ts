import { resolve } from "node:path";
import { isSea } from "node:sea";

declare const __DAEDALUS_SEA_BUILD__: boolean | undefined;

export type ProcessInvocation = {
	command: string;
	args: string[];
};

export function createSelfInvocation(args: readonly string[]): ProcessInvocation {
	const seaBuild: boolean = typeof __DAEDALUS_SEA_BUILD__ !== "undefined" && __DAEDALUS_SEA_BUILD__;
	if (seaBuild || isSea()) {
		return {
			command: process.execPath,
			args: [...args]
		};
	}

	const sourceRoot: string = process.env.DAEDALUS_SOURCE_ROOT?.trim() || process.cwd();
	return {
		command: process.execPath,
		args: [
			"--import",
			"tsx",
			resolve(sourceRoot, "src", "cli.ts"),
			...args
		]
	};
}
