import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import * as channelTokens from "../vault/channel-tokens.js";
import { resolveTelegramToken } from "./token.js";

function withTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-token-"));
}

describe("resolveTelegramToken", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("prefers config token over env", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "env-token");
    const cfg = {
      channels: { telegram: { botToken: "cfg-token" } },
    } as OpenClawConfig;
    const res = resolveTelegramToken(cfg);
    expect(res.token).toBe("cfg-token");
    expect(res.source).toBe("config");
  });

  it("uses env token when config is missing", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "env-token");
    const cfg = {
      channels: { telegram: {} },
    } as OpenClawConfig;
    const res = resolveTelegramToken(cfg);
    expect(res.token).toBe("env-token");
    expect(res.source).toBe("env");
  });

  it("uses tokenFile when configured", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const dir = withTempDir();
    const tokenFile = path.join(dir, "token.txt");
    fs.writeFileSync(tokenFile, "file-token\n", "utf-8");
    const cfg = { channels: { telegram: { tokenFile } } } as OpenClawConfig;
    const res = resolveTelegramToken(cfg);
    expect(res.token).toBe("file-token");
    expect(res.source).toBe("tokenFile");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to config token when no env or tokenFile", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const cfg = {
      channels: { telegram: { botToken: "cfg-token" } },
    } as OpenClawConfig;
    const res = resolveTelegramToken(cfg);
    expect(res.token).toBe("cfg-token");
    expect(res.source).toBe("config");
  });

  it("does not fall back to config when tokenFile is missing", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const dir = withTempDir();
    const tokenFile = path.join(dir, "missing-token.txt");
    const cfg = {
      channels: { telegram: { tokenFile, botToken: "cfg-token" } },
    } as OpenClawConfig;
    const res = resolveTelegramToken(cfg);
    expect(res.token).toBe("");
    expect(res.source).toBe("none");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("resolves per-account tokens when the config account key casing doesn't match routing normalization", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const cfg = {
      channels: {
        telegram: {
          accounts: {
            // Note the mixed-case key; runtime accountId is normalized.
            careyNotifications: { botToken: "acct-token" },
          },
        },
      },
    } as OpenClawConfig;

    const res = resolveTelegramToken(cfg, { accountId: "careynotifications" });
    expect(res.token).toBe("acct-token");
    expect(res.source).toBe("config");
  });

  // --- Vault source tests ---

  it("vault token takes priority over config and env", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "env-token");
    vi.spyOn(channelTokens, "getVaultChannelToken").mockImplementation((name) =>
      name === "TELEGRAM_BOT_TOKEN" ? "vault-token" : undefined,
    );
    const cfg = {
      channels: { telegram: { botToken: "cfg-token" } },
    } as OpenClawConfig;
    const res = resolveTelegramToken(cfg);
    expect(res.token).toBe("vault-token");
    expect(res.source).toBe("vault");
  });

  it("falls through when vault token is not set", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "env-token");
    vi.spyOn(channelTokens, "getVaultChannelToken").mockReturnValue(undefined);
    const cfg = {
      channels: { telegram: { botToken: "cfg-token" } },
    } as OpenClawConfig;
    const res = resolveTelegramToken(cfg);
    expect(res.token).toBe("cfg-token");
    expect(res.source).toBe("config");
  });

  it("vault token for non-default account uses uppercase suffix", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    vi.spyOn(channelTokens, "getVaultChannelToken").mockImplementation((name) =>
      name === "TELEGRAM_BOT_TOKEN_WORK" ? "vault-work-token" : undefined,
    );
    const cfg = {
      channels: { telegram: {} },
    } as OpenClawConfig;
    const res = resolveTelegramToken(cfg, { accountId: "work" });
    expect(res.token).toBe("vault-work-token");
    expect(res.source).toBe("vault");
  });
});
