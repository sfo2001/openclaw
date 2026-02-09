import {
  createAccountListHelpers,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeChatType,
  resolveAccountEntry,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-resolution";
import { getVaultChannelToken } from "openclaw/plugin-sdk/vault";
import type { SlackAccountSurfaceFields } from "./account-surface-fields.js";
import type { SlackAccountConfig } from "./runtime-api.js";
import { resolveSlackAppToken, resolveSlackBotToken, resolveSlackUserToken } from "./token.js";

export type SlackTokenSource = "vault" | "env" | "config" | "none";

export type ResolvedSlackAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  botToken?: string;
  appToken?: string;
  userToken?: string;
  botTokenSource: SlackTokenSource;
  appTokenSource: SlackTokenSource;
  userTokenSource: SlackTokenSource;
  config: SlackAccountConfig;
} & SlackAccountSurfaceFields;

const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("slack");
export const listSlackAccountIds = listAccountIds;
export const resolveDefaultSlackAccountId = resolveDefaultAccountId;

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): SlackAccountConfig | undefined {
  return resolveAccountEntry(cfg.channels?.slack?.accounts, accountId);
}

export function mergeSlackAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): SlackAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.slack ?? {}) as SlackAccountConfig & {
    accounts?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

export function resolveSlackAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedSlackAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.slack?.enabled !== false;
  const merged = mergeSlackAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;

  // Vault token resolution (highest priority when vault is enabled).
  const vaultBotSuffix = accountId === DEFAULT_ACCOUNT_ID ? "" : `_${accountId.toUpperCase()}`;
  const vaultBot = getVaultChannelToken(`SLACK_BOT_TOKEN${vaultBotSuffix}`) ?? undefined;
  const vaultApp = getVaultChannelToken(`SLACK_APP_TOKEN${vaultBotSuffix}`) ?? undefined;

  const envBot = allowEnv ? resolveSlackBotToken(process.env.SLACK_BOT_TOKEN) : undefined;
  const envApp = allowEnv ? resolveSlackAppToken(process.env.SLACK_APP_TOKEN) : undefined;
  const envUser = allowEnv ? resolveSlackUserToken(process.env.SLACK_USER_TOKEN) : undefined;
  const configBot = resolveSlackBotToken(
    merged.botToken,
    `channels.slack.accounts.${accountId}.botToken`,
  );
  const configApp = resolveSlackAppToken(
    merged.appToken,
    `channels.slack.accounts.${accountId}.appToken`,
  );
  const configUser = resolveSlackUserToken(
    merged.userToken,
    `channels.slack.accounts.${accountId}.userToken`,
  );
  const botToken = vaultBot ?? configBot ?? envBot;
  const appToken = vaultApp ?? configApp ?? envApp;
  const userToken = configUser ?? envUser;
  const botTokenSource: SlackTokenSource = vaultBot
    ? "vault"
    : configBot
      ? "config"
      : envBot
        ? "env"
        : "none";
  const appTokenSource: SlackTokenSource = vaultApp
    ? "vault"
    : configApp
      ? "config"
      : envApp
        ? "env"
        : "none";
  const userTokenSource: SlackTokenSource = configUser ? "config" : envUser ? "env" : "none";

  return {
    accountId,
    enabled,
    name: merged.name?.trim() || undefined,
    botToken,
    appToken,
    userToken,
    botTokenSource,
    appTokenSource,
    userTokenSource,
    config: merged,
    groupPolicy: merged.groupPolicy,
    textChunkLimit: merged.textChunkLimit,
    mediaMaxMb: merged.mediaMaxMb,
    reactionNotifications: merged.reactionNotifications,
    reactionAllowlist: merged.reactionAllowlist,
    replyToMode: merged.replyToMode,
    replyToModeByChatType: merged.replyToModeByChatType,
    actions: merged.actions,
    slashCommand: merged.slashCommand,
    dm: merged.dm,
    channels: merged.channels,
  };
}

export function listEnabledSlackAccounts(cfg: OpenClawConfig): ResolvedSlackAccount[] {
  return listSlackAccountIds(cfg)
    .map((accountId) => resolveSlackAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}

export function resolveSlackReplyToMode(
  account: ResolvedSlackAccount,
  chatType?: string | null,
): "off" | "first" | "all" {
  const normalized = normalizeChatType(chatType ?? undefined);
  if (normalized && account.replyToModeByChatType?.[normalized] !== undefined) {
    return account.replyToModeByChatType[normalized] ?? "off";
  }
  if (normalized === "direct" && account.dm?.replyToMode !== undefined) {
    return account.dm.replyToMode;
  }
  return account.replyToMode ?? "off";
}
