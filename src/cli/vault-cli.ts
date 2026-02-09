/**
 * `openclaw vault` CLI — manage age-encrypted secrets for the vault proxy.
 *
 * Subcommands:
 *   init     — generate keypair, create vault.age, store publicKey in config
 *   status   — show vault state (no decryption needed)
 *   add      — add or update a secret in vault.age
 *   remove   — remove a secret from vault.age
 *   list     — list secret names (optionally reveal partial values)
 *   migrate  — migrate plaintext apiKey values from config into vault.age
 */
import type { Command } from "commander";
import fs from "node:fs";
import { stdin as stdinStream, stdout as stdoutStream } from "node:process";
import readline from "node:readline/promises";
import { VAULT_PROXY_PLACEHOLDER_KEY } from "../agents/model-auth.js";
import { loadConfig, readConfigFileSnapshot, writeConfigFile } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import {
  VAULT_CHANNEL_DEFAULTS,
  buildDefaultProxyMap,
  decryptVault,
  encryptVault,
  findProviderBySecretName,
  generateKeypair,
  isChannelTokenSecret,
  providerProxyUrl,
  providerSecretName,
  resolveAgeSecretKey,
  resolveVaultFilePath,
} from "../vault/operations.js";
import { runCommandWithRuntime } from "./cli-utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the secret value from CLI argument, stdin pipe, or interactive prompt.
 * Avoids exposing secrets in process arguments when using --stdin or prompt.
 */
async function resolveSecretValue(value: string | undefined, useStdin: boolean): Promise<string> {
  if (value !== undefined) {
    return value;
  }
  if (useStdin) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdinStream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const result = Buffer.concat(chunks).toString("utf-8").trim();
    if (!result) {
      throw new Error("Empty value received from stdin.");
    }
    return result;
  }
  if (stdinStream.isTTY) {
    const rl = readline.createInterface({ input: stdinStream, output: stdoutStream });
    try {
      const answer = await rl.question("Enter secret value: ");
      const trimmed = answer.trim();
      if (!trimmed) {
        throw new Error("Empty value provided.");
      }
      return trimmed;
    } finally {
      rl.close();
    }
  }
  throw new Error(
    "No secret value provided.\n" +
      "Provide it as an argument, via --stdin, or run in a terminal for a prompt.",
  );
}

const VALID_SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;

function validateSecretName(name: string): void {
  if (!VALID_SECRET_NAME.test(name)) {
    throw new Error(
      `Invalid secret name: ${JSON.stringify(name)}\n` +
        "Secret names must match [A-Z][A-Z0-9_]* (e.g. OPENAI_API_KEY).",
    );
  }
}

