export type SessionRuntimeIdentity = {
	sessionId?: string | undefined;
};

export class SessionRuntimeRegistry<TRuntime extends SessionRuntimeIdentity> {
	private readonly runtimes: Map<string, TRuntime> = new Map();

	get(sessionId: string): TRuntime | undefined {
		return this.runtimes.get(sessionId);
	}

	bind(sessionId: string, candidate: TRuntime): TRuntime {
		for (const [registeredSessionId, runtime] of this.runtimes) {
			if (registeredSessionId !== sessionId && runtime === candidate) {
				throw new Error(`Session runtime is already bound to ${registeredSessionId}.`);
			}
		}

		const runtime: TRuntime = this.runtimes.get(sessionId) ?? candidate;
		this.runtimes.set(sessionId, runtime);
		return runtime;
	}

	remove(sessionId: string): void {
		this.runtimes.delete(sessionId);
	}
}
