/**
 * In-memory store for channel tokens fetched from the vault sidecar.
 *
 * At gateway startup, `fetchVaultChannelTokens()` pulls channel tokens
 * (Telegram bot token, Discord token, Slack tokens) from the vault
 * sidecar's HTTP endpoints on the internal network (port 5335).
 *
 * Tokens are stored in a global Map shared via `Symbol.for()` so that
 * both the main bundle and jiti-loaded extension plugins access the same
 * store. Without this, the bundler inlines the module into a chunk with
 * its own closure, while jiti creates a separate instance — two stores,
 * one populated, one empty.
 */
import type { OpenClawConfig } from "../config/config.js";
import { VAULT_CHANNEL_DEFAULTS } from "./operations.js";

const STORE_KEY = Symbol.for("openclaw.vaultChannelTokenStore");

const store: Map<string, string> = (() => {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: Map<string, string> };
  if (!g[STORE_KEY]) {
    g[STORE_KEY] = new Map();
  }
  return g[STORE_KEY];
})();
const VAULT_TOKEN_PORT = 5335;
const FETCH_TIMEOUT_MS = 5000;

/**
 * Derive vault sidecar hostname from first configured proxy URL.
 * Falls back to "vault" (docker-compose service name).
 */
function resolveVaultHost(cfg: OpenClawConfig): string {
  const proxies = cfg.vault?.proxies;
  if (proxies) {
    for (const url of Object.values(proxies)) {
      try {
        return new URL(url).hostname;
      } catch {
        /* skip malformed */
      }
    }
  }
  return "vault";
}

/**
 * Fetch channel tokens from vault sidecar HTTP endpoint.
 * Call once at gateway startup, before channels are initialized.
 * Errors are logged but not fatal (channels fall back to config/env).
 */
export async function fetchVaultChannelTokens(
  cfg: OpenClawConfig,
  log?: (msg: string) => void,
): Promise<void> {
  if (!cfg.vault?.enabled) {
    return;
  }
  const host = resolveVaultHost(cfg);
  for (const entry of Object.values(VAULT_CHANNEL_DEFAULTS)) {
    try {
      const resp = await fetch(`http://${host}:${VAULT_TOKEN_PORT}/tokens/${entry.secretName}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (resp.ok) {
        const token = (await resp.text()).trim();
        if (token) {
          store.set(entry.secretName, token);
          log?.(`vault: channel token loaded: ${entry.secretName}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log?.(`vault: failed to fetch ${entry.secretName}: ${msg}`);
    }
  }
}

/** Retrieve a channel token from the in-memory store. */
export function getVaultChannelToken(secretName: string): string | undefined {
  return store.get(secretName);
}

export const __testing = {
  clearChannelTokenStore: (): void => {
    store.clear();
  },
};
