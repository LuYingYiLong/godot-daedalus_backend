export type McpServerConfig = {
	id: string;
	name: string;
	description?: string | undefined;
	transport: "stdio" | "http";
	command?: string | undefined;
	args?: string[] | undefined;
	env?: Record<string, string> | undefined;
	url?: string | undefined;
	headers?: Record<string, string> | undefined;
	custom?: boolean | undefined;
};
