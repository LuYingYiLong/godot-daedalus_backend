export type ClientRequest = {
	type: "request";
	id: string;
} & (
	| { method: "ping"; params?: Record<string, never> | undefined }
	| { method: "ai.chat"; params: { message: string } }
);

export type ServerResponse =
	| {
		type: "response";
		id: string;
		ok: true;
		result: unknown;
	}
	| {
		type: "response";
		id: string;
		ok: false;
		error: {
			code: string;
			message: string;
		};
	};

export type ServerEvent = {
	type: "event";
	id: string;
	event: "ai.delta" | "ai.done";
	data?: unknown;
};
