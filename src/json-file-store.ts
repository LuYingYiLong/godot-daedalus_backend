import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
	try {
		return JSON.parse(await readFile(filePath, "utf8")) as T;
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

export async function writeJsonFileAtomic<T>(filePath: string, value: T): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const tempPath: string = `${filePath}.${process.pid}.${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`;
	try {
		await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		await replaceWithTempFile(tempPath, filePath);
	} catch (error: unknown) {
		await rm(tempPath, { force: true }).catch((): void => undefined);
		throw error;
	}
}

export function writeJsonFileAtomicSync<T>(filePath: string, value: T): void {
	mkdirSync(dirname(filePath), { recursive: true });
	const tempPath: string = `${filePath}.${process.pid}.${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`;
	try {
		writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		replaceWithTempFileSync(tempPath, filePath);
	} catch (error: unknown) {
		try {
			rmSync(tempPath, { force: true });
		} catch {
			// 忽略临时文件清理失败，保留原始写入错误。
		}
		throw error;
	}
}

async function replaceWithTempFile(tempPath: string, filePath: string): Promise<void> {
	try {
		await rename(tempPath, filePath);
	} catch (error: unknown) {
		if (process.platform !== "win32" || !isRecoverableWindowsRenameError(error)) {
			throw error;
		}
		await rm(filePath, { force: true });
		await rename(tempPath, filePath);
	}
}

function replaceWithTempFileSync(tempPath: string, filePath: string): void {
	try {
		renameSync(tempPath, filePath);
	} catch (error: unknown) {
		if (process.platform !== "win32" || !isRecoverableWindowsRenameError(error)) {
			throw error;
		}
		rmSync(filePath, { force: true });
		renameSync(tempPath, filePath);
	}
}

function isRecoverableWindowsRenameError(error: unknown): boolean {
	const code: string | undefined = (error as NodeJS.ErrnoException).code;
	return code === "EPERM" || code === "EEXIST";
}

export async function removeIfExists(path: string): Promise<void> {
	await rm(path, { recursive: true, force: true });
}
