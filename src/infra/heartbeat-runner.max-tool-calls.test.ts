import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telegramPlugin } from "../../extensions/telegram/src/channel.js";
import { setTelegramRuntime } from "../../extensions/telegram/src/runtime.js";
import { whatsappPlugin } from "../../extensions/whatsapp/src/channel.js";
import { setWhatsAppRuntime } from "../../extensions/whatsapp/src/runtime.js";
import * as replyModule from "../auto-reply/reply.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";

vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

beforeEach(() => {
  const runtime = createPluginRuntime();
  setTelegramRuntime(runtime);
  setWhatsAppRuntime(runtime);
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
      { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
    ]),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runHeartbeatOnce – maxToolCalls threading", () => {
  async function runWithMaxToolCalls(maxToolCalls?: number) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hb-maxtc-"));
    const storePath = path.join(tmpDir, "sessions.json");
    try {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "whatsapp",
              maxToolCalls,
            },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveMainSessionKey(cfg);
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "sid",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastTo: "+1555",
          },
        }),
      );
      await fs.writeFile(path.join(tmpDir, "HEARTBEAT.md"), "- Check status\n");

      const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      await runHeartbeatOnce({
        cfg,
        deps: { getQueueSize: () => 0, nowMs: () => 0 },
      });

      expect(replySpy).toHaveBeenCalledTimes(1);
      return replySpy.mock.calls[0]?.[1];
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  it("passes default maxToolCalls (50) when not configured", async () => {
    const replyOpts = await runWithMaxToolCalls(undefined);
    expect(replyOpts).toEqual(
      expect.objectContaining({
        isHeartbeat: true,
        maxToolCalls: 50,
      }),
    );
  });

  it("passes custom maxToolCalls from heartbeat config", async () => {
    const replyOpts = await runWithMaxToolCalls(100);
    expect(replyOpts).toEqual(
      expect.objectContaining({
        isHeartbeat: true,
        maxToolCalls: 100,
      }),
    );
  });

  it("disables maxToolCalls when set to 0", async () => {
    const replyOpts = await runWithMaxToolCalls(0);
    // 0 || undefined = undefined — effectively disabled
    expect(replyOpts).toEqual(
      expect.objectContaining({
        isHeartbeat: true,
      }),
    );
    expect((replyOpts as Record<string, unknown>)?.maxToolCalls).toBeUndefined();
  });
});
