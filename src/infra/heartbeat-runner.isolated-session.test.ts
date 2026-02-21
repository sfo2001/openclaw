import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telegramPlugin } from "../../extensions/telegram/src/channel.js";
import { setTelegramRuntime } from "../../extensions/telegram/src/runtime.js";
import * as replyModule from "../auto-reply/reply.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { seedSessionStore } from "./heartbeat-runner.test-utils.js";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "./system-events.js";

// Avoid pulling optional runtime deps during isolated runs.
vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

let fixtureRoot = "";
let fixtureCount = 0;

beforeEach(() => {
  const runtime = createPluginRuntime();
  setTelegramRuntime(runtime);
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
  );
  resetSystemEventsForTest();
});

afterAll(async () => {
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

afterEach(() => {
  resetSystemEventsForTest();
  vi.restoreAllMocks();
});

const createCaseDir = async (prefix: string) => {
  if (!fixtureRoot) {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hb-isolated-"));
  }
  const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "HEARTBEAT.md"), "- Check status\n", "utf-8");
  return dir;
};

function createConfig(
  tmpDir: string,
  storePath: string,
  heartbeatOverrides?: Record<string, unknown>,
): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: tmpDir,
        heartbeat: {
          every: "5m",
          target: "telegram",
          ...heartbeatOverrides,
        },
      },
    },
    channels: { telegram: { allowFrom: ["*"] } },
    session: { store: storePath },
  };
}

async function seedMainSession(
  storePath: string,
  cfg: OpenClawConfig,
  overrides?: Record<string, unknown>,
) {
  const sessionKey = resolveMainSessionKey(cfg);
  await seedSessionStore(storePath, sessionKey, {
    lastChannel: "telegram",
    lastProvider: "telegram",
    lastTo: "155462274",
    ...overrides,
  });
  return sessionKey;
}

