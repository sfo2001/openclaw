import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import { __testing, resetToolCallCounter } from "./pi-tools.before-tool-call.js";
import { resolveToolLoopDetectionConfig } from "./pi-tools.js";

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => null,
}));

const { runBeforeToolCallHook, toolCallCountsBySession } = __testing;

describe("hard tool-call cap (maxToolCalls)", () => {
  const SESSION_A = "session-a";
  const SESSION_B = "session-b";
  const MAX = 3;

  beforeEach(() => {
    toolCallCountsBySession.clear();
  });

  it("increments counter per session key and blocks at limit", async () => {
    const ctx = { sessionKey: SESSION_A, maxToolCalls: MAX };

    for (let i = 0; i < MAX; i++) {
      const result = await runBeforeToolCallHook({
        toolName: "exec",
        params: {},
        ctx,
      });
      expect(result.blocked).toBe(false);
    }
    expect(toolCallCountsBySession.get(SESSION_A)).toBe(MAX);

    // Next call should be blocked
    const blocked = await runBeforeToolCallHook({
      toolName: "exec",
      params: {},
      ctx,
    });
    expect(blocked.blocked).toBe(true);
    expect(blocked.blocked && blocked.reason).toContain("Tool call limit exceeded");
  });

  it("fires onMaxToolCallsReached callback when limit exceeded", async () => {
    const onReached = vi.fn();
    const ctx = { sessionKey: SESSION_A, maxToolCalls: 1, onMaxToolCallsReached: onReached };

    // First call: allowed
    await runBeforeToolCallHook({ toolName: "exec", params: {}, ctx });
    expect(onReached).not.toHaveBeenCalled();

    // Second call: blocked, callback fires
    await runBeforeToolCallHook({ toolName: "exec", params: {}, ctx });
    expect(onReached).toHaveBeenCalledTimes(1);

    // Third call: still blocked, callback fires again
    await runBeforeToolCallHook({ toolName: "exec", params: {}, ctx });
    expect(onReached).toHaveBeenCalledTimes(2);
  });

  it("resetToolCallCounter clears state for session", async () => {
    const ctx = { sessionKey: SESSION_A, maxToolCalls: 2 };
    await runBeforeToolCallHook({ toolName: "exec", params: {}, ctx });
    await runBeforeToolCallHook({ toolName: "exec", params: {}, ctx });
    expect(toolCallCountsBySession.get(SESSION_A)).toBe(2);

    resetToolCallCounter(SESSION_A);
    expect(toolCallCountsBySession.has(SESSION_A)).toBe(false);

    // Counter restarts — should be allowed again
    const result = await runBeforeToolCallHook({ toolName: "exec", params: {}, ctx });
    expect(result.blocked).toBe(false);
    expect(toolCallCountsBySession.get(SESSION_A)).toBe(1);
  });

  it("different session keys have independent counters", async () => {
    const ctxA = { sessionKey: SESSION_A, maxToolCalls: 2 };
    const ctxB = { sessionKey: SESSION_B, maxToolCalls: 2 };

    await runBeforeToolCallHook({ toolName: "exec", params: {}, ctx: ctxA });
    await runBeforeToolCallHook({ toolName: "exec", params: {}, ctx: ctxA });
    // A is at limit
    const blockedA = await runBeforeToolCallHook({ toolName: "exec", params: {}, ctx: ctxA });
    expect(blockedA.blocked).toBe(true);

    // B should still be allowed
    const allowedB = await runBeforeToolCallHook({ toolName: "exec", params: {}, ctx: ctxB });
    expect(allowedB.blocked).toBe(false);
  });

  it("no cap when maxToolCalls is undefined", async () => {
    const ctx = { sessionKey: SESSION_A };

    for (let i = 0; i < 100; i++) {
      const result = await runBeforeToolCallHook({ toolName: "exec", params: {}, ctx });
      expect(result.blocked).toBe(false);
    }
    // Counter should not be populated when maxToolCalls is absent
    expect(toolCallCountsBySession.has(SESSION_A)).toBe(false);
  });

  it("no cap when sessionKey is undefined", async () => {
    const ctx = { maxToolCalls: 1 };
    const r1 = await runBeforeToolCallHook({ toolName: "exec", params: {}, ctx });
    const r2 = await runBeforeToolCallHook({ toolName: "exec", params: {}, ctx });
    expect(r1.blocked).toBe(false);
    expect(r2.blocked).toBe(false);
  });
});

