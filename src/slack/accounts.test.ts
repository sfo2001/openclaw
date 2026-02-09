import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import * as channelTokens from "../vault/channel-tokens.js";
import { resolveSlackAccount } from "./accounts.js";

describe("resolveSlackAccount", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("resolves config tokens for default account", () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "");
    vi.stubEnv("SLACK_APP_TOKEN", "");
    const cfg = {
      channels: {
        slack: {
          botToken: "xoxb-config",
          appToken: "xapp-config",
        },
      },
    } as OpenClawConfig;
    const res = resolveSlackAccount({ cfg });
    expect(res.botToken).toBe("xoxb-config");
    expect(res.botTokenSource).toBe("config");
    expect(res.appToken).toBe("xapp-config");
    expect(res.appTokenSource).toBe("config");
  });

  it("resolves env tokens when config is missing", () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-env");
    vi.stubEnv("SLACK_APP_TOKEN", "xapp-env");
    const cfg = {
      channels: { slack: {} },
    } as OpenClawConfig;
    const res = resolveSlackAccount({ cfg });
    expect(res.botToken).toBe("xoxb-env");
    expect(res.botTokenSource).toBe("env");
    expect(res.appToken).toBe("xapp-env");
    expect(res.appTokenSource).toBe("env");
  });

  it("config tokens take priority over env", () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-env");
    vi.stubEnv("SLACK_APP_TOKEN", "xapp-env");
    const cfg = {
      channels: {
        slack: {
          botToken: "xoxb-config",
          appToken: "xapp-config",
        },
      },
    } as OpenClawConfig;
    const res = resolveSlackAccount({ cfg });
    expect(res.botToken).toBe("xoxb-config");
    expect(res.botTokenSource).toBe("config");
  });

  // --- Vault source tests ---

  it("vault tokens take priority over config and env", () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-env");
    vi.stubEnv("SLACK_APP_TOKEN", "xapp-env");
    vi.spyOn(channelTokens, "getVaultChannelToken").mockImplementation((name) => {
      if (name === "SLACK_BOT_TOKEN") {
        return "xoxb-vault";
      }
      if (name === "SLACK_APP_TOKEN") {
        return "xapp-vault";
      }
      return undefined;
    });
    const cfg = {
      channels: {
        slack: {
          botToken: "xoxb-config",
          appToken: "xapp-config",
        },
      },
    } as OpenClawConfig;
    const res = resolveSlackAccount({ cfg });
    expect(res.botToken).toBe("xoxb-vault");
    expect(res.botTokenSource).toBe("vault");
    expect(res.appToken).toBe("xapp-vault");
    expect(res.appTokenSource).toBe("vault");
  });

  it("vault bot token with config app token", () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "");
    vi.stubEnv("SLACK_APP_TOKEN", "");
    vi.spyOn(channelTokens, "getVaultChannelToken").mockImplementation((name) => {
      if (name === "SLACK_BOT_TOKEN") {
        return "xoxb-vault";
      }
      return undefined;
    });
    const cfg = {
      channels: {
        slack: { appToken: "xapp-config" },
      },
    } as OpenClawConfig;
    const res = resolveSlackAccount({ cfg });
    expect(res.botToken).toBe("xoxb-vault");
    expect(res.botTokenSource).toBe("vault");
    expect(res.appToken).toBe("xapp-config");
    expect(res.appTokenSource).toBe("config");
  });

  it("falls through when vault tokens are not set", () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "");
    vi.stubEnv("SLACK_APP_TOKEN", "");
    vi.spyOn(channelTokens, "getVaultChannelToken").mockReturnValue(undefined);
    const cfg = {
      channels: {
        slack: {
          botToken: "xoxb-config",
          appToken: "xapp-config",
        },
      },
    } as OpenClawConfig;
    const res = resolveSlackAccount({ cfg });
    expect(res.botToken).toBe("xoxb-config");
    expect(res.botTokenSource).toBe("config");
  });

  it("vault token for non-default account uses uppercase suffix", () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "");
    vi.stubEnv("SLACK_APP_TOKEN", "");
    vi.spyOn(channelTokens, "getVaultChannelToken").mockImplementation((name) => {
      if (name === "SLACK_BOT_TOKEN_WORK") {
        return "xoxb-vault-work";
      }
      if (name === "SLACK_APP_TOKEN_WORK") {
        return "xapp-vault-work";
      }
      return undefined;
    });
    const cfg = {
      channels: {
        slack: {
          accounts: {
            work: {},
          },
        },
      },
    } as OpenClawConfig;
    const res = resolveSlackAccount({ cfg, accountId: "work" });
    expect(res.botToken).toBe("xoxb-vault-work");
    expect(res.botTokenSource).toBe("vault");
    expect(res.appToken).toBe("xapp-vault-work");
    expect(res.appTokenSource).toBe("vault");
  });

  it("returns none source when no tokens from any source", () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "");
    vi.stubEnv("SLACK_APP_TOKEN", "");
    const cfg = {
      channels: { slack: {} },
    } as OpenClawConfig;
    const res = resolveSlackAccount({ cfg });
    expect(res.botToken).toBeUndefined();
    expect(res.botTokenSource).toBe("none");
    expect(res.appToken).toBeUndefined();
    expect(res.appTokenSource).toBe("none");
  });
});
