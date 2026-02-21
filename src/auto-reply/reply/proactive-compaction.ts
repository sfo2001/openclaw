import fs from "node:fs";
import { lookupContextTokens } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveFreshSessionTotalTokens, type SessionEntry } from "../../config/sessions.js";

const DEFAULT_TOKEN_THRESHOLD = 0.7;

export type ProactiveCompactionSettings = {
  enabled: boolean;
  tokenThreshold: number;
  maxSessionFileBytes?: number;
  heartbeat: boolean;
};

export function resolveProactiveCompactionSettings(
  cfg?: OpenClawConfig,
): ProactiveCompactionSettings | null {
  const proactive = cfg?.agents?.defaults?.compaction?.proactive;
  if (!proactive?.enabled) {
    return null;
  }
  return {
    enabled: true,
    tokenThreshold: clampThreshold(proactive.tokenThreshold ?? DEFAULT_TOKEN_THRESHOLD),
    maxSessionFileBytes:
      typeof proactive.maxSessionFileBytes === "number" && proactive.maxSessionFileBytes > 0
        ? Math.floor(proactive.maxSessionFileBytes)
        : undefined,
    heartbeat: proactive.heartbeat ?? true,
  };
}

function clampThreshold(value: number): number {
  return Math.max(0.1, Math.min(0.9, value));
}

export function shouldRunProactiveCompaction(params: {
  entry?: Pick<SessionEntry, "totalTokens" | "totalTokensFresh">;
  sessionFile?: string;
  settings: ProactiveCompactionSettings;
  contextWindowTokens: number;
  isHeartbeat: boolean;
}): boolean {
  if (!params.settings.enabled) {
    return false;
  }
  if (params.isHeartbeat && !params.settings.heartbeat) {
    return false;
  }

  // Token-based check (primary)
  const totalTokens = resolveFreshSessionTotalTokens(params.entry);
  if (totalTokens && totalTokens > 0) {
    const contextWindow = Math.max(1, Math.floor(params.contextWindowTokens));
    const threshold = Math.floor(contextWindow * params.settings.tokenThreshold);
    if (totalTokens > threshold) {
      return true;
    }
  }

  // File-size check (secondary guard)
  if (params.settings.maxSessionFileBytes && params.sessionFile) {
    try {
      const stat = fs.statSync(params.sessionFile);
      if (stat.size > params.settings.maxSessionFileBytes) {
        return true;
      }
    } catch {
      // Session file may not exist yet — not an error.
    }
  }

  return false;
}

export function resolveProactiveCompactionContextWindowTokens(params: {
  modelId?: string;
  agentCfgContextTokens?: number;
}): number {
  return (
    lookupContextTokens(params.modelId) ?? params.agentCfgContextTokens ?? DEFAULT_CONTEXT_TOKENS
  );
}

export const __testing = {
  DEFAULT_TOKEN_THRESHOLD,
};
