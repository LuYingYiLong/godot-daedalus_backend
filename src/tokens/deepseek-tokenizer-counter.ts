import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import type { TokenCounter } from "./token-counter.js";
import type { ChatMessage } from "../protocol/types.js";

const TOKENIZER_SCRIPT: string = resolve("scripts/deepseek-tokenizer-server.py");
const DEFAULT_TOKENIZER_DIR: string = resolve("scripts/tokenizer");
const START_TIMEOUT_MS: number = 30_000;
const REQUEST_TIMEOUT_MS: number = 10_000;

type PendingRequest = {
	resolve: (tokens: number) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
};

export class DeepSeekTokenizerCounter implements TokenCounter {
	private process: ChildProcess | null = null;
	private pending: Map<number, PendingRequest> = new Map();
	private requestId: number = 0;
	private ready: boolean = false;
	private initPromise: Promise<void> | null = null;

	async initialize(): Promise<void> {
		if (this.initPromise) {
			return this.initPromise;
		}

		this.initPromise = this.startProcess();
		return this.initPromise;
	}

	private startProcess(): Promise<void> {
		return new Promise<void>((resolvePromise, rejectPromise) => {
			const tokenizerDir: string = process.env.DEEPSEEK_TOKENIZER_DIR ?? DEFAULT_TOKENIZER_DIR;
			const pythonCmd: string = process.env.PYTHON_CMD ?? "python";
			let startupSettled: boolean = false;

			const child: ChildProcess = spawn(pythonCmd, [TOKENIZER_SCRIPT, tokenizerDir], {
				stdio: ["pipe", "pipe", "pipe"]
			});

			const startTimeout: ReturnType<typeof setTimeout> = setTimeout((): void => {
				rejectStartup(new Error("Tokenizer startup timed out. Install transformers: pip install transformers"));
			}, START_TIMEOUT_MS);

			const resolveStartup = (): void => {
				if (startupSettled) {
					return;
				}

				startupSettled = true;
				clearTimeout(startTimeout);
				resolvePromise();
			};

			const rejectStartup = (error: Error): void => {
				if (startupSettled) {
					return;
				}

				startupSettled = true;
				clearTimeout(startTimeout);
				rejectPromise(error);
			};

			const rl = createInterface({ input: child.stdout! });

			rl.on("line", (line: string): void => {
				const trimmed: string = line.trim();
				if (trimmed.length === 0) {
					return;
				}

				try {
					const response: { id?: number; ready?: boolean; tokens?: number; error?: string } = JSON.parse(trimmed) as {
						id?: number; ready?: boolean; tokens?: number; error?: string;
					};

					if (response.ready === true) {
						this.ready = true;
						resolveStartup();
						return;
					}

					if (response.error) {
						const error: Error = new Error(response.error);
						if (!this.ready) {
							rejectStartup(error);
							return;
						}

						if (response.id !== undefined) {
							this.rejectPending(response.id, error);
						} else {
							this.rejectAll(error);
						}
						return;
					}

					if (response.tokens !== undefined) {
						if (response.id !== undefined) {
							this.resolvePending(response.id, response.tokens);
						} else {
							this.resolveFirstPending(response.tokens);
						}
					}
				} catch {
					// Non-JSON output from Python — ignore (e.g., warnings)
				}
			});

			child.stderr?.on("data", (data: Buffer): void => {
				console.error("[tokenizer]", data.toString("utf8").trimEnd());
			});

			child.on("error", (error: Error): void => {
				this.ready = false;
				this.process = null;
				this.initPromise = null;
				rejectStartup(error);
				this.rejectAll(error);
			});

			child.on("close", (): void => {
				this.ready = false;
				this.process = null;
				this.initPromise = null;
				const error: Error = new Error("Tokenizer process exited");
				rejectStartup(error);
				this.rejectAll(error);
			});

			this.process = child;
		});
	}

	private sendRequest(text: string): Promise<number> {
		return new Promise<number>((resolve, reject) => {
			if (!this.process?.stdin?.writable) {
				reject(new Error("Tokenizer process is not writable"));
				return;
			}

			const id: number = this.requestId;
			this.requestId += 1;

			const timeout: ReturnType<typeof setTimeout> = setTimeout((): void => {
				this.pending.delete(id);
				reject(new Error("Tokenizer request timed out"));
			}, REQUEST_TIMEOUT_MS);

			this.pending.set(id, { resolve, reject, timeout });

			this.process.stdin.write(JSON.stringify({ id, text }) + "\n", (error: Error | null | undefined): void => {
				if (error !== null && error !== undefined) {
					this.rejectPending(id, error);
				}
			});
		});
	}

	private resolvePending(id: number, tokens: number): void {
		const pending: PendingRequest | undefined = this.pending.get(id);
		if (pending === undefined) {
			return;
		}

		clearTimeout(pending.timeout);
		pending.resolve(tokens);
		this.pending.delete(id);
	}

	private resolveFirstPending(tokens: number): void {
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timeout);
			pending.resolve(tokens);
			this.pending.delete(id);
			return;
		}
	}

	private rejectPending(id: number, error: Error): void {
		const pending: PendingRequest | undefined = this.pending.get(id);
		if (pending === undefined) {
			return;
		}

		clearTimeout(pending.timeout);
		pending.reject(error);
		this.pending.delete(id);
	}

	private rejectAll(error: Error): void {
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timeout);
			pending.reject(error);
			this.pending.delete(id);
		}
	}

	async countText(text: string): Promise<number> {
		if (!this.ready) {
			await this.initialize();
		}

		return this.sendRequest(text);
	}

	async countMessages(messages: ChatMessage[]): Promise<number> {
		const combined: string = messages.map((m: ChatMessage): string => m.content).join("\n");
		const baseTokens: number = await this.countText(combined);
		return baseTokens + messages.length * 4;
	}

	async dispose(): Promise<void> {
		if (this.process) {
			this.process.stdin?.end();
			this.process.kill();
			this.process = null;
		}

		this.ready = false;
	}
}