describe("heartbeat session isolation (default behavior)", () => {
  it("default config (no session field): getReplyFromConfig receives isolated session key", async () => {
    const tmpDir = await createCaseDir("isolated-default");
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      const cfg = createConfig(tmpDir, storePath);
      const mainSessionKey = await seedMainSession(storePath, cfg);

      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "155462274" });

      await runHeartbeatOnce({ cfg, deps: { sendTelegram } });

      expect(replySpy).toHaveBeenCalledTimes(1);
      const calledCtx = replySpy.mock.calls[0]?.[0] as { SessionKey?: string };
      // Session key should be the isolated heartbeat key, not the main session key
      expect(calledCtx.SessionKey).toContain("heartbeat");
      expect(calledCtx.SessionKey).not.toBe(mainSessionKey);
    } finally {
      replySpy.mockRestore();
    }
  });

  it('session: "main" uses the main session key (backward compat)', async () => {
    const tmpDir = await createCaseDir("isolated-main-opt-in");
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      const cfg = createConfig(tmpDir, storePath, { session: "main" });
      const mainSessionKey = await seedMainSession(storePath, cfg);

      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "155462274" });

      await runHeartbeatOnce({ cfg, deps: { sendTelegram } });

      expect(replySpy).toHaveBeenCalledTimes(1);
      const calledCtx = replySpy.mock.calls[0]?.[0] as { SessionKey?: string };
      expect(calledCtx.SessionKey).toBe(mainSessionKey);
    } finally {
      replySpy.mockRestore();
    }
  });

  it('session: "shared" produces a custom session key (not main)', async () => {
    const tmpDir = await createCaseDir("isolated-shared-custom");
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      const cfg = createConfig(tmpDir, storePath, { session: "shared" });
      const mainSessionKey = await seedMainSession(storePath, cfg);

      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "155462274" });

      await runHeartbeatOnce({ cfg, deps: { sendTelegram } });

      expect(replySpy).toHaveBeenCalledTimes(1);
      const calledCtx = replySpy.mock.calls[0]?.[0] as { SessionKey?: string };
      // "shared" is treated as a custom session name, not a main-session alias
      expect(calledCtx.SessionKey).not.toBe(mainSessionKey);
      expect(calledCtx.SessionKey).toContain("shared");
    } finally {
      replySpy.mockRestore();
    }
  });

  it("system events peeked from main session even in isolated mode", async () => {
    const tmpDir = await createCaseDir("isolated-event-peek");
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      const cfg = createConfig(tmpDir, storePath);
      const mainSessionKey = await seedMainSession(storePath, cfg);

      // Enqueue a cron event on the main session (as cron jobs do)
      enqueueSystemEvent("Cron: Daily backup completed", {
        sessionKey: mainSessionKey,
        contextKey: "cron:daily-backup",
      });

      replySpy.mockResolvedValue({ text: "Backup status relayed" });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "155462274" });

      const result = await runHeartbeatOnce({
        cfg,
        reason: "cron:daily-backup",
        deps: { sendTelegram },
      });

      expect(result.status).toBe("ran");
      // The heartbeat should have seen and processed the cron event
      expect(replySpy).toHaveBeenCalledTimes(1);
      const calledCtx = replySpy.mock.calls[0]?.[0] as { Provider?: string; Body?: string };
      expect(calledCtx.Provider).toBe("cron-event");
      expect(calledCtx.Body).toContain("Daily backup completed");
    } finally {
      replySpy.mockRestore();
    }
  });

  it("system events drained from main queue after isolated turn", async () => {
    const tmpDir = await createCaseDir("isolated-event-drain");
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      const cfg = createConfig(tmpDir, storePath);
      const mainSessionKey = await seedMainSession(storePath, cfg);

      enqueueSystemEvent("Cron: Cleanup done", {
        sessionKey: mainSessionKey,
        contextKey: "cron:cleanup",
      });

      replySpy.mockResolvedValue({ text: "Cleanup relayed" });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "155462274" });

      await runHeartbeatOnce({
        cfg,
        reason: "cron:cleanup",
        deps: { sendTelegram },
      });

      // After the isolated turn, the main session's event queue should be drained
      const remainingEvents = peekSystemEventEntries(mainSessionKey);
      // The only remaining event should be the alert injection, not the original cron event
      const cronEvents = remainingEvents.filter((e) => e.contextKey === "cron:cleanup");
      expect(cronEvents).toHaveLength(0);
    } finally {
      replySpy.mockRestore();
    }
  });

  it("alert text injected as system event into main session", async () => {
    const tmpDir = await createCaseDir("isolated-alert-injection");
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      const cfg = createConfig(tmpDir, storePath);
      const mainSessionKey = await seedMainSession(storePath, cfg);

      replySpy.mockResolvedValue({ text: "Alert: Server disk usage at 90%" });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "155462274" });

      await runHeartbeatOnce({ cfg, deps: { sendTelegram } });

      // An alert should be injected as a system event into the main session
      const events = peekSystemEventEntries(mainSessionKey);
      const heartbeatAlerts = events.filter((e) => e.contextKey === "heartbeat:alert");
      expect(heartbeatAlerts).toHaveLength(1);
      expect(heartbeatAlerts[0]?.text).toContain("Server disk usage at 90%");
      expect(heartbeatAlerts[0]?.text).toMatch(/^\[heartbeat\] /);
    } finally {
      replySpy.mockRestore();
    }
  });

  it("HEARTBEAT_OK does not inject alert into main session", async () => {
    const tmpDir = await createCaseDir("isolated-no-ok-injection");
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      const cfg = createConfig(tmpDir, storePath);
      const mainSessionKey = await seedMainSession(storePath, cfg);

      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "155462274" });

      await runHeartbeatOnce({ cfg, deps: { sendTelegram } });

      // No alert injection for HEARTBEAT_OK (shouldSkip=true path)
      const events = peekSystemEventEntries(mainSessionKey);
      const heartbeatAlerts = events.filter((e) => e.contextKey === "heartbeat:alert");
      expect(heartbeatAlerts).toHaveLength(0);
    } finally {
      replySpy.mockRestore();
    }
  });

  it("main session updatedAt not bumped on HEARTBEAT_OK in isolated mode", async () => {
    const tmpDir = await createCaseDir("isolated-no-updatedat-bump");
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      const originalUpdatedAt = 1000;
      const cfg = createConfig(tmpDir, storePath);
      const mainSessionKey = await seedMainSession(storePath, cfg, {
        updatedAt: originalUpdatedAt,
      });

      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "155462274" });

      await runHeartbeatOnce({ cfg, deps: { sendTelegram } });

      // Main session's updatedAt should be restored (not bumped by heartbeat)
      const finalStore = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
        string,
        { updatedAt?: number } | undefined
      >;
      expect(finalStore[mainSessionKey]?.updatedAt).toBe(originalUpdatedAt);
    } finally {
      replySpy.mockRestore();
    }
  });

  it("forced session key overrides isolation", async () => {
    const tmpDir = await createCaseDir("isolated-forced-override");
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      const cfg = createConfig(tmpDir, storePath);
      const mainSessionKey = await seedMainSession(storePath, cfg);

      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "155462274" });

      // Pass an explicit session key -- this should override isolation
      await runHeartbeatOnce({ cfg, sessionKey: mainSessionKey, deps: { sendTelegram } });

      expect(replySpy).toHaveBeenCalledTimes(1);
      const calledCtx = replySpy.mock.calls[0]?.[0] as { SessionKey?: string };
      expect(calledCtx.SessionKey).toBe(mainSessionKey);
    } finally {
      replySpy.mockRestore();
    }
  });
});
