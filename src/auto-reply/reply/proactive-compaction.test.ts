import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  __testing,
  resolveProactiveCompactionContextWindowTokens,
  resolveProactiveCompactionSettings,
  shouldRunProactiveCompaction,
} from "./proactive-compaction.js";

vi.mock("../../agents/context.js", () => ({
  lookupContextTokens: (modelId?: string) => {
    const known: Record<string, number> = {
      "claude-opus-4-6": 200_000,
      "claude-haiku-4-5-20251001": 200_000,
      "gpt-4o": 128_000,
    };
    return modelId ? known[modelId] : undefined;
  },
}));

const { DEFAULT_TOKEN_THRESHOLD } = __testing;

describe("resolveProactiveCompactionSettings", () => {
  it("returns null when proactive compaction is not configured", () => {
    expect(resolveProactiveCompactionSettings(undefined)).toBeNull();
    expect(resolveProactiveCompactionSettings({})).toBeNull();
    expect(
      resolveProactiveCompactionSettings({
        agents: { defaults: { compaction: {} } },
      } as OpenClawConfig),
    ).toBeNull();
  });

  it("returns null when proactive compaction is disabled", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          compaction: {
            proactive: { enabled: false },
          },
        },
      },
    };
    expect(resolveProactiveCompactionSettings(cfg)).toBeNull();
  });

  it("returns settings with defaults when enabled", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          compaction: {
            proactive: { enabled: true },
          },
        },
      },
    };
    const settings = resolveProactiveCompactionSettings(cfg);
    expect(settings).toEqual({
      enabled: true,
      tokenThreshold: DEFAULT_TOKEN_THRESHOLD,
      maxSessionFileBytes: undefined,
      heartbeat: true,
    });
  });

  it("respects custom tokenThreshold", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          compaction: {
            proactive: { enabled: true, tokenThreshold: 0.5 },
          },
        },
      },
    };
    const settings = resolveProactiveCompactionSettings(cfg);
    expect(settings?.tokenThreshold).toBe(0.5);
  });

  it("clamps tokenThreshold to valid range", () => {
    const make = (threshold: number) =>
      resolveProactiveCompactionSettings({
        agents: {
          defaults: {
            compaction: {
              proactive: { enabled: true, tokenThreshold: threshold },
            },
          },
        },
      } as OpenClawConfig);

    expect(make(0.05)?.tokenThreshold).toBe(0.1);
    expect(make(0.95)?.tokenThreshold).toBe(0.9);
    expect(make(0.5)?.tokenThreshold).toBe(0.5);
  });

  it("accepts tokenThreshold at exact boundaries (0.1 and 0.9)", () => {
    const make = (threshold: number) =>
      resolveProactiveCompactionSettings({
        agents: {
          defaults: {
            compaction: {
              proactive: { enabled: true, tokenThreshold: threshold },
            },
          },
        },
      } as OpenClawConfig);

    expect(make(0.1)?.tokenThreshold).toBe(0.1);
    expect(make(0.9)?.tokenThreshold).toBe(0.9);
  });

  it("respects maxSessionFileBytes", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          compaction: {
            proactive: { enabled: true, maxSessionFileBytes: 1024 * 1024 },
          },
        },
      },
    };
    const settings = resolveProactiveCompactionSettings(cfg);
    expect(settings?.maxSessionFileBytes).toBe(1024 * 1024);
  });

  it("treats maxSessionFileBytes zero and negative as disabled", () => {
    const make = (bytes: number) =>
      resolveProactiveCompactionSettings({
        agents: {
          defaults: {
            compaction: {
              proactive: { enabled: true, maxSessionFileBytes: bytes },
            },
          },
        },
      } as OpenClawConfig);

    expect(make(0)?.maxSessionFileBytes).toBeUndefined();
    expect(make(-1)?.maxSessionFileBytes).toBeUndefined();
    expect(make(-100)?.maxSessionFileBytes).toBeUndefined();
  });

  it("floors non-integer maxSessionFileBytes", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          compaction: {
            proactive: { enabled: true, maxSessionFileBytes: 1024.9 },
          },
        },
      },
    };
    const settings = resolveProactiveCompactionSettings(cfg);
    expect(settings?.maxSessionFileBytes).toBe(1024);
  });

  it("respects heartbeat=false", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          compaction: {
            proactive: { enabled: true, heartbeat: false },
          },
        },
      },
    };
    const settings = resolveProactiveCompactionSettings(cfg);
    expect(settings?.heartbeat).toBe(false);
  });
});

