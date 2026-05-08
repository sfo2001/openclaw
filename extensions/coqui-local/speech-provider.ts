import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { assertOkOrThrowProviderError } from "openclaw/plugin-sdk/provider-http";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechProviderConfig,
  SpeechProviderPlugin,
  SpeechVoiceOption,
} from "openclaw/plugin-sdk/speech";
import {
  asFiniteNumber,
  asObject,
  requireInRange,
  trimToUndefined,
} from "openclaw/plugin-sdk/speech";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";
import {
  COQUI_LOCAL_PROVIDER_ID,
  DEFAULT_COQUI_BASE_URL,
  DEFAULT_COQUI_LANGUAGE,
  DEFAULT_COQUI_VOICE,
  isSupportedCoquiLanguage,
  normalizeCoquiBaseUrl,
} from "./shared.js";

const COQUI_LOCAL_MODELS = ["xtts_v2"] as const;

type CoquiLocalProviderConfig = {
  baseUrl: string;
  language: string;
  voice: string;
  speed: number;
  format: "wav" | "mp3";
};

const DEFAULTS: CoquiLocalProviderConfig = {
  baseUrl: DEFAULT_COQUI_BASE_URL,
  language: DEFAULT_COQUI_LANGUAGE,
  voice: DEFAULT_COQUI_VOICE,
  speed: 1.0,
  format: "wav",
};

function normalizeFormat(value: unknown): "wav" | "mp3" {
  const s = trimToUndefined(value);
  if (s === "mp3" || s === "wav") return s;
  return DEFAULTS.format;
}

function normalizeProviderConfig(rawConfig: Record<string, unknown>): CoquiLocalProviderConfig {
  const providers = asObject(rawConfig.providers);
  const raw =
    asObject(providers?.[COQUI_LOCAL_PROVIDER_ID]) ?? asObject(rawConfig[COQUI_LOCAL_PROVIDER_ID]);
  return {
    baseUrl: normalizeCoquiBaseUrl(trimToUndefined(raw?.baseUrl)),
    language: trimToUndefined(raw?.language) ?? DEFAULTS.language,
    voice: trimToUndefined(raw?.voice) ?? DEFAULTS.voice,
    speed: asFiniteNumber(raw?.speed) ?? DEFAULTS.speed,
    format: normalizeFormat(raw?.format),
  };
}

function readProviderConfig(config: SpeechProviderConfig): CoquiLocalProviderConfig {
  return {
    baseUrl: normalizeCoquiBaseUrl(trimToUndefined(config.baseUrl)),
    language: trimToUndefined(config.language) ?? DEFAULTS.language,
    voice: trimToUndefined(config.voice) ?? DEFAULTS.voice,
    speed: asFiniteNumber(config.speed) ?? DEFAULTS.speed,
    format: normalizeFormat(config.format),
  };
}

function parseDirectiveToken(ctx: SpeechDirectiveTokenParseContext) {
  try {
    switch (ctx.key) {
      case "voice":
      case "voiceid":
      case "voice_id":
        if (!ctx.policy.allowVoice) return { handled: true };
        return {
          handled: true,
          overrides: { ...ctx.currentOverrides, voice: ctx.value },
        };
      case "language":
      case "lang":
      case "languagecode":
      case "language_code": {
        if (!ctx.policy.allowNormalization) return { handled: true };
        const lang = ctx.value.toLowerCase();
        if (!isSupportedCoquiLanguage(lang)) {
          return { handled: true, warnings: [`unsupported language "${ctx.value}"`] };
        }
        return {
          handled: true,
          overrides: { ...ctx.currentOverrides, language: lang },
        };
      }
      case "speed": {
        if (!ctx.policy.allowVoiceSettings) return { handled: true };
        const value = Number.parseFloat(ctx.value);
        if (!Number.isFinite(value)) {
          return { handled: true, warnings: ["invalid speed value"] };
        }
        requireInRange(value, 0.5, 2, "speed");
        return {
          handled: true,
          overrides: { ...ctx.currentOverrides, speed: value },
        };
      }
      case "format": {
        const fmt = ctx.value.toLowerCase();
        if (fmt !== "wav" && fmt !== "mp3") {
          return { handled: true, warnings: [`unsupported format "${ctx.value}"`] };
        }
        return {
          handled: true,
          overrides: { ...ctx.currentOverrides, format: fmt },
        };
      }
      default:
        return { handled: false };
    }
  } catch (error) {
    return { handled: true, warnings: [formatErrorMessage(error)] };
  }
}

