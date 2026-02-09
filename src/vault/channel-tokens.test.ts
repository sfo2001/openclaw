import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { __testing, fetchVaultChannelTokens, getVaultChannelToken } from "./channel-tokens.js";

// ---------------------------------------------------------------------------
// Mock fetch to simulate the vault sidecar token endpoint
// ---------------------------------------------------------------------------

const TOKEN_RESPONSES: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: "tg-bot-secret-123",
  DISCORD_BOT_TOKEN: "discord-secret-456",
  // SLACK_BOT_TOKEN intentionally missing (simulates unconfigured)
  // SLACK_APP_TOKEN intentionally missing
};

function mockFetchForVault() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const match = url.match(/\/tokens\/(.+)$/);
    if (match) {
      const name = match[1] ?? "";
      const token = TOKEN_RESPONSES[name];
      return new Response(token ?? "", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }
    return new Response("not found", { status: 404 });
  });
}

afterEach(() => {
  __testing.clearChannelTokenStore();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// fetchVaultChannelTokens
// ---------------------------------------------------------------------------

describe("fetchVaultChannelTokens", () => {
  it("fetches tokens from vault sidecar and stores them", async () => {
    mockFetchForVault();
    const cfg: OpenClawConfig = {
      vault: {
        enabled: true,
        proxies: { openai: "http://vault:8081" },
      },
    };
    await fetchVaultChannelTokens(cfg);

    expect(getVaultChannelToken("TELEGRAM_BOT_TOKEN")).toBe("tg-bot-secret-123");
    expect(getVaultChannelToken("DISCORD_BOT_TOKEN")).toBe("discord-secret-456");
  });

  it("skips tokens with empty response body", async () => {
    mockFetchForVault();
    const cfg: OpenClawConfig = {
      vault: {
        enabled: true,
        proxies: { openai: "http://vault:8081" },
      },
    };
    await fetchVaultChannelTokens(cfg);

    // SLACK_BOT_TOKEN returns empty body
    expect(getVaultChannelToken("SLACK_BOT_TOKEN")).toBeUndefined();
    expect(getVaultChannelToken("SLACK_APP_TOKEN")).toBeUndefined();
  });

  it("does nothing when vault is disabled", async () => {
    const spy = mockFetchForVault();
    const cfg: OpenClawConfig = {
      vault: { enabled: false },
    };
    await fetchVaultChannelTokens(cfg);

    expect(spy).not.toHaveBeenCalled();
    expect(getVaultChannelToken("TELEGRAM_BOT_TOKEN")).toBeUndefined();
  });

  it("does nothing when vault config is missing", async () => {
    const spy = mockFetchForVault();
    const cfg: OpenClawConfig = {};
    await fetchVaultChannelTokens(cfg);

    expect(spy).not.toHaveBeenCalled();
    expect(getVaultChannelToken("TELEGRAM_BOT_TOKEN")).toBeUndefined();
  });

  it("falls back to 'vault' hostname when no proxies configured", async () => {
    const spy = mockFetchForVault();
    const cfg: OpenClawConfig = {
      vault: { enabled: true },
    };
    await fetchVaultChannelTokens(cfg);

    // Should use "vault" as default hostname
    const firstCallUrl = spy.mock.calls[0]?.[0] as string;
    expect(firstCallUrl).toMatch(/^http:\/\/vault:5335\//);
  });

  it("derives hostname from first proxy URL", async () => {
    const spy = mockFetchForVault();
    const cfg: OpenClawConfig = {
      vault: {
        enabled: true,
        proxies: { openai: "http://my-vault:8081" },
      },
    };
    await fetchVaultChannelTokens(cfg);

    const firstCallUrl = spy.mock.calls[0]?.[0] as string;
    expect(firstCallUrl).toMatch(/^http:\/\/my-vault:5335\//);
  });

  it("calls log callback for each loaded token", async () => {
    mockFetchForVault();
    const cfg: OpenClawConfig = {
      vault: {
        enabled: true,
        proxies: { openai: "http://vault:8081" },
      },
    };
    const messages: string[] = [];
    await fetchVaultChannelTokens(cfg, (msg) => messages.push(msg));

    expect(messages).toContain("vault: channel token loaded: TELEGRAM_BOT_TOKEN");
    expect(messages).toContain("vault: channel token loaded: DISCORD_BOT_TOKEN");
    // Not loaded (empty body) -- should not appear
    expect(messages.some((m) => m.includes("SLACK_BOT_TOKEN"))).toBe(false);
  });

  it("handles fetch errors gracefully without throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));
    const cfg: OpenClawConfig = {
      vault: {
        enabled: true,
        proxies: { openai: "http://vault:8081" },
      },
    };
    const messages: string[] = [];
    // Should not throw
    await fetchVaultChannelTokens(cfg, (msg) => messages.push(msg));

    expect(getVaultChannelToken("TELEGRAM_BOT_TOKEN")).toBeUndefined();
    // Should log the error for each token
    expect(
      messages.some((m) => m.includes("failed to fetch") && m.includes("connection refused")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getVaultChannelToken
// ---------------------------------------------------------------------------

describe("getVaultChannelToken", () => {
  it("returns undefined for unknown secret names", () => {
    expect(getVaultChannelToken("NONEXISTENT_TOKEN")).toBeUndefined();
  });

  it("returns undefined after store is cleared", async () => {
    mockFetchForVault();
    const cfg: OpenClawConfig = {
      vault: {
        enabled: true,
        proxies: { openai: "http://vault:8081" },
      },
    };
    await fetchVaultChannelTokens(cfg);
    expect(getVaultChannelToken("TELEGRAM_BOT_TOKEN")).toBe("tg-bot-secret-123");

    __testing.clearChannelTokenStore();
    expect(getVaultChannelToken("TELEGRAM_BOT_TOKEN")).toBeUndefined();
  });
});
