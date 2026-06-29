export type WorkspaceConfig = {
	id: string;
	name: string;
	kind: "godot";
	rootPath: string;
	godotExecutablePath?: string | undefined;
};