describe("shouldRunProactiveCompaction", () => {
  const enabledSettings = {
    enabled: true,
    tokenThreshold: 0.7,
    heartbeat: true,
    maxSessionFileBytes: undefined,
  };

  it("returns false when disabled", () => {
    expect(
      shouldRunProactiveCompaction({
        entry: { totalTokens: 100_000, totalTokensFresh: true } as SessionEntry,
        settings: { ...enabledSettings, enabled: false },
        contextWindowTokens: 128_000,
        isHeartbeat: false,
      }),
    ).toBe(false);
  });

  it("returns false for heartbeat when heartbeat is disabled", () => {
    expect(
      shouldRunProactiveCompaction({
        entry: { totalTokens: 100_000, totalTokensFresh: true } as SessionEntry,
        settings: { ...enabledSettings, heartbeat: false },
        contextWindowTokens: 128_000,
        isHeartbeat: true,
      }),
    ).toBe(false);
  });

  it("returns true when heartbeat is enabled and tokens exceed threshold", () => {
    expect(
      shouldRunProactiveCompaction({
        entry: { totalTokens: 100_000, totalTokensFresh: true } as SessionEntry,
        settings: enabledSettings,
        contextWindowTokens: 128_000,
        isHeartbeat: true,
      }),
    ).toBe(true);
  });

  it("returns true when tokens exceed threshold", () => {
    // 128_000 * 0.7 = 89_600; 100_000 > 89_600 = true
    expect(
      shouldRunProactiveCompaction({
        entry: { totalTokens: 100_000, totalTokensFresh: true } as SessionEntry,
        settings: enabledSettings,
        contextWindowTokens: 128_000,
        isHeartbeat: false,
      }),
    ).toBe(true);
  });

  it("returns false when tokens below threshold", () => {
    // 128_000 * 0.7 = 89_600; 50_000 <= 89_600 = false
    expect(
      shouldRunProactiveCompaction({
        entry: { totalTokens: 50_000, totalTokensFresh: true } as SessionEntry,
        settings: enabledSettings,
        contextWindowTokens: 128_000,
        isHeartbeat: false,
      }),
    ).toBe(false);
  });

  it("returns false when totalTokens is stale", () => {
    expect(
      shouldRunProactiveCompaction({
        entry: { totalTokens: 100_000, totalTokensFresh: false } as SessionEntry,
        settings: enabledSettings,
        contextWindowTokens: 128_000,
        isHeartbeat: false,
      }),
    ).toBe(false);
  });

  it("returns false when no entry is provided", () => {
    expect(
      shouldRunProactiveCompaction({
        entry: undefined,
        settings: enabledSettings,
        contextWindowTokens: 128_000,
        isHeartbeat: false,
      }),
    ).toBe(false);
  });

  it("returns false when totalTokens is zero", () => {
    expect(
      shouldRunProactiveCompaction({
        entry: { totalTokens: 0, totalTokensFresh: true } as SessionEntry,
        settings: enabledSettings,
        contextWindowTokens: 128_000,
        isHeartbeat: false,
      }),
    ).toBe(false);
  });

  it("does not crash when contextWindowTokens is zero", () => {
    // contextWindowTokens floors to 1 internally, so threshold = floor(1 * 0.7) = 0
    // 100_000 > 0 = true
    expect(
      shouldRunProactiveCompaction({
        entry: { totalTokens: 100_000, totalTokensFresh: true } as SessionEntry,
        settings: enabledSettings,
        contextWindowTokens: 0,
        isHeartbeat: false,
      }),
    ).toBe(true);
  });

  it("does not crash when contextWindowTokens is negative", () => {
    // Negative floors to 1, threshold = floor(1 * 0.7) = 0
    expect(
      shouldRunProactiveCompaction({
        entry: { totalTokens: 1, totalTokensFresh: true } as SessionEntry,
        settings: enabledSettings,
        contextWindowTokens: -100,
        isHeartbeat: false,
      }),
    ).toBe(true);
  });

  it("handles edge case: threshold at exactly the boundary", () => {
    // 100_000 * 0.7 = 70_000; 70_000 is NOT > 70_000
    expect(
      shouldRunProactiveCompaction({
        entry: { totalTokens: 70_000, totalTokensFresh: true } as SessionEntry,
        settings: enabledSettings,
        contextWindowTokens: 100_000,
        isHeartbeat: false,
      }),
    ).toBe(false);

    // 70_001 > 70_000
    expect(
      shouldRunProactiveCompaction({
        entry: { totalTokens: 70_001, totalTokensFresh: true } as SessionEntry,
        settings: enabledSettings,
        contextWindowTokens: 100_000,
        isHeartbeat: false,
      }),
    ).toBe(true);
  });

  describe("file-size secondary guard", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const settingsWithFileLimit = {
      ...enabledSettings,
      maxSessionFileBytes: 10_000,
    };

    it("returns true when file exceeds maxSessionFileBytes", () => {
      vi.spyOn(fs, "statSync").mockReturnValue({ size: 20_000 } as fs.Stats);
      expect(
        shouldRunProactiveCompaction({
          entry: { totalTokens: 1_000, totalTokensFresh: true } as SessionEntry,
          sessionFile: "/tmp/test-session.json",
          settings: settingsWithFileLimit,
          contextWindowTokens: 128_000,
          isHeartbeat: false,
        }),
      ).toBe(true);
    });

    it("returns false when file is below maxSessionFileBytes", () => {
      vi.spyOn(fs, "statSync").mockReturnValue({ size: 5_000 } as fs.Stats);
      expect(
        shouldRunProactiveCompaction({
          entry: { totalTokens: 1_000, totalTokensFresh: true } as SessionEntry,
          sessionFile: "/tmp/test-session.json",
          settings: settingsWithFileLimit,
          contextWindowTokens: 128_000,
          isHeartbeat: false,
        }),
      ).toBe(false);
    });

    it("returns false when session file does not exist", () => {
      vi.spyOn(fs, "statSync").mockImplementation(() => {
        throw new Error("ENOENT: no such file or directory");
      });
      expect(
        shouldRunProactiveCompaction({
          entry: { totalTokens: 1_000, totalTokensFresh: true } as SessionEntry,
          sessionFile: "/tmp/nonexistent-session.json",
          settings: settingsWithFileLimit,
          contextWindowTokens: 128_000,
          isHeartbeat: false,
        }),
      ).toBe(false);
    });

    it("skips file check when sessionFile is undefined", () => {
      const spy = vi.spyOn(fs, "statSync");
      shouldRunProactiveCompaction({
        entry: { totalTokens: 1_000, totalTokensFresh: true } as SessionEntry,
        sessionFile: undefined,
        settings: settingsWithFileLimit,
        contextWindowTokens: 128_000,
        isHeartbeat: false,
      });
      expect(spy).not.toHaveBeenCalled();
    });

    it("skips file check when maxSessionFileBytes is not set", () => {
      const spy = vi.spyOn(fs, "statSync");
      shouldRunProactiveCompaction({
        entry: { totalTokens: 1_000, totalTokensFresh: true } as SessionEntry,
        sessionFile: "/tmp/test-session.json",
        settings: enabledSettings,
        contextWindowTokens: 128_000,
        isHeartbeat: false,
      });
      expect(spy).not.toHaveBeenCalled();
    });

    it("token check takes priority over file-size check", () => {
      // Tokens exceed threshold — should return true before file check
      const spy = vi.spyOn(fs, "statSync");
      expect(
        shouldRunProactiveCompaction({
          entry: { totalTokens: 100_000, totalTokensFresh: true } as SessionEntry,
          sessionFile: "/tmp/test-session.json",
          settings: settingsWithFileLimit,
          contextWindowTokens: 128_000,
          isHeartbeat: false,
        }),
      ).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    });
  });
});

