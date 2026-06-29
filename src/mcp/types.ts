export type McpServerConfig = {
	id: string;
	name: string;
	command: string;
	args: string[];
	env?: Record<string, string> | undefined;
};
