import {
  compactEmbeddedPiSession,
  type EmbeddedPiCompactResult,
} from "../../agents/pi-embedded.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  type SessionEntry,
  updateSessionStoreEntry,
} from "../../config/sessions.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  resolveProactiveCompactionContextWindowTokens,
  resolveProactiveCompactionSettings,
  shouldRunProactiveCompaction,
} from "./proactive-compaction.js";
import type { FollowupRun } from "./queue.js";
import { incrementCompactionCount } from "./session-updates.js";

const log = createSubsystemLogger("proactive-compaction");

export async function runProactiveCompactionIfNeeded(params: {
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
  defaultModel: string;
  agentCfgContextTokens?: number;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  isHeartbeat: boolean;
}): Promise<SessionEntry | undefined> {
  const settings = resolveProactiveCompactionSettings(params.cfg);
  if (!settings) {
    return params.sessionEntry;
  }

  const entry =
    params.sessionEntry ??
    (params.sessionKey ? params.sessionStore?.[params.sessionKey] : undefined);

  const modelId = params.followupRun.run.model ?? params.defaultModel;
  const contextWindowTokens = resolveProactiveCompactionContextWindowTokens({
    modelId,
    agentCfgContextTokens: params.agentCfgContextTokens,
  });

  const sessionFile = entry?.sessionId
    ? resolveSessionFilePath(
        entry.sessionId,
        entry,
        resolveSessionFilePathOptions({
          agentId: params.followupRun.run.agentId,
          storePath: params.storePath,
        }),
      )
    : undefined;

  if (
    !shouldRunProactiveCompaction({
      entry,
      sessionFile,
      settings,
      contextWindowTokens,
      isHeartbeat: params.isHeartbeat,
    })
  ) {
    return params.sessionEntry;
  }

  if (!entry?.sessionId || !sessionFile) {
    return params.sessionEntry;
  }

  log.info(
    `proactive compaction triggered: session=${params.sessionKey ?? entry.sessionId} ` +
      `tokens=${entry.totalTokens ?? "?"} threshold=${Math.floor(contextWindowTokens * settings.tokenThreshold)}`,
  );

  let activeSessionEntry = params.sessionEntry;
  let compactionResult: EmbeddedPiCompactResult | undefined;
  try {
    compactionResult = await compactEmbeddedPiSession({
      sessionId: entry.sessionId,
      sessionKey: params.sessionKey,
      sessionFile,
      workspaceDir: params.followupRun.run.workspaceDir,
      agentDir: params.followupRun.run.agentDir,
      config: params.cfg,
      skillsSnapshot: params.followupRun.run.skillsSnapshot,
      provider: params.followupRun.run.provider,
      model: modelId,
      thinkLevel: params.followupRun.run.thinkLevel,
      bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
      trigger: "manual",
      ownerNumbers: params.followupRun.run.ownerNumbers,
      senderIsOwner: params.followupRun.run.senderIsOwner,
    });

    if (compactionResult.ok && compactionResult.compacted) {
      const count = await incrementCompactionCount({
        sessionEntry: activeSessionEntry,
        sessionStore: params.sessionStore,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
        tokensAfter: compactionResult.result?.tokensAfter,
      });
      log.info(
        `proactive compaction completed: session=${params.sessionKey ?? entry.sessionId} ` +
          `before=${compactionResult.result?.tokensBefore ?? "?"} ` +
          `after=${compactionResult.result?.tokensAfter ?? "?"} ` +
          `count=${count ?? "?"}`,
      );

      // Refresh session entry after compaction
      if (params.storePath && params.sessionKey) {
        try {
          const updatedEntry = await updateSessionStoreEntry({
            storePath: params.storePath,
            sessionKey: params.sessionKey,
            update: async () => ({
              updatedAt: Date.now(),
            }),
          });
          if (updatedEntry) {
            activeSessionEntry = updatedEntry;
          }
        } catch (err) {
          log.warn(`failed to persist proactive compaction metadata: ${String(err)}`);
        }
      }
    } else if (!compactionResult.ok) {
      log.warn(
        `proactive compaction failed: session=${params.sessionKey ?? entry.sessionId} ` +
          `reason=${compactionResult.reason ?? "unknown"}`,
      );
    }
  } catch (err) {
    log.warn(`proactive compaction run failed: ${String(err)}`);
  }

  return activeSessionEntry;
}
