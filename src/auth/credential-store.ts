/**
 * Secrets (OAuth refresh tokens, AI API keys, the Calendar payload
 * encryption key) must never live in config files, SQLite, logs, or shell
 * history. This interface is the only path to durable secret storage; the
 * OS-backed implementation is the only one used outside tests.
 */
export interface CredentialStore {
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}

const SERVICE_NAME = "gmail-agent-cli";

export class CredentialStoreUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      "The OS credential store (macOS Keychain, Windows Credential Manager, or " +
        "Linux Secret Service) is unavailable. Refusing to store secrets in a " +
        "plaintext fallback. Run `gmail doctor` for details.",
      { cause }
    );
    this.name = "CredentialStoreUnavailableError";
  }
}

/** The subset of keytar's surface this store actually calls. */
interface KeytarBinding {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

/**
 * Thin wrapper over `keytar`, which shells out to the native OS secret
 * store on each platform. Loaded lazily so environments without the
 * native module can still run commands that never touch secrets.
 */
export class OsCredentialStore implements CredentialStore {
  private keytarPromise: Promise<KeytarBinding> | null = null;

  private async keytar(): Promise<KeytarBinding> {
    this.keytarPromise ??= import("keytar")
      .then((mod) => {
        // keytar is CJS with `module.exports = <native binding>`; Node's
        // ESM interop cannot statically detect all of its named exports,
        // so `.default` is the reliable full surface.
        const resolved = (mod.default ?? mod) as unknown as KeytarBinding;
        if (typeof resolved.setPassword !== "function") {
          throw new Error("keytar module did not resolve to a usable binding");
        }
        return resolved;
      })
      .catch((error: unknown) => {
        throw new CredentialStoreUnavailableError(error);
      });
    return this.keytarPromise;
  }

  async getSecret(key: string): Promise<string | null> {
    const keytar = await this.keytar();
    return keytar.getPassword(SERVICE_NAME, key);
  }

  async setSecret(key: string, value: string): Promise<void> {
    const keytar = await this.keytar();
    await keytar.setPassword(SERVICE_NAME, key, value);
  }

  async deleteSecret(key: string): Promise<void> {
    const keytar = await this.keytar();
    await keytar.deletePassword(SERVICE_NAME, key);
  }
}

/** In-memory store for tests only. Never used for real credentials. */
export class InMemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<string, string>();

  async getSecret(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async setSecret(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async deleteSecret(key: string): Promise<void> {
    this.values.delete(key);
  }
}

export const CREDENTIAL_KEYS = {
  oauthRefreshToken: (accountHash: string) => `oauth-refresh-token:${accountHash}`,
  aiApiKey: (accountHash: string) => `ai-api-key:${accountHash}`,
  calendarPayloadKey: (accountHash: string) => `calendar-payload-key:${accountHash}`
} as const;
