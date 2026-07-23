import { getDefaultGodotExecutablePath } from "./general-settings-store.js";
import { inspectGodotExecutable, type GodotExecutableAvailability } from "./godot-executable.js";

export type EffectiveGodotExecutable = GodotExecutableAvailability & {
	source: "workspace" | "general_settings" | "environment" | "path";
};

export async function resolveEffectiveGodotExecutable(
	workspaceExecutablePath?: string | undefined
): Promise<EffectiveGodotExecutable> {
	const configuredDefault: string | undefined = await getDefaultGodotExecutablePath();
	const candidate: { path: string; source: EffectiveGodotExecutable["source"]; requireAbsoluteFile: boolean } =
		workspaceExecutablePath !== undefined
			? { path: workspaceExecutablePath, source: "workspace", requireAbsoluteFile: true }
			: configuredDefault !== undefined
				? { path: configuredDefault, source: "general_settings", requireAbsoluteFile: true }
				: process.env.GODOT_EXECUTABLE_PATH !== undefined
					? { path: process.env.GODOT_EXECUTABLE_PATH, source: "environment", requireAbsoluteFile: false }
					: { path: "godot", source: "path", requireAbsoluteFile: false };
	const availability: GodotExecutableAvailability = await inspectGodotExecutable(candidate.path, {
		requireAbsoluteFile: candidate.requireAbsoluteFile
	});
	return {
		...availability,
		source: candidate.source
	};
}