describe("resolveProactiveCompactionContextWindowTokens", () => {
  it("returns context tokens for a known model", () => {
    expect(resolveProactiveCompactionContextWindowTokens({ modelId: "gpt-4o" })).toBe(128_000);
  });

  it("falls back to agentCfgContextTokens for an unknown model", () => {
    expect(
      resolveProactiveCompactionContextWindowTokens({
        modelId: "unknown-model",
        agentCfgContextTokens: 64_000,
      }),
    ).toBe(64_000);
  });

  it("falls back to DEFAULT_CONTEXT_TOKENS when both are unavailable", () => {
    expect(
      resolveProactiveCompactionContextWindowTokens({
        modelId: "unknown-model",
      }),
    ).toBe(DEFAULT_CONTEXT_TOKENS);
  });

  it("falls back to DEFAULT_CONTEXT_TOKENS when modelId is undefined", () => {
    expect(
      resolveProactiveCompactionContextWindowTokens({
        modelId: undefined,
      }),
    ).toBe(DEFAULT_CONTEXT_TOKENS);
  });

  it("prefers model lookup over agentCfgContextTokens", () => {
    expect(
      resolveProactiveCompactionContextWindowTokens({
        modelId: "gpt-4o",
        agentCfgContextTokens: 64_000,
      }),
    ).toBe(128_000);
  });
});
