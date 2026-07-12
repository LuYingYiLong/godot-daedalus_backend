import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { getPersonalSkillsDir } from "../app-paths.js";
import { createSkillRef, loadSkillCatalog, resolveCatalogEntry, resolveCatalogSkill, SKILL_SLUG_PATTERN } from "./catalog.js";
import { parseSkillDocument } from "./frontmatter.js";
import { setSkillEnabled } from "./settings-store.js";
import type { SkillRef, SkillSource, SkillWorkspace } from "./types.js";

function skillRoot(workspace: SkillWorkspace, source: "personal" | "project"): string {
	return source === "project" ? join(workspace.rootPath, ".github", "skills") : getPersonalSkillsDir();
}

function assertSafeSlug(slug: string): void {
	if (!SKILL_SLUG_PATTERN.test(slug)) {
		throw new Error("Skill slug must be lowercase kebab-case and 1-64 characters.");
	}
}

function isLexicallyInside(root: string, candidate: string): boolean {
	const child: string = relative(resolve(root), resolve(candidate));
	return child.length === 0 || (child !== ".." && !child.startsWith(`..${sep}`));
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const tempPath: string = `${filePath}.${process.pid}.tmp`;
	await writeFile(tempPath, content.replace(/\r\n?/g, "\n"), "utf8");
	await rename(tempPath, filePath);
}

export async function getSkillContent(workspace: SkillWorkspace, ref: SkillRef): Promise<string> {
	const skill = await resolveCatalogEntry(workspace, ref);
	if (!skill.editable || skill.source === "builtin") {
		throw new Error(`Skill ${ref} is read-only.`);
	}
	return readFile(skill.filePath, "utf8");
}

export async function updateSkillContent(workspace: SkillWorkspace, ref: SkillRef, content: string): Promise<void> {
	parseSkillDocument(content);
	const skill = await resolveCatalogEntry(workspace, ref);
	if (!skill.editable || skill.source === "builtin") {
		throw new Error(`Skill ${ref} is read-only.`);
	}
	await atomicWrite(skill.filePath, content);
}

export async function createSkill(workspace: SkillWorkspace, source: "personal" | "project", slug: string, content: string): Promise<SkillRef> {
	assertSafeSlug(slug);
	parseSkillDocument(content);
	const root: string = skillRoot(workspace, source);
	const targetDirectory: string = join(root, slug);
	if (!isLexicallyInside(root, targetDirectory)) {
		throw new Error("Skill target resolves outside its allowed root.");
	}
	const ref: SkillRef = createSkillRef(source, slug);
	if ((await loadSkillCatalog(workspace)).skills.some((skill): boolean => skill.ref === ref)) {
		throw new Error(`Skill ${ref} already exists.`);
	}
	await mkdir(root, { recursive: true });
	await mkdir(targetDirectory, { recursive: false });
	try {
		await atomicWrite(join(targetDirectory, "SKILL.md"), content);
	} catch (error: unknown) {
		await rm(targetDirectory, { recursive: true, force: true });
		throw error;
	}
	await setSkillEnabled(workspace.id, ref, true);
	return ref;
}

export async function removePersonalSkill(workspace: SkillWorkspace, ref: SkillRef): Promise<void> {
	const skill = await resolveCatalogEntry(workspace, ref);
	if (skill.source !== "personal" || !skill.removable) {
		throw new Error(`Skill ${ref} is not removable.`);
	}
	const rootReal: string = await realpath(getPersonalSkillsDir());
	const directoryReal: string = await realpath(dirname(skill.filePath));
	if (!isLexicallyInside(rootReal, directoryReal) || directoryReal === rootReal) {
		throw new Error("Refusing to remove a skill outside the personal skill root.");
	}
	await rm(directoryReal, { recursive: true, force: false });
}

export async function setWorkspaceSkillEnabled(workspace: SkillWorkspace, ref: SkillRef, enabled: boolean): Promise<void> {
	const skill = await resolveCatalogSkill(workspace, ref);
	await setSkillEnabled(workspace.id, skill.ref, enabled);
}
