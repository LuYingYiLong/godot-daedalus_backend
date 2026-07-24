import { setSecretStoreDriverForTests, type SecretStoreDriver } from "../../src/secrets/secret-store.js";

export type MemorySecretStoreOptions = {
	onSet?: ((account: string, password: string) => void) | undefined;
	onDelete?: ((account: string) => void) | undefined;
};

export function installMemorySecretStore(initialSecrets: Record<string, string> = {}, options: MemorySecretStoreOptions = {}): Map<string, string> {
	const secrets: Map<string, string> = new Map(Object.entries(initialSecrets));
	const driver: SecretStoreDriver = {
		async getPassword(_service: string, account: string): Promise<string | null> {
			return secrets.get(account) ?? null;
		},
		async setPassword(_service: string, account: string, password: string): Promise<void> {
			options.onSet?.(account, password);
			secrets.set(account, password);
		},
		async deletePassword(_service: string, account: string): Promise<boolean> {
			options.onDelete?.(account);
			return secrets.delete(account);
		}
	};

	setSecretStoreDriverForTests(driver);
	return secrets;
}

export function installReadOnlySecretStore(getPassword: (service: string, account: string) => Promise<string | null>): void {
	setSecretStoreDriverForTests({
		getPassword,
		async setPassword(): Promise<void> {
			return undefined;
		},
		async deletePassword(): Promise<boolean> {
			return true;
		}
	});
}

export function installUnavailableSecretStore(): void {
	setSecretStoreDriverForTests(null);
}

export function resetSecretStoreDriver(): void {
	setSecretStoreDriverForTests(undefined);
}
