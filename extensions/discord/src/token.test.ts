import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import * as channelTokens from "../../../src/vault/channel-tokens.js";
import { resolveDiscordToken } from "./token.js";

describe("resolveDiscordToken", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("prefers config token over env", () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "env-token");
    const cfg = {
      channels: { discord: { token: "cfg-token" } },
    } as OpenClawConfig;
    const res = resolveDiscordToken(cfg);
    expect(res.token).toBe("cfg-token");
    expect(res.source).toBe("config");
  });

  it("uses env token when config is missing", () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "env-token");
    const cfg = {
      channels: { discord: {} },
    } as OpenClawConfig;
    const res = resolveDiscordToken(cfg);
    expect(res.token).toBe("env-token");
    expect(res.source).toBe("env");
  });

  it("prefers account token for non-default accounts", () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "env-token");
    const cfg = {
      channels: {
        discord: {
          token: "base-token",
          accounts: {
            work: { token: "acct-token" },
          },
        },
      },
    } as OpenClawConfig;
    const res = resolveDiscordToken(cfg, { accountId: "work" });
    expect(res.token).toBe("acct-token");
    expect(res.source).toBe("config");
  });

  it("falls back to top-level token for non-default accounts without account token", () => {
    const cfg = {
      channels: {
        discord: {
          token: "base-token",
          accounts: {
            work: {},
          },
        },
      },
    } as OpenClawConfig;
    const res = resolveDiscordToken(cfg, { accountId: "work" });
    expect(res.token).toBe("base-token");
    expect(res.source).toBe("config");
  });

  it("does not inherit top-level token when account token is explicitly blank", () => {
    const cfg = {
      channels: {
        discord: {
          token: "base-token",
          accounts: {
            work: { token: "" },
          },
        },
      },
    } as OpenClawConfig;
    const res = resolveDiscordToken(cfg, { accountId: "work" });
    expect(res.token).toBe("");
    expect(res.source).toBe("none");
  });

  it("resolves account token when account key casing differs from normalized id", () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            Work: { token: "acct-token" },
          },
        },
      },
    } as OpenClawConfig;
    const res = resolveDiscordToken(cfg, { accountId: "work" });
    expect(res.token).toBe("acct-token");
    expect(res.source).toBe("config");
  });

  it("throws when token is an unresolved SecretRef object", () => {
    const cfg = {
      channels: {
        discord: {
          token: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
        },
      },
    } as unknown as OpenClawConfig;

    expect(() => resolveDiscordToken(cfg)).toThrow(
      /channels\.discord\.token: unresolved SecretRef/i,
    );
  });

  // --- Vault source tests ---

  it("vault token takes priority over config and env", () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "env-token");
    vi.spyOn(channelTokens, "getVaultChannelToken").mockImplementation((name) =>
      name === "DISCORD_BOT_TOKEN" ? "vault-discord-token" : undefined,
    );
    const cfg = {
      channels: { discord: { token: "cfg-token" } },
    } as OpenClawConfig;
    const res = resolveDiscordToken(cfg);
    expect(res.token).toBe("vault-discord-token");
    expect(res.source).toBe("vault");
  });

  it("strips Bot prefix from vault token", () => {
    vi.spyOn(channelTokens, "getVaultChannelToken").mockImplementation((name) =>
      name === "DISCORD_BOT_TOKEN" ? "Bot actual-token" : undefined,
    );
    const cfg = { channels: { discord: {} } } as OpenClawConfig;
    const res = resolveDiscordToken(cfg);
    expect(res.token).toBe("actual-token");
    expect(res.source).toBe("vault");
  });

  it("falls through when vault token is not set", () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "env-token");
    vi.spyOn(channelTokens, "getVaultChannelToken").mockReturnValue(undefined);
    const cfg = {
      channels: { discord: { token: "cfg-token" } },
    } as OpenClawConfig;
    const res = resolveDiscordToken(cfg);
    expect(res.token).toBe("cfg-token");
    expect(res.source).toBe("config");
  });

  it("vault token for non-default account uses uppercase suffix", () => {
    vi.spyOn(channelTokens, "getVaultChannelToken").mockImplementation((name) =>
      name === "DISCORD_BOT_TOKEN_WORK" ? "vault-work-token" : undefined,
    );
    const cfg = {
      channels: { discord: {} },
    } as OpenClawConfig;
    const res = resolveDiscordToken(cfg, { accountId: "work" });
    expect(res.token).toBe("vault-work-token");
    expect(res.source).toBe("vault");
  });
});