// Mirrors the force-enable logic at src/agents/pi-tools.ts:497-500.
// When a hard tool-call cap is set, loop detection is forced enabled so the model
// gets softer pattern-based warnings before the hard cap fires.
describe("maxToolCalls force-enables loop detection", () => {
  function applyForceEnable(
    maxToolCalls: number | undefined,
    resolved: ToolLoopDetectionConfig | undefined,
  ): ToolLoopDetectionConfig | undefined {
    // Exact logic from createOpenClawCodingTools (pi-tools.ts:499-500)
    if (maxToolCalls && resolved && !resolved.enabled) {
      resolved.enabled = true;
    }
    return resolved;
  }

  it("forces enabled when loop detection exists but is disabled", () => {
    const cfg = { tools: { loopDetection: { enabled: false, warningThreshold: 5 } } };
    const resolved = resolveToolLoopDetectionConfig({ cfg });
    expect(resolved?.enabled).toBe(false);

    applyForceEnable(50, resolved);
    expect(resolved?.enabled).toBe(true);
  });

  it("leaves enabled true when already enabled", () => {
    const cfg = { tools: { loopDetection: { enabled: true } } };
    const resolved = resolveToolLoopDetectionConfig({ cfg });
    applyForceEnable(50, resolved);
    expect(resolved?.enabled).toBe(true);
  });

  it("does not crash when loop detection config is undefined", () => {
    const resolved = resolveToolLoopDetectionConfig({ cfg: {} });
    expect(resolved).toBeUndefined();
    // Should not throw
    applyForceEnable(50, resolved);
  });

  it("skips force-enable when maxToolCalls is undefined", () => {
    const cfg = { tools: { loopDetection: { enabled: false } } };
    const resolved = resolveToolLoopDetectionConfig({ cfg });
    applyForceEnable(undefined, resolved);
    expect(resolved?.enabled).toBe(false);
  });
});

// Tests the deferred abort ref pattern from attempt.ts:293-789.
// Tools are created before abortRun is defined; the ref bridges the temporal gap.
describe("deferred maxToolCallsAbortRef pattern", () => {
  it("fires abort via deferred ref when cap is exceeded", async () => {
    toolCallCountsBySession.clear();
    const abortSpy = vi.fn();

    // Simulate the pattern from attempt.ts: ref starts empty, wired later.
    const maxToolCallsAbortRef: { current?: () => void } = {};
    const onMaxToolCallsReached = () => maxToolCallsAbortRef.current?.();

    const ctx = {
      sessionKey: "deferred-test",
      maxToolCalls: 1,
      onMaxToolCallsReached,
    };

    // First call: allowed (ref still empty, but cap not hit)
    await runBeforeToolCallHook({ toolName: "exec", params: {}, ctx });

    // Wire the ref (simulates attempt.ts:789)
    maxToolCallsAbortRef.current = () => abortSpy(new Error("max tool calls exceeded"));

    // Second call: cap exceeded → onMaxToolCallsReached → ref.current → abortSpy
    await runBeforeToolCallHook({ toolName: "exec", params: {}, ctx });
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(abortSpy.mock.calls[0]?.[0]?.message).toBe("max tool calls exceeded");
  });

  it("does not throw when ref is not yet wired", async () => {
    toolCallCountsBySession.clear();
    const maxToolCallsAbortRef: { current?: () => void } = {};
    const onMaxToolCallsReached = () => maxToolCallsAbortRef.current?.();

    const ctx = {
      sessionKey: "unwired-test",
      maxToolCalls: 1,
      onMaxToolCallsReached,
    };

    await runBeforeToolCallHook({ toolName: "exec", params: {}, ctx });
    // Cap exceeded but ref not wired — should not throw
    await expect(runBeforeToolCallHook({ toolName: "exec", params: {}, ctx })).resolves.toEqual(
      expect.objectContaining({ blocked: true }),
    );
  });
});
