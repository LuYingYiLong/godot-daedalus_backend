import WebSocket from "ws";

export const GODOT_EDITOR_SERVER_ID: string = "godot_editor";

const EDITOR_TOOL_TIMEOUT_MS: number = 30_000;
const EDITOR_CONTEXT_STALE_MS: number = 15_000;

type JsonObject = Record<string, unknown>;

type ToolTextResult = {
	content: Array<{
		type: "text";
		text: string;
	}>;
};

type PendingEditorToolCall = {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
};

function jsonTextResult(value: unknown): ToolTextResult {
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}
		]
	};
}

function createEditorUnavailableResult(): ToolTextResult {
	return jsonTextResult({
		ok: false,
		error: {
			code: "editor_unavailable",
			message: "Godot editor client is not connected or has not reported live context yet."
		}
	});
}

function isSocketOpen(socket: WebSocket | undefined): socket is WebSocket {
	return socket !== undefined && socket.readyState === WebSocket.OPEN;
}

export class GodotEditorBridge {
	private socket?: WebSocket | undefined;
	private context: JsonObject = {};
	private updatedAtMs: number = 0;
	private pendingToolCalls: Map<string, PendingEditorToolCall> = new Map();

	attachSocket(socket: WebSocket): void {
		this.socket = socket;
	}

	detachSocket(socket: WebSocket): void {
		if (this.socket !== socket) {
			return;
		}

		this.socket = undefined;
		this.context = {};
		this.updatedAtMs = 0;

		for (const [callId, pending] of this.pendingToolCalls.entries()) {
			clearTimeout(pending.timeout);
			pending.reject(new Error(`editor_unavailable: editor disconnected before tool result (${callId})`));
		}
		this.pendingToolCalls.clear();
	}

	updateContext(context: JsonObject): void {
		this.context = {
			...context,
			online: true
		};
		this.updatedAtMs = Date.now();
	}

	handleToolResult(callId: string, ok: boolean, result: unknown, error: unknown): boolean {
		const pending: PendingEditorToolCall | undefined = this.pendingToolCalls.get(callId);
		if (pending === undefined) {
			return false;
		}

		this.pendingToolCalls.delete(callId);
		clearTimeout(pending.timeout);

		if (ok) {
			pending.resolve(result ?? { ok: true });
			return true;
		}

		const message: string = typeof error === "string" && error.length > 0
			? error
			: "Godot editor tool failed";
		pending.reject(new Error(message));
		return true;
	}

	isOnline(): boolean {
		return isSocketOpen(this.socket) && this.updatedAtMs > 0;
	}

	listTools() {
		return {
			tools: [
				{
					name: "get_context",
					description: "返回 Godot 编辑器在线状态、当前场景、选择节点和上下文新鲜度。",
					inputSchema: {
						type: "object",
						properties: {},
						required: []
					}
				},
				{
					name: "get_selected_nodes",
					description: "读取当前在线 Godot 编辑器中的多个选中节点摘要。",
					inputSchema: {
						type: "object",
						properties: {},
						required: []
					}
				},
				{
					name: "inspect_node",
					description: "检查在线 Godot 编辑器当前未保存状态里的指定节点结构。",
					inputSchema: {
						type: "object",
						properties: {
							scenePath: {
								type: "string",
								description: "可选场景路径；为空时使用当前打开场景。"
							},
							nodePath: {
								type: "string",
								description: "相对当前场景根节点的 NodePath，例如 '.'、'CanvasLayer/Button'。"
							}
						},
						required: ["nodePath"]
					}
				},
				{
					name: "apply_scene_patch",
					description: "在在线 Godot 编辑器中应用场景 patch，使用 EditorUndoRedoManager 形成一个可撤销动作。",
					inputSchema: {
						type: "object",
						properties: {
							title: {
								type: "string",
								description: "UndoRedo 动作标题。"
							},
							scenePath: {
								type: "string",
								description: "可选场景路径；为空时使用当前打开场景。"
							},
							saveAfter: {
								type: "boolean",
								description: "提交动作后是否保存当前场景，默认 true。"
							},
							operations: {
								type: "array",
								minItems: 1,
								maxItems: 50,
								items: {
									type: "object",
									properties: {
										type: {
											type: "string",
											enum: ["set_property", "add_node", "rename_node", "attach_script", "connect_signal"]
										}
									},
									additionalProperties: true
								}
							}
						},
						required: ["operations"]
					}
				}
			]
		};
	}

	listResources() {
		return {
			resources: [
				{
					uri: "godot-editor://context",
					name: "Godot Editor Live Context",
					mimeType: "application/json"
				}
			]
		};
	}

	readResource(uri: string) {
		if (uri !== "godot-editor://context") {
			throw new Error(`Unknown godot_editor resource: ${uri}`);
		}

		return {
			contents: [
				{
					uri,
					mimeType: "application/json",
					text: JSON.stringify(this.createContextSnapshot(), null, 2)
				}
			]
		};
	}

	async callTool(name: string, args: JsonObject): Promise<ToolTextResult> {
		if (name === "get_context") {
			return jsonTextResult(this.createContextSnapshot());
		}

		if (name === "get_selected_nodes") {
			if (!this.isOnline()) {
				return createEditorUnavailableResult();
			}

			return jsonTextResult({
				ok: true,
				selectedNodes: this.context.selectedNodes ?? [],
				context: this.createContextSnapshot()
			});
		}

		if (name !== "inspect_node" && name !== "apply_scene_patch") {
			throw new Error(`Unknown godot_editor tool: ${name}`);
		}

		if (!this.isOnline()) {
			return createEditorUnavailableResult();
		}

		const result: unknown = await this.requestEditorTool(name, args);
		return jsonTextResult({
			ok: true,
			result
		});
	}

	private createContextSnapshot(): JsonObject {
		const ageMs: number | null = this.updatedAtMs > 0 ? Date.now() - this.updatedAtMs : null;
		const online: boolean = this.isOnline();
		return {
			online,
			stale: ageMs === null || ageMs > EDITOR_CONTEXT_STALE_MS,
			updatedAt: this.updatedAtMs > 0 ? new Date(this.updatedAtMs).toISOString() : null,
			ageMs,
			context: online ? this.context : {},
			error: online ? null : "editor_unavailable"
		};
	}

	private requestEditorTool(toolName: string, args: JsonObject): Promise<unknown> {
		if (!isSocketOpen(this.socket)) {
			return Promise.reject(new Error("editor_unavailable: Godot editor client is not connected"));
		}

		const callId: string = `editor-tool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
		return new Promise<unknown>((resolve, reject): void => {
			const timeout: NodeJS.Timeout = setTimeout((): void => {
				this.pendingToolCalls.delete(callId);
				reject(new Error(`editor_tool_timeout: ${toolName}`));
			}, EDITOR_TOOL_TIMEOUT_MS);

			this.pendingToolCalls.set(callId, {
				resolve,
				reject,
				timeout
			});

			try {
				this.socket?.send(JSON.stringify({
					type: "event",
					id: callId,
					event: "editor.tool.requested",
					data: {
						callId,
						toolName,
						args
					}
				}));
			} catch (error: unknown) {
				this.pendingToolCalls.delete(callId);
				clearTimeout(timeout);
				reject(error instanceof Error ? error : new Error("editor_tool_send_failed"));
			}
		});
	}
}
