import type { ManagerErrorCode, ManagerFailure } from "./types.js";

export class ManagerError extends Error {
	public readonly code: ManagerErrorCode;
	public readonly details: string | undefined;
	public readonly logPath: string | undefined;
	public readonly suggestedAction: string | undefined;

	public constructor(params: {
		code: ManagerErrorCode;
		message: string;
		details?: string;
		logPath?: string;
		suggestedAction?: string;
	}) {
		super(params.message);
		this.name = "ManagerError";
		this.code = params.code;
		this.details = params.details;
		this.logPath = params.logPath;
		this.suggestedAction = params.suggestedAction;
	}

	public toFailure(): ManagerFailure {
		return {
			ok: false,
			code: this.code,
			message: this.message,
			...(this.details === undefined ? {} : { details: this.details }),
			...(this.logPath === undefined ? {} : { logPath: this.logPath }),
			...(this.suggestedAction === undefined ? {} : { suggestedAction: this.suggestedAction })
		};
	}
}

export function toManagerFailure(error: unknown): ManagerFailure {
	if (error instanceof ManagerError) {
		return error.toFailure();
	}

	return {
		ok: false,
		code: "unknown_error",
		message: error instanceof Error ? error.message : String(error)
	};
}
