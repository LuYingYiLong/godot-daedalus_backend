export { readJsonFile, removeIfExists } from "../json-file-store.js";
import { writeJsonFileAtomic } from "../json-file-store.js";

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
	await writeJsonFileAtomic(filePath, value);
}
