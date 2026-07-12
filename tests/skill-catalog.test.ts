import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { parseSkillDocument } from "../src/skills/frontmatter.js";
import { listSkillSummaries, resolveCatalogSkill } from "../src/skills/catalog.js";
import { createSkill, removePersonalSkill, setWorkspaceSkillEnabled, updateSkillContent } from "../src/skills/management.js";

const userProfileRoot: string = await mkdtemp(join(tmpdir(), "daedalus-skills-userprofile-"));
process.env.USERPROFILE = userProfileRoot;

function skillDocument(name: string, description: string): string {
	return `---\nname: ${name}\ndescription: "${description}"\n---\n\n# ${name}\n\nFollow this workflow.`;
}

test("strict skill frontmatter requires name, description, and body", (): void => {
	assert.equal(parseSkillDocument(skillDocument("Review", "Review files.")).name, "Review");
	assert.throws((): unknown => parseSkillDocument("---\nname: Missing\n---\nBody"), /description/);
	assert.throws((): unknown => parseSkillDocument("---\nname: Duplicate\nname: Again\ndescription: Test\n---\nBody"), /Duplicate/);
	assert.throws((): unknown => parseSkillDocument("---\nname: Empty\ndescription: Test\n---\n"), /instruction body/);
	assert.throws((): unknown => parseSkillDocument("---\nname: Block\ndescription: |\n---\nBody"), /plain or quoted scalar/);
});

test("catalog discovers project, personal, and builtin skills without shadowing", async (): Promise<void> => {
	const projectRoot: string = await mkdtemp(join(tmpdir(), "daedalus-skills-project-"));
	const projectSkillDir: string = join(projectRoot, ".github", "skills", "shared-name");
	const personalSkillDir: string = join(userProfileRoot, ".daedalus", "skills", "shared-name");
	await mkdir(projectSkillDir, { recursive: true });
	await mkdir(personalSkillDir, { recursive: true });
	await writeFile(join(projectSkillDir, "SKILL.md"), skillDocument("Project Skill", "Project scoped."), "utf8");
	await writeFile(join(personalSkillDir, "SKILL.md"), skillDocument("Personal Skill", "Personal scoped."), "utf8");
	const workspace = { id: "catalog-workspace", rootPath: projectRoot };
	const catalog = await listSkillSummaries(workspace);
	assert.ok(catalog.skills.some((skill): boolean => skill.ref === "project:shared-name" && skill.enabled));
	assert.ok(catalog.skills.some((skill): boolean => skill.ref === "personal:shared-name" && !skill.enabled));
	assert.ok(catalog.skills.some((skill): boolean => skill.ref === "builtin:skill-creator" && skill.enabled));
	await setWorkspaceSkillEnabled(workspace, "personal:shared-name", true);
	assert.equal((await resolveCatalogSkill(workspace, "personal:shared-name", true)).name, "Personal Skill");
});

test("skill management creates atomically, validates updates, and only removes personal skills", async (): Promise<void> => {
	const projectRoot: string = await mkdtemp(join(tmpdir(), "daedalus-skills-manage-"));
	const workspace = { id: "manage-workspace", rootPath: projectRoot };
	const ref: string = await createSkill(workspace, "personal", "created-skill", skillDocument("Created", "Created by AI."));
	assert.equal(ref, "personal:created-skill");
	assert.equal((await resolveCatalogSkill(workspace, ref, true)).enabled, true);
	await updateSkillContent(workspace, ref, skillDocument("Updated", "Updated safely."));
	assert.match(await readFile((await resolveCatalogSkill(workspace, ref)).filePath, "utf8"), /name: Updated/);
	await assert.rejects(updateSkillContent(workspace, ref, "invalid"), /frontmatter/);
	await removePersonalSkill(workspace, ref);
	await assert.rejects(resolveCatalogSkill(workspace, ref), /Unknown skill/);
	const projectRef: string = await createSkill(workspace, "project", "project-skill", skillDocument("Project", "Version controlled."));
	await assert.rejects(removePersonalSkill(workspace, projectRef), /not removable/);
});