function maskValue(value: string): string {
  if (value.length <= 8) {
    return "*".repeat(value.length);
  }
  const visible = 4;
  return value.slice(0, visible) + "*".repeat(value.length - visible * 2) + value.slice(-visible);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerVaultCli(program: Command) {
  const vault = program.command("vault").description("Vault secret management (age encryption)");

  // ---- init ----------------------------------------------------------------
  vault
    .command("init")
    .description("Initialize vault: generate keypair, create vault.age, update config")
    .option("--force", "Overwrite existing vault.age and keypair", false)
    .option("--proxy-host <host>", "Proxy hostname for auto-configured URLs", "vault")
    .action(async (opts) =>
      runCommandWithRuntime(defaultRuntime, async () => {
        const cfg = loadConfig();
        const vaultPath = resolveVaultFilePath(cfg);

        if (fs.existsSync(vaultPath) && !opts.force) {
          throw new Error(`Vault file already exists: ${vaultPath}\nUse --force to overwrite.`);
        }

        const keypair = await generateKeypair();

        // Create empty vault.age encrypted with the new public key
        await encryptVault(new Map(), keypair.recipient, vaultPath);

        // Build default proxy mappings from provider registry
        const defaultProxies = buildDefaultProxyMap(opts.proxyHost);

        // Update config with vault settings + default proxy mappings
        const snapshot = await readConfigFileSnapshot();
        const next = {
          ...snapshot.config,
          vault: {
            ...snapshot.config.vault,
            enabled: true,
            publicKey: keypair.recipient,
            proxies: {
              ...defaultProxies,
              ...snapshot.config.vault?.proxies, // preserve user overrides
            },
          },
        };
        await writeConfigFile(next);

        defaultRuntime.log(theme.heading("Vault initialized"));
        defaultRuntime.log("");
        defaultRuntime.log(`Vault file: ${vaultPath}`);
        defaultRuntime.log(`Public key: ${keypair.recipient}`);
        defaultRuntime.log("");
        defaultRuntime.log(
          theme.warn("Save this secret key securely. It will not be shown again:"),
        );
        defaultRuntime.log("");
        defaultRuntime.log(`  ${keypair.identity}`);
        defaultRuntime.log("");
        defaultRuntime.log(
          theme.muted("Store it in a password manager (KeePass, 1Password, etc.)."),
        );
        defaultRuntime.log(
          theme.muted("You will need it for: vault add, vault remove, vault list, vault migrate."),
        );
        defaultRuntime.log(
          theme.muted("Provide it via: AGE_SECRET_KEY=<key> openclaw vault <command>"),
        );
      }),
    );

  // ---- status --------------------------------------------------------------
  vault
    .command("status")
    .description("Show vault configuration and file state (no decryption needed)")
    .action(async () =>
      runCommandWithRuntime(defaultRuntime, async () => {
        const cfg = loadConfig();
        const vaultPath = resolveVaultFilePath(cfg);
        const vaultExists = fs.existsSync(vaultPath);

        const rows: Array<{ Key: string; Value: string }> = [
          { Key: "Enabled", Value: cfg.vault?.enabled ? "yes" : "no" },
          { Key: "Vault file", Value: vaultPath },
          { Key: "File exists", Value: vaultExists ? "yes" : "no" },
        ];

        if (vaultExists) {
          const stat = fs.statSync(vaultPath);
          rows.push({ Key: "File size", Value: `${stat.size} bytes` });
        }

        rows.push({
          Key: "Public key",
          Value: cfg.vault?.publicKey ?? "(not set)",
        });

        const proxies = cfg.vault?.proxies;
        if (proxies && Object.keys(proxies).length > 0) {
          rows.push({ Key: "Proxy mappings", Value: "" });
          for (const [provider, url] of Object.entries(proxies)) {
            rows.push({ Key: `  ${provider}`, Value: url });
          }
        } else {
          rows.push({ Key: "Proxy mappings", Value: "(none)" });
        }

        // Channel token status (check vault.age for stored tokens)
        let vaultSecrets: Map<string, string> | undefined;
        if (vaultExists && cfg.vault?.publicKey) {
          try {
            const secretKey = await resolveAgeSecretKey(process.env, false);
            vaultSecrets = await decryptVault(vaultPath, secretKey);
          } catch {
            // No secret key available -- skip channel token details
          }
        }
        rows.push({ Key: "Channel tokens", Value: "" });
        for (const entry of Object.values(VAULT_CHANNEL_DEFAULTS)) {
          const stored = vaultSecrets?.has(entry.secretName) ?? false;
          rows.push({
            Key: `  ${entry.secretName}`,
            Value: stored ? `stored (endpoint: /tokens/${entry.secretName})` : "not configured",
          });
        }

        const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
        defaultRuntime.log(theme.heading("Vault status"));
        defaultRuntime.log(
          renderTable({
            width: tableWidth,
            columns: [
              { key: "Key", header: "Property", minWidth: 18 },
              { key: "Value", header: "Value", minWidth: 24, flex: true },
            ],
            rows,
          }).trimEnd(),
        );
      }),
    );

  // ---- add -----------------------------------------------------------------
  vault
    .command("add <name> [value]")
    .description("Add or update a secret in vault.age")
    .option("--stdin", "Read secret value from stdin (avoids shell history exposure)")
    .option("--no-proxy", "Skip automatic proxy configuration for known providers")
    .option("--proxy-host <host>", "Proxy hostname for auto-configured URLs", "vault")
    .action(async (name: string, value: string | undefined, opts) =>
      runCommandWithRuntime(defaultRuntime, async () => {
        validateSecretName(name);
        // Resolve value early — before any other stdin usage (e.g. AGE_SECRET_KEY prompt)
        const secretValue = await resolveSecretValue(value, Boolean(opts.stdin));

        const cfg = loadConfig();
        const vaultPath = resolveVaultFilePath(cfg);
        const publicKey = cfg.vault?.publicKey;

        if (!publicKey) {
          throw new Error("No vault public key in config. Run 'openclaw vault init' first.");
        }

        // Decrypt existing secrets (or start fresh if vault.age doesn't exist yet)
        let secrets: Map<string, string>;
        if (fs.existsSync(vaultPath)) {
          const secretKey = await resolveAgeSecretKey();
          secrets = await decryptVault(vaultPath, secretKey);
        } else {
          secrets = new Map();
        }

        const isUpdate = secrets.has(name);
        secrets.set(name, secretValue);
        await encryptVault(secrets, publicKey, vaultPath);

        defaultRuntime.log(`${isUpdate ? "Updated" : "Added"} secret: ${name}`);

        // Channel tokens don't need proxy mappings — gateway fetches via HTTP endpoint
        if (isChannelTokenSecret(name)) {
          defaultRuntime.log(
            "Channel token stored. Gateway will fetch from vault at startup (no proxy mapping needed).",
          );
          return;
        }

        // Auto-configure proxy for known providers
        if (opts.proxy !== false) {
          const matchingProvider = findProviderBySecretName(name);
          if (matchingProvider) {
            const [providerName] = matchingProvider;
            const proxyUrl = providerProxyUrl(providerName, opts.proxyHost);
            if (proxyUrl) {
              const snapshot = await readConfigFileSnapshot();
              const existingProxies = snapshot.config.vault?.proxies ?? {};
              if (!existingProxies[providerName]) {
                const next = {
                  ...snapshot.config,
                  vault: {
                    ...snapshot.config.vault,
                    proxies: {
                      ...existingProxies,
                      [providerName]: proxyUrl,
                    },
                  },
                };
                await writeConfigFile(next);
                defaultRuntime.log(`Auto-configured proxy: ${providerName} -> ${proxyUrl}`);
              }
            }
          }
        }
      }),
    );

  // ---- remove --------------------------------------------------------------
  vault
    .command("remove <name>")
    .description("Remove a secret from vault.age")
    .action(async (name: string) =>
      runCommandWithRuntime(defaultRuntime, async () => {
        validateSecretName(name);
        const cfg = loadConfig();
        const vaultPath = resolveVaultFilePath(cfg);
        const publicKey = cfg.vault?.publicKey;

        if (!publicKey) {
          throw new Error("No vault public key in config. Run 'openclaw vault init' first.");
        }
        if (!fs.existsSync(vaultPath)) {
          throw new Error(`Vault file not found: ${vaultPath}`);
        }

        const secretKey = await resolveAgeSecretKey();
        const secrets = await decryptVault(vaultPath, secretKey);

        if (!secrets.has(name)) {
          throw new Error(`Secret not found in vault: ${name}`);
        }

        secrets.delete(name);
        await encryptVault(secrets, publicKey, vaultPath);
        defaultRuntime.log(`Removed secret: ${name}`);

        // Remove matching proxy entry from config
        const matchingProvider = findProviderBySecretName(name);
        if (matchingProvider) {
          const [providerName] = matchingProvider;
          const snapshot = await readConfigFileSnapshot();
          const existingProxies = snapshot.config.vault?.proxies;
          if (existingProxies?.[providerName]) {
            const { [providerName]: _, ...remainingProxies } = existingProxies;
            const next = {
              ...snapshot.config,
              vault: {
                ...snapshot.config.vault,
                proxies: remainingProxies,
              },
            };
            await writeConfigFile(next);
            defaultRuntime.log(`Removed proxy mapping: ${providerName}`);
          }
        }
      }),
    );

  // ---- list ----------------------------------------------------------------
  vault
    .command("list")
    .description("List secrets stored in vault.age")
    .option("--reveal", "Show partial secret values (first 4 + last 4 chars)")
    .option("--json", "Output as JSON")
    .action(async (opts) =>
      runCommandWithRuntime(defaultRuntime, async () => {
        const cfg = loadConfig();
        const vaultPath = resolveVaultFilePath(cfg);

        if (!fs.existsSync(vaultPath)) {
          throw new Error(`Vault file not found: ${vaultPath}`);
        }

        const secretKey = await resolveAgeSecretKey();
        const secrets = await decryptVault(vaultPath, secretKey);

        if (opts.json) {
          const obj: Record<string, string> = {};
          for (const [key, value] of secrets) {
            obj[key] = opts.reveal ? value : maskValue(value);
          }
          defaultRuntime.log(JSON.stringify(obj, null, 2));
          return;
        }

        if (secrets.size === 0) {
          defaultRuntime.log(theme.muted("Vault is empty."));
          return;
        }

        const rows = [...secrets.entries()].map(([key, value]) => ({
          Name: key,
          Value: opts.reveal ? maskValue(value) : "(hidden)",
        }));

        const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
        defaultRuntime.log(theme.heading(`Vault secrets (${secrets.size})`));
        defaultRuntime.log(
          renderTable({
            width: tableWidth,
            columns: [
              { key: "Name", header: "Secret", minWidth: 24 },
              { key: "Value", header: "Value", minWidth: 24, flex: true },
            ],
            rows,
          }).trimEnd(),
        );
      }),
    );

  // ---- migrate -------------------------------------------------------------
  vault
    .command("migrate")
    .description("Migrate plaintext API keys from config into vault.age")
    .option("--dry-run", "Preview changes without modifying files", false)
    .option("--proxy-host <host>", "Proxy hostname for auto-configured URLs", "vault")
    .action(async (opts) =>
      runCommandWithRuntime(defaultRuntime, async () => {
        const snapshot = await readConfigFileSnapshot();
        const cfg = snapshot.config;
        const providers = cfg.models?.providers ?? {};

        // Collect providers with plaintext apiKey
        const toMigrate: Array<{
          providerName: string;
          apiKey: string;
          secretName: string;
        }> = [];
        for (const [providerName, providerCfg] of Object.entries(providers)) {
          const apiKey = (providerCfg as { apiKey?: string }).apiKey;
          if (!apiKey || apiKey === VAULT_PROXY_PLACEHOLDER_KEY) {
            continue;
          }
          // Skip providers without a vault proxy mapping (e.g. ollama, autorouter).
          // Their keys must stay in config — there is no vault proxy to inject them.
          if (!providerProxyUrl(providerName, opts.proxyHost)) {
            continue;
          }
          const secretName =
            providerSecretName(providerName) ??
            `${providerName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
          toMigrate.push({ providerName, apiKey, secretName });
        }

        // Collect channel tokens from config using VAULT_CHANNEL_DEFAULTS registry
        const channelTokensToMigrate: Array<{
          secretName: string;
          token: string;
          configPath: string;
        }> = [];
        const channels = cfg.channels;
        if (channels) {
          for (const entry of Object.values(VAULT_CHANNEL_DEFAULTS)) {
            const channelCfg = channels[entry.channel as keyof typeof channels];
            if (!channelCfg) {
              continue;
            }
            // Base-level token
            const baseToken = (channelCfg as Record<string, unknown>)[entry.tokenField];
            if (typeof baseToken === "string" && baseToken.trim()) {
              channelTokensToMigrate.push({
                secretName: entry.secretName,
                token: baseToken.trim(),
                configPath: `channels.${entry.channel}.${entry.tokenField}`,
              });
            }
            // Account-level tokens
            const accounts = (channelCfg as Record<string, unknown>).accounts;
            if (accounts && typeof accounts === "object") {
              for (const [acctId, acctCfg] of Object.entries(accounts as Record<string, unknown>)) {
                const acctToken = (acctCfg as Record<string, unknown>)?.[entry.tokenField];
                if (typeof acctToken === "string" && acctToken.trim()) {
                  channelTokensToMigrate.push({
                    secretName: `${entry.secretName}_${acctId.toUpperCase()}`,
                    token: acctToken.trim(),
                    configPath: `channels.${entry.channel}.accounts.${acctId}.${entry.tokenField}`,
                  });
                }
              }
            }
          }
        }

        // Build default proxy mappings for ALL known providers
        const defaultProxies = buildDefaultProxyMap(opts.proxyHost);

        const totalCount = toMigrate.length + channelTokensToMigrate.length;
        if (totalCount === 0) {
          if (opts.dryRun) {
            defaultRuntime.log(
              theme.muted("No plaintext secrets found. Default proxy mappings would be written."),
            );
            return;
          }

          // No secrets to migrate, but still ensure default proxy mappings exist
          const next = {
            ...snapshot.config,
            vault: {
              ...snapshot.config.vault,
              proxies: {
                ...defaultProxies,
                ...snapshot.config.vault?.proxies, // preserve user overrides
              },
            },
          };
          await writeConfigFile(next);
          defaultRuntime.log(theme.muted("No plaintext secrets found in config."));
          defaultRuntime.log("Default proxy mappings updated.");
          return;
        }

        // Show summary
        const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
        if (toMigrate.length > 0) {
          defaultRuntime.log(theme.heading("Provider API keys"));
          defaultRuntime.log(
            renderTable({
              width: tableWidth,
              columns: [
                { key: "Provider", header: "Provider", minWidth: 14 },
                { key: "Secret", header: "Secret Name", minWidth: 24 },
                { key: "Proxy", header: "Proxy URL", minWidth: 24, flex: true },
              ],
              rows: toMigrate.map(({ providerName, secretName }) => ({
                Provider: providerName,
                Secret: secretName,
                Proxy: providerProxyUrl(providerName, opts.proxyHost) ?? "(manual setup needed)",
              })),
            }).trimEnd(),
          );
        }
        if (channelTokensToMigrate.length > 0) {
          defaultRuntime.log(theme.heading("Channel tokens"));
          defaultRuntime.log(
            renderTable({
              width: tableWidth,
              columns: [
                { key: "Config", header: "Config path", minWidth: 30, flex: true },
                { key: "Secret", header: "Secret Name", minWidth: 24 },
              ],
              rows: channelTokensToMigrate.map(({ secretName, configPath }) => ({
                Config: configPath,
                Secret: secretName,
              })),
            }).trimEnd(),
          );
        }

        if (opts.dryRun) {
          defaultRuntime.log("");
          defaultRuntime.log(theme.muted("Dry run — no changes made."));
          return;
        }

        // Initialize vault if needed
        const vaultPath = resolveVaultFilePath(cfg);
        let publicKey = cfg.vault?.publicKey;
        let printedIdentity: string | undefined;

        if (!publicKey) {
          const keypair = await generateKeypair();
          publicKey = keypair.recipient;
          printedIdentity = keypair.identity;

          // Create empty vault
          await encryptVault(new Map(), publicKey, vaultPath);
        }

        // Decrypt existing vault (or start fresh)
        let secrets: Map<string, string>;
        if (fs.existsSync(vaultPath)) {
          if (!printedIdentity) {
            // Existing vault — need key to decrypt
            const secretKey = await resolveAgeSecretKey();
            secrets = await decryptVault(vaultPath, secretKey);
          } else {
            // We just created it — empty
            secrets = new Map();
          }
        } else {
          secrets = new Map();
        }

        // Add provider secrets and build proxy mappings
        const proxyMappings: Record<string, string> = { ...defaultProxies };
        for (const { providerName, apiKey, secretName } of toMigrate) {
          secrets.set(secretName, apiKey);
          const proxyUrl = providerProxyUrl(providerName, opts.proxyHost);
          if (proxyUrl) {
            proxyMappings[providerName] = proxyUrl;
          }
        }

        // Add channel tokens
        for (const { secretName, token } of channelTokensToMigrate) {
          secrets.set(secretName, token);
        }

        await encryptVault(secrets, publicKey, vaultPath);

        // Update config: set vault enabled, proxies, publicKey; remove plaintext keys
        const nextProviders = { ...providers };
        for (const { providerName } of toMigrate) {
          const provider = nextProviders[providerName];
          if (provider && typeof provider === "object") {
            const { apiKey: _, ...rest } = provider as Record<string, unknown>;
            nextProviders[providerName] = rest as typeof provider;
          }
        }

        // Remove plaintext channel tokens from config
        const nextChannels = cfg.channels
          ? (JSON.parse(JSON.stringify(cfg.channels)) as typeof cfg.channels)
          : undefined;
        if (nextChannels) {
          for (const { configPath } of channelTokensToMigrate) {
            deleteNestedKey(nextChannels, configPath.replace("channels.", ""));
          }
        }

        const next = {
          ...snapshot.config,
          vault: {
            ...snapshot.config.vault,
            enabled: true,
            publicKey,
            proxies: {
              ...snapshot.config.vault?.proxies,
              ...proxyMappings,
            },
          },
          models: {
            ...snapshot.config.models,
            providers: nextProviders,
          },
          ...(nextChannels ? { channels: nextChannels } : {}),
        };
        await writeConfigFile(next);

        defaultRuntime.log("");
        for (const { secretName, configPath } of channelTokensToMigrate) {
          defaultRuntime.log(`Migrated channel token: ${secretName} (removed from ${configPath})`);
        }
        defaultRuntime.log(theme.success(`Migrated ${totalCount} secret(s) to vault.`));
        defaultRuntime.log(`Vault file: ${vaultPath}`);

        if (printedIdentity) {
          defaultRuntime.log("");
          defaultRuntime.log(
            theme.warn("Save this secret key securely. It will not be shown again:"),
          );
          defaultRuntime.log("");
          defaultRuntime.log(`  ${printedIdentity}`);
          defaultRuntime.log("");
          defaultRuntime.log(
            theme.muted("Store it in a password manager (KeePass, 1Password, etc.)."),
          );
        }
      }),
    );
}

// ---------------------------------------------------------------------------
// Helpers (internal)
// ---------------------------------------------------------------------------

/**
 * Delete a nested key from an object by dot-separated path.
 * E.g. deleteNestedKey(obj, "telegram.botToken") deletes obj.telegram.botToken.
 */
export function deleteNestedKey(obj: Record<string, unknown>, dotPath: string): void {
  const parts = dotPath.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!key) {
      return;
    }
    const next = current[key];
    if (!next || typeof next !== "object") {
      return;
    }
    current = next as Record<string, unknown>;
  }
  const lastKey = parts[parts.length - 1];
  if (lastKey) {
    delete current[lastKey];
  }
}
