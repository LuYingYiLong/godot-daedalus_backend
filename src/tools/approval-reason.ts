export const APPROVAL_REASON_ARG: string = "approvalReason";

const MAX_APPROVAL_REASON_CHARS: number = 500;

export const APPROVAL_REASON_SCHEMA_PROPERTY: Record<string, unknown> = {
	type: "string",
	description: "面向用户说明为什么需要执行这次写入或高风险工具调用，描述目的和影响。不要让用户阅读参数来判断。"
};

export function getApprovalReasonFromArgs(args: Record<string, unknown>, fallback: string): string {
	const value: unknown = args[APPROVAL_REASON_ARG];
	if (typeof value !== "string") {
		return fallback;
	}

	const trimmed: string = value.trim();
	return trimmed.length > 0 ? trimmed.slice(0, MAX_APPROVAL_REASON_CHARS) : fallback;
}

export function stripApprovalReasonArg(args: Record<string, unknown>): Record<string, unknown> {
	if (!(APPROVAL_REASON_ARG in args)) {
		return args;
	}

	const { [APPROVAL_REASON_ARG]: _approvalReason, ...strippedArgs } = args;
	return strippedArgs;
}