async function fetchAudio(
  baseUrl: string,
  body: Record<string, unknown>,
  timeoutMs: number | undefined,
): Promise<{ audioBuffer: ArrayBuffer; outputFormat: "wav" | "mp3" }> {
  const url = `${baseUrl}/tts`;
  const { response, release } = await fetchWithSsrFGuard({
    url,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    },
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl),
    auditContext: "coqui-local.tts",
  });
  try {
    await assertOkOrThrowProviderError(response, "coqui-local TTS error");
    const audioBuffer = await response.arrayBuffer();
    const outputFormat = body.format === "mp3" ? "mp3" : "wav";
    return { audioBuffer, outputFormat };
  } finally {
    await release();
  }
}

export async function listCoquiLocalVoices(params: {
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<SpeechVoiceOption[]> {
  const baseUrl = normalizeCoquiBaseUrl(params.baseUrl);
  const url = `${baseUrl}/voices`;
  const { response, release } = await fetchWithSsrFGuard({
    url,
    init: {
      headers: { Accept: "application/json" },
      signal: params.timeoutMs ? AbortSignal.timeout(params.timeoutMs) : undefined,
    },
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl),
    auditContext: "coqui-local.voices",
  });
  try {
    await assertOkOrThrowProviderError(response, "coqui-local voices error");
    const json = (await response.json()) as Array<{
      id?: string;
      name?: string;
      language?: string;
    }>;
    return Array.isArray(json)
      ? json
          .map((v) => ({
            id: v.id?.trim() ?? "",
            name: trimToUndefined(v.name),
            locale: trimToUndefined(v.language),
          }))
          .filter((v) => v.id.length > 0)
      : [];
  } finally {
    await release();
  }
}

export function buildCoquiLocalSpeechProvider(): SpeechProviderPlugin {
  return {
    id: COQUI_LOCAL_PROVIDER_ID,
    label: "Coqui Local",
    autoSelectOrder: 50,
    models: COQUI_LOCAL_MODELS,
    resolveConfig: ({ rawConfig }) => normalizeProviderConfig(rawConfig),
    parseDirectiveToken,
    isConfigured: ({ providerConfig }) => Boolean(readProviderConfig(providerConfig).baseUrl),
    listVoices: async (req) =>
      listCoquiLocalVoices({
        baseUrl: req.baseUrl ?? readProviderConfig(req.providerConfig ?? {}).baseUrl,
        timeoutMs: req.timeoutMs,
      }),
    synthesize: async (req) => {
      const config = readProviderConfig(req.providerConfig);
      const overrides = req.providerOverrides ?? {};
      const language = trimToUndefined(overrides.language) ?? config.language;
      const voice = trimToUndefined(overrides.voice) ?? config.voice;
      const speed = asFiniteNumber(overrides.speed) ?? config.speed;
      const format =
        (trimToUndefined(overrides.format) as "wav" | "mp3" | undefined) ?? config.format;

      const { audioBuffer, outputFormat } = await fetchAudio(
        config.baseUrl,
        { text: req.text, language, voice, speed, format },
        req.timeoutMs,
      );
      return {
        audioBuffer,
        outputFormat,
        fileExtension: outputFormat === "mp3" ? ".mp3" : ".wav",
        voiceCompatible: false,
      };
    },
  };
}
