export type ProviderErrorInfo = {
	code: "provider_error" | "provider_quota_exhausted";
	message: string;
};

const QUOTA_ERROR_PATTERN: RegExp = /\b(insufficient[_ -]?(quota|balance|credits?)|quota[_ -]?exceeded|billing|payment required|balance not enough|not enough balance)\b|余额不足|额度不足|欠费/i;

function getErrorStatus(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null) {
		return undefined;
	}

	const source: Record<string, unknown> = error as Record<string, unknown>;
	const status: unknown = source.status ?? source.statusCode ?? source.code;
	return typeof status === "number" ? status : undefined;
}

export function getProviderErrorMessage(error: unknown, fallback: string = "DeepSeek API call failed"): string {
	if (error instanceof Error && error.message.length > 0) {
		return error.message;
	}

	if (typeof error === "object" && error !== null) {
		const source: Record<string, unknown> = error as Record<string, unknown>;
		const message: unknown = source.message ?? source.error;
		if (typeof message === "string" && message.length > 0) {
			return message;
		}
	}

	return fallback;
}

export function classifyProviderError(error: unknown): ProviderErrorInfo {
	const message: string = getProviderErrorMessage(error);
	const status: number | undefined = getErrorStatus(error);
	if (status === 402 || QUOTA_ERROR_PATTERN.test(message)) {
		return {
			code: "provider_quota_exhausted",
			message
		};
	}

	return {
		code: "provider_error",
		message
	};
}

export function createProviderStatusEvent(error: unknown): Record<string, string> {
	const info: ProviderErrorInfo = classifyProviderError(error);
	if (info.code === "provider_quota_exhausted") {
		return {
			status: "error",
			title: "模型额度不足",
			details: "DeepSeek 返回额度或余额不足，当前回复已停止。请检查账户余额、套餐额度或切换可用的 API Key 后重试。",
			actionLabel: "Open settings",
			actionId: "provider-settings",
			code: info.code
		};
	}

	return {
		status: "error",
		title: "模型请求失败",
		details: info.message,
		code: info.code
	};
}
