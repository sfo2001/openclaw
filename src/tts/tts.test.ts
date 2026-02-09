import { completeSimple } from "@mariozechner/pi-ai";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { getApiKeyForModel } from "../agents/model-auth.js";
import { resolveModel } from "../agents/pi-embedded-runner/model.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

import { spawn as mockedSpawn } from "node:child_process";
import * as tts from "./tts.js";

const spawnMock = mockedSpawn as unknown as vi.Mock;

vi.mock("@mariozechner/pi-ai", () => ({
  completeSimple: vi.fn(),
  // Some auth helpers import oauth provider metadata at module load time.
  getOAuthProviders: () => [],
  getOAuthApiKey: vi.fn(async () => null),
}));

vi.mock("../agents/pi-embedded-runner/model.js", () => ({
  resolveModel: vi.fn((provider: string, modelId: string) => ({
    model: {
      provider,
      id: modelId,
      name: modelId,
      api: "openai-completions",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    },
    authStorage: { profiles: {} },
    modelRegistry: { find: vi.fn() },
  })),
}));

vi.mock("../agents/model-auth.js", () => ({
  getApiKeyForModel: vi.fn(async () => ({
    apiKey: "test-api-key",
    source: "test",
    mode: "api-key",
  })),
  requireApiKey: vi.fn((auth: { apiKey?: string }) => auth.apiKey ?? ""),
}));

const {
  _test,
  resolveTtsConfig,
  maybeApplyTtsToPayload,
  getTtsProvider,
  TTS_PROVIDERS,
  isTtsProviderConfigured,
  resolveTtsProviderOrder,
} = tts;

const {
  isValidVoiceId,
  isValidOpenAIVoice,
  isValidOpenAIModel,
  OPENAI_TTS_MODELS,
  OPENAI_TTS_VOICES,
  parseTtsDirectives,
  resolveModelOverridePolicy,
  summarizeText,
  resolveOutputFormat,
  resolveEdgeOutputFormat,
  PIPER_DEFAULTS,
  MAX_AUDIO_BUFFER_BYTES,
  MAX_STDERR_BYTES,
  piperTTS,
  convertPcmToFormat,
} = _test;

type MockChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: vi.Mock; end: vi.Mock };
  kill: vi.Mock;
};

function createMockChild(): MockChild {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as MockChild;
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.kill = vi.fn();
  return child;
}

const PIPER_CONFIG = {
  binaryPath: "piper",
  modelPath: "/models/en-us.onnx",
  sampleRate: 22050,
  lengthScale: 1.0,
  sentenceSilence: 0.2,
  useCuda: false,
  speaker: 0,
};

describe("tts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnMock.mockReset();
    vi.mocked(completeSimple).mockResolvedValue({
      content: [{ type: "text", text: "Summary" }],
    });
  });

  describe("isValidVoiceId", () => {
    it("accepts valid ElevenLabs voice IDs", () => {
      expect(isValidVoiceId("pMsXgVXv3BLzUgSXRplE")).toBe(true);
      expect(isValidVoiceId("21m00Tcm4TlvDq8ikWAM")).toBe(true);
      expect(isValidVoiceId("EXAVITQu4vr4xnSDxMaL")).toBe(true);
    });

    it("accepts voice IDs of varying valid lengths", () => {
      expect(isValidVoiceId("a1b2c3d4e5")).toBe(true);
      expect(isValidVoiceId("a".repeat(40))).toBe(true);
    });

    it("rejects too short voice IDs", () => {
      expect(isValidVoiceId("")).toBe(false);
      expect(isValidVoiceId("abc")).toBe(false);
      expect(isValidVoiceId("123456789")).toBe(false);
    });

    it("rejects too long voice IDs", () => {
      expect(isValidVoiceId("a".repeat(41))).toBe(false);
      expect(isValidVoiceId("a".repeat(100))).toBe(false);
    });

    it("rejects voice IDs with invalid characters", () => {
      expect(isValidVoiceId("pMsXgVXv3BLz-gSXRplE")).toBe(false);
      expect(isValidVoiceId("pMsXgVXv3BLz_gSXRplE")).toBe(false);
      expect(isValidVoiceId("pMsXgVXv3BLz gSXRplE")).toBe(false);
      expect(isValidVoiceId("../../../etc/passwd")).toBe(false);
      expect(isValidVoiceId("voice?param=value")).toBe(false);
    });
  });

  describe("isValidOpenAIVoice", () => {
    it("accepts all valid OpenAI voices", () => {
      for (const voice of OPENAI_TTS_VOICES) {
        expect(isValidOpenAIVoice(voice)).toBe(true);
      }
    });

    it("includes newer OpenAI voices (ballad, cedar, juniper, marin, verse) (#2393)", () => {
      expect(isValidOpenAIVoice("ballad")).toBe(true);
      expect(isValidOpenAIVoice("cedar")).toBe(true);
      expect(isValidOpenAIVoice("juniper")).toBe(true);
      expect(isValidOpenAIVoice("marin")).toBe(true);
      expect(isValidOpenAIVoice("verse")).toBe(true);
    });

    it("rejects invalid voice names", () => {
      expect(isValidOpenAIVoice("invalid")).toBe(false);
      expect(isValidOpenAIVoice("")).toBe(false);
      expect(isValidOpenAIVoice("ALLOY")).toBe(false);
      expect(isValidOpenAIVoice("alloy ")).toBe(false);
      expect(isValidOpenAIVoice(" alloy")).toBe(false);
    });
  });

  describe("isValidOpenAIModel", () => {
    it("accepts supported models", () => {
      expect(isValidOpenAIModel("gpt-4o-mini-tts")).toBe(true);
      expect(isValidOpenAIModel("tts-1")).toBe(true);
      expect(isValidOpenAIModel("tts-1-hd")).toBe(true);
    });

    it("rejects unsupported models", () => {
      expect(isValidOpenAIModel("invalid")).toBe(false);
      expect(isValidOpenAIModel("")).toBe(false);
      expect(isValidOpenAIModel("gpt-4")).toBe(false);
    });
  });

  describe("OPENAI_TTS_MODELS", () => {
    it("contains supported models", () => {
      expect(OPENAI_TTS_MODELS).toContain("gpt-4o-mini-tts");
      expect(OPENAI_TTS_MODELS).toContain("tts-1");
      expect(OPENAI_TTS_MODELS).toContain("tts-1-hd");
      expect(OPENAI_TTS_MODELS).toHaveLength(3);
    });

    it("is a non-empty array", () => {
      expect(Array.isArray(OPENAI_TTS_MODELS)).toBe(true);
      expect(OPENAI_TTS_MODELS.length).toBeGreaterThan(0);
    });
  });

  describe("resolveOutputFormat", () => {
    it("uses Opus for Telegram", () => {
      const output = resolveOutputFormat("telegram");
      expect(output.openai).toBe("opus");
      expect(output.elevenlabs).toBe("opus_48000_64");
      expect(output.extension).toBe(".opus");
      expect(output.voiceCompatible).toBe(true);
    });

    it("uses MP3 for other channels", () => {
      const output = resolveOutputFormat("discord");
      expect(output.openai).toBe("mp3");
      expect(output.elevenlabs).toBe("mp3_44100_128");
      expect(output.extension).toBe(".mp3");
      expect(output.voiceCompatible).toBe(false);
    });
  });

  describe("resolveEdgeOutputFormat", () => {
    const baseCfg = {
      agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
      messages: { tts: {} },
    };

    it("uses default output format when edge output format is not configured", () => {
      const config = resolveTtsConfig(baseCfg);
      expect(resolveEdgeOutputFormat(config)).toBe("audio-24khz-48kbitrate-mono-mp3");
    });

    it("uses configured output format when provided", () => {
      const config = resolveTtsConfig({
        ...baseCfg,
        messages: {
          tts: {
            edge: { outputFormat: "audio-24khz-96kbitrate-mono-mp3" },
          },
        },
      });
      expect(resolveEdgeOutputFormat(config)).toBe("audio-24khz-96kbitrate-mono-mp3");
    });
  });

  describe("parseTtsDirectives", () => {
    it("extracts overrides and strips directives when enabled", () => {
      const policy = resolveModelOverridePolicy({ enabled: true });
      const input =
        "Hello [[tts:provider=elevenlabs voiceId=pMsXgVXv3BLzUgSXRplE stability=0.4 speed=1.1]] world\n\n" +
        "[[tts:text]](laughs) Read the song once more.[[/tts:text]]";
      const result = parseTtsDirectives(input, policy);

      expect(result.cleanedText).not.toContain("[[tts:");
      expect(result.ttsText).toBe("(laughs) Read the song once more.");
      expect(result.overrides.provider).toBe("elevenlabs");
      expect(result.overrides.elevenlabs?.voiceId).toBe("pMsXgVXv3BLzUgSXRplE");
      expect(result.overrides.elevenlabs?.voiceSettings?.stability).toBe(0.4);
      expect(result.overrides.elevenlabs?.voiceSettings?.speed).toBe(1.1);
    });

    it("accepts edge as provider override", () => {
      const policy = resolveModelOverridePolicy({ enabled: true });
      const input = "Hello [[tts:provider=edge]] world";
      const result = parseTtsDirectives(input, policy);

      expect(result.overrides.provider).toBe("edge");
    });

    it("keeps text intact when overrides are disabled", () => {
      const policy = resolveModelOverridePolicy({ enabled: false });
      const input = "Hello [[tts:voice=alloy]] world";
      const result = parseTtsDirectives(input, policy);

      expect(result.cleanedText).toBe(input);
      expect(result.overrides.provider).toBeUndefined();
    });
  });

  describe("summarizeText", () => {
    const baseCfg = {
      agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
      messages: { tts: {} },
    };
    const baseConfig = resolveTtsConfig(baseCfg);

    it("summarizes text and returns result with metrics", async () => {
      const mockSummary = "This is a summarized version of the text.";
      vi.mocked(completeSimple).mockResolvedValue({
        content: [{ type: "text", text: mockSummary }],
      });

      const longText = "A".repeat(2000);
      const result = await summarizeText({
        text: longText,
        targetLength: 1500,
        cfg: baseCfg,
        config: baseConfig,
        timeoutMs: 30_000,
      });

      expect(result.summary).toBe(mockSummary);
      expect(result.inputLength).toBe(2000);
      expect(result.outputLength).toBe(mockSummary.length);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(completeSimple).toHaveBeenCalledTimes(1);
    });

    it("calls the summary model with the expected parameters", async () => {
      await summarizeText({
        text: "Long text to summarize",
        targetLength: 500,
        cfg: baseCfg,
        config: baseConfig,
        timeoutMs: 30_000,
      });

      const callArgs = vi.mocked(completeSimple).mock.calls[0];
      expect(callArgs?.[1]?.messages?.[0]?.role).toBe("user");
      expect(callArgs?.[2]?.maxTokens).toBe(250);
      expect(callArgs?.[2]?.temperature).toBe(0.3);
      expect(getApiKeyForModel).toHaveBeenCalledTimes(1);
    });

    it("uses summaryModel override when configured", async () => {
      const cfg = {
        agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
        messages: { tts: { summaryModel: "openai/gpt-4.1-mini" } },
      };
      const config = resolveTtsConfig(cfg);
      await summarizeText({
        text: "Long text to summarize",
        targetLength: 500,
        cfg,
        config,
        timeoutMs: 30_000,
      });

      expect(resolveModel).toHaveBeenCalledWith("openai", "gpt-4.1-mini", undefined, cfg);
    });

    it("rejects targetLength below minimum (100)", async () => {
      await expect(
        summarizeText({
          text: "text",
          targetLength: 99,
          cfg: baseCfg,
          config: baseConfig,
          timeoutMs: 30_000,
        }),
      ).rejects.toThrow("Invalid targetLength: 99");
    });

    it("rejects targetLength above maximum (10000)", async () => {
      await expect(
        summarizeText({
          text: "text",
          targetLength: 10001,
          cfg: baseCfg,
          config: baseConfig,
          timeoutMs: 30_000,
        }),
      ).rejects.toThrow("Invalid targetLength: 10001");
    });

    it("accepts targetLength at boundaries", async () => {
      await expect(
        summarizeText({
          text: "text",
          targetLength: 100,
          cfg: baseCfg,
          config: baseConfig,
          timeoutMs: 30_000,
        }),
      ).resolves.toBeDefined();
      await expect(
        summarizeText({
          text: "text",
          targetLength: 10000,
          cfg: baseCfg,
          config: baseConfig,
          timeoutMs: 30_000,
        }),
      ).resolves.toBeDefined();
    });

    it("throws error when no summary is returned", async () => {
      vi.mocked(completeSimple).mockResolvedValue({
        content: [],
      });

      await expect(
        summarizeText({
          text: "text",
          targetLength: 500,
          cfg: baseCfg,
          config: baseConfig,
          timeoutMs: 30_000,
        }),
      ).rejects.toThrow("No summary returned");
    });

    it("throws error when summary content is empty", async () => {
      vi.mocked(completeSimple).mockResolvedValue({
        content: [{ type: "text", text: "   " }],
      });

      await expect(
        summarizeText({
          text: "text",
          targetLength: 500,
          cfg: baseCfg,
          config: baseConfig,
          timeoutMs: 30_000,
        }),
      ).rejects.toThrow("No summary returned");
    });
  });

  describe("getTtsProvider", () => {
    const baseCfg = {
      agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
      messages: { tts: {} },
    };

    const restoreEnv = (snapshot: Record<string, string | undefined>) => {
      const keys = ["OPENAI_API_KEY", "ELEVENLABS_API_KEY", "XI_API_KEY"] as const;
      for (const key of keys) {
        const value = snapshot[key];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    };

    const withEnv = (env: Record<string, string | undefined>, run: () => void) => {
      const snapshot = {
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
        XI_API_KEY: process.env.XI_API_KEY,
      };
      try {
        for (const [key, value] of Object.entries(env)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
        run();
      } finally {
        restoreEnv(snapshot);
      }
    };

    it("prefers OpenAI when no provider is configured and API key exists", () => {
      withEnv(
        {
          OPENAI_API_KEY: "test-openai-key",
          ELEVENLABS_API_KEY: undefined,
          XI_API_KEY: undefined,
        },
        () => {
          const config = resolveTtsConfig(baseCfg);
          const provider = getTtsProvider(config, "/tmp/tts-prefs-openai.json");
          expect(provider).toBe("openai");
        },
      );
    });

    it("prefers ElevenLabs when OpenAI is missing and ElevenLabs key exists", () => {
      withEnv(
        {
          OPENAI_API_KEY: undefined,
          ELEVENLABS_API_KEY: "test-elevenlabs-key",
          XI_API_KEY: undefined,
        },
        () => {
          const config = resolveTtsConfig(baseCfg);
          const provider = getTtsProvider(config, "/tmp/tts-prefs-elevenlabs.json");
          expect(provider).toBe("elevenlabs");
        },
      );
    });

    it("falls back to Edge when no API keys are present", () => {
      withEnv(
        {
          OPENAI_API_KEY: undefined,
          ELEVENLABS_API_KEY: undefined,
          XI_API_KEY: undefined,
        },
        () => {
          const config = resolveTtsConfig(baseCfg);
          const provider = getTtsProvider(config, "/tmp/tts-prefs-edge.json");
          expect(provider).toBe("edge");
        },
      );
    });
  });

  describe("TTS_PROVIDERS", () => {
    it("includes piper", () => {
      expect(TTS_PROVIDERS).toContain("piper");
      expect(TTS_PROVIDERS).toHaveLength(4);
    });

    it("includes all expected providers", () => {
      expect(TTS_PROVIDERS).toContain("openai");
      expect(TTS_PROVIDERS).toContain("elevenlabs");
      expect(TTS_PROVIDERS).toContain("edge");
      expect(TTS_PROVIDERS).toContain("piper");
    });
  });

  describe("PIPER_DEFAULTS", () => {
    it("has expected default values", () => {
      expect(PIPER_DEFAULTS.binaryPath).toBe("piper");
      expect(PIPER_DEFAULTS.sampleRate).toBe(22050);
      expect(PIPER_DEFAULTS.lengthScale).toBe(1.0);
      expect(PIPER_DEFAULTS.sentenceSilence).toBe(0.2);
      expect(PIPER_DEFAULTS.speaker).toBe(0);
    });
  });

  describe("resolveTtsConfig — piper defaults", () => {
    const baseCfg = {
      agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
      messages: { tts: {} },
    };

    it("applies default piper values when no piper config is provided", () => {
      const config = resolveTtsConfig(baseCfg);
      expect(config.piper.binaryPath).toBe(PIPER_DEFAULTS.binaryPath);
      expect(config.piper.sampleRate).toBe(PIPER_DEFAULTS.sampleRate);
      expect(config.piper.lengthScale).toBe(PIPER_DEFAULTS.lengthScale);
      expect(config.piper.sentenceSilence).toBe(PIPER_DEFAULTS.sentenceSilence);
      expect(config.piper.speaker).toBe(PIPER_DEFAULTS.speaker);
      expect(config.piper.useCuda).toBe(false);
      expect(config.piper.modelPath).toBeUndefined();
      expect(config.piper.configPath).toBeUndefined();
    });

    it("uses configured piper values over defaults", () => {
      const cfg = {
        ...baseCfg,
        messages: {
          tts: {
            piper: {
              binaryPath: "/opt/piper/piper",
              modelPath: "/models/de-de.onnx",
              configPath: "/models/de-de.json",
              sampleRate: 16000,
              lengthScale: 1.5,
              sentenceSilence: 0.5,
              useCuda: true,
              speaker: 3,
            },
          },
        },
      };
      const config = resolveTtsConfig(cfg);
      expect(config.piper.binaryPath).toBe("/opt/piper/piper");
      expect(config.piper.modelPath).toBe("/models/de-de.onnx");
      expect(config.piper.configPath).toBe("/models/de-de.json");
      expect(config.piper.sampleRate).toBe(16000);
      expect(config.piper.lengthScale).toBe(1.5);
      expect(config.piper.sentenceSilence).toBe(0.5);
      expect(config.piper.useCuda).toBe(true);
      expect(config.piper.speaker).toBe(3);
    });

    it("trims whitespace from string piper fields", () => {
      const cfg = {
        ...baseCfg,
        messages: {
          tts: {
            piper: {
              binaryPath: "  /usr/bin/piper  ",
              modelPath: "  ",
              configPath: "   ",
            },
          },
        },
      };
      const config = resolveTtsConfig(cfg);
      expect(config.piper.binaryPath).toBe("/usr/bin/piper");
      expect(config.piper.modelPath).toBeUndefined();
      expect(config.piper.configPath).toBeUndefined();
    });

    it("falls back to default binaryPath when empty string provided", () => {
      const cfg = {
        ...baseCfg,
        messages: { tts: { piper: { binaryPath: "" } } },
      };
      const config = resolveTtsConfig(cfg);
      expect(config.piper.binaryPath).toBe("piper");
    });
  });

  describe("getTtsProvider — piper auto-detection", () => {
    const baseCfg = {
      agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
      messages: { tts: {} },
    };

    const restoreEnv = (snapshot: Record<string, string | undefined>) => {
      const keys = ["OPENAI_API_KEY", "ELEVENLABS_API_KEY", "XI_API_KEY"] as const;
      for (const key of keys) {
        const value = snapshot[key];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    };

    const withEnv = (env: Record<string, string | undefined>, run: () => void) => {
      const snapshot = {
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
        XI_API_KEY: process.env.XI_API_KEY,
      };
      try {
        for (const [key, value] of Object.entries(env)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
        run();
      } finally {
        restoreEnv(snapshot);
      }
    };

    it("selects piper when modelPath is set and no API keys are present", () => {
      withEnv(
        {
          OPENAI_API_KEY: undefined,
          ELEVENLABS_API_KEY: undefined,
          XI_API_KEY: undefined,
        },
        () => {
          const cfg = {
            ...baseCfg,
            messages: { tts: { piper: { modelPath: "/models/en-us.onnx" } } },
          };
          const config = resolveTtsConfig(cfg);
          const provider = getTtsProvider(config, `/tmp/tts-prefs-piper-${Date.now()}.json`);
          expect(provider).toBe("piper");
        },
      );
    });

    it("prefers OpenAI over piper when OpenAI key exists", () => {
      withEnv(
        {
          OPENAI_API_KEY: "test-openai-key",
          ELEVENLABS_API_KEY: undefined,
          XI_API_KEY: undefined,
        },
        () => {
          const cfg = {
            ...baseCfg,
            messages: { tts: { piper: { modelPath: "/models/en-us.onnx" } } },
          };
          const config = resolveTtsConfig(cfg);
          const provider = getTtsProvider(config, `/tmp/tts-prefs-piper-${Date.now()}.json`);
          expect(provider).toBe("openai");
        },
      );
    });

    it("does not select piper when modelPath is not set", () => {
      withEnv(
        {
          OPENAI_API_KEY: undefined,
          ELEVENLABS_API_KEY: undefined,
          XI_API_KEY: undefined,
        },
        () => {
          const config = resolveTtsConfig(baseCfg);
          const provider = getTtsProvider(config, `/tmp/tts-prefs-piper-${Date.now()}.json`);
          expect(provider).toBe("edge");
        },
      );
    });
  });

  describe("isTtsProviderConfigured — piper", () => {
    const baseCfg = {
      agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
      messages: { tts: {} },
    };

    it("returns true when modelPath is set", () => {
      const cfg = {
        ...baseCfg,
        messages: { tts: { piper: { modelPath: "/models/en-us.onnx" } } },
      };
      const config = resolveTtsConfig(cfg);
      expect(isTtsProviderConfigured(config, "piper")).toBe(true);
    });

    it("returns false when modelPath is not set", () => {
      const config = resolveTtsConfig(baseCfg);
      expect(isTtsProviderConfigured(config, "piper")).toBe(false);
    });

    it("returns false when modelPath is whitespace-only", () => {
      const cfg = {
        ...baseCfg,
        messages: { tts: { piper: { modelPath: "  " } } },
      };
      const config = resolveTtsConfig(cfg);
      expect(isTtsProviderConfigured(config, "piper")).toBe(false);
    });
  });

  describe("resolveTtsProviderOrder — piper", () => {
    it("puts piper first when it is the primary", () => {
      const order = resolveTtsProviderOrder("piper");
      expect(order[0]).toBe("piper");
      expect(order).toHaveLength(4);
      expect(order).toContain("openai");
      expect(order).toContain("elevenlabs");
      expect(order).toContain("edge");
    });

    it("includes piper in non-primary position", () => {
      const order = resolveTtsProviderOrder("openai");
      expect(order[0]).toBe("openai");
      expect(order).toContain("piper");
    });
  });

  describe("parseTtsDirectives — piper provider", () => {
    it("accepts piper as provider directive", () => {
      const policy = resolveModelOverridePolicy({ enabled: true });
      const input = "Hello [[tts:provider=piper]] world";
      const result = parseTtsDirectives(input, policy);
      expect(result.overrides.provider).toBe("piper");
      expect(result.hasDirective).toBe(true);
    });

    it("rejects unknown provider in directive", () => {
      const policy = resolveModelOverridePolicy({ enabled: true });
      const input = "Hello [[tts:provider=unknown]] world";
      const result = parseTtsDirectives(input, policy);
      expect(result.overrides.provider).toBeUndefined();
      expect(result.warnings).toContain('unsupported provider "unknown"');
    });
  });

  describe("maybeApplyTtsToPayload", () => {
    const baseCfg = {
      agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
      messages: {
        tts: {
          auto: "inbound",
          provider: "openai",
          openai: { apiKey: "test-key", model: "gpt-4o-mini-tts", voice: "alloy" },
        },
      },
    };

    it("skips auto-TTS when inbound audio gating is on and the message is not audio", async () => {
      const prevPrefs = process.env.OPENCLAW_TTS_PREFS;
      process.env.OPENCLAW_TTS_PREFS = `/tmp/tts-test-${Date.now()}.json`;
      const originalFetch = globalThis.fetch;
      const fetchMock = vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(1),
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const payload = { text: "Hello world" };
      const result = await maybeApplyTtsToPayload({
        payload,
        cfg: baseCfg,
        kind: "final",
        inboundAudio: false,
      });

      expect(result).toBe(payload);
      expect(fetchMock).not.toHaveBeenCalled();

      globalThis.fetch = originalFetch;
      process.env.OPENCLAW_TTS_PREFS = prevPrefs;
    });

    it("skips auto-TTS when markdown stripping leaves text too short", async () => {
      const prevPrefs = process.env.OPENCLAW_TTS_PREFS;
      process.env.OPENCLAW_TTS_PREFS = `/tmp/tts-test-${Date.now()}.json`;
      const originalFetch = globalThis.fetch;
      const fetchMock = vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(1),
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const payload = { text: "### **bold**" };
      const result = await maybeApplyTtsToPayload({
        payload,
        cfg: baseCfg,
        kind: "final",
        inboundAudio: true,
      });

      expect(result).toBe(payload);
      expect(fetchMock).not.toHaveBeenCalled();

      globalThis.fetch = originalFetch;
      process.env.OPENCLAW_TTS_PREFS = prevPrefs;
    });

    it("attempts auto-TTS when inbound audio gating is on and the message is audio", async () => {
      const prevPrefs = process.env.OPENCLAW_TTS_PREFS;
      process.env.OPENCLAW_TTS_PREFS = `/tmp/tts-test-${Date.now()}.json`;
      const originalFetch = globalThis.fetch;
      const fetchMock = vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(1),
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await maybeApplyTtsToPayload({
        payload: { text: "Hello world" },
        cfg: baseCfg,
        kind: "final",
        inboundAudio: true,
      });

      expect(result.mediaUrl).toBeDefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      globalThis.fetch = originalFetch;
      process.env.OPENCLAW_TTS_PREFS = prevPrefs;
    });

    it("skips auto-TTS in tagged mode unless a tts tag is present", async () => {
      const prevPrefs = process.env.OPENCLAW_TTS_PREFS;
      process.env.OPENCLAW_TTS_PREFS = `/tmp/tts-test-${Date.now()}.json`;
      const originalFetch = globalThis.fetch;
      const fetchMock = vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(1),
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const cfg = {
        ...baseCfg,
        messages: {
          ...baseCfg.messages,
          tts: { ...baseCfg.messages.tts, auto: "tagged" },
        },
      };

      const payload = { text: "Hello world" };
      const result = await maybeApplyTtsToPayload({
        payload,
        cfg,
        kind: "final",
      });

      expect(result).toBe(payload);
      expect(fetchMock).not.toHaveBeenCalled();

      globalThis.fetch = originalFetch;
      process.env.OPENCLAW_TTS_PREFS = prevPrefs;
    });

    it("runs auto-TTS in tagged mode when tags are present", async () => {
      const prevPrefs = process.env.OPENCLAW_TTS_PREFS;
      process.env.OPENCLAW_TTS_PREFS = `/tmp/tts-test-${Date.now()}.json`;
      const originalFetch = globalThis.fetch;
      const fetchMock = vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(1),
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const cfg = {
        ...baseCfg,
        messages: {
          ...baseCfg.messages,
          tts: { ...baseCfg.messages.tts, auto: "tagged" },
        },
      };

      const result = await maybeApplyTtsToPayload({
        payload: { text: "[[tts:text]]Hello world[[/tts:text]]" },
        cfg,
        kind: "final",
      });

      expect(result.mediaUrl).toBeDefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      globalThis.fetch = originalFetch;
      process.env.OPENCLAW_TTS_PREFS = prevPrefs;
    });
  });

  describe("convertPcmToFormat", () => {
    it("converts PCM to wav via ffmpeg", async () => {
      const ffmpegChild = createMockChild();
      spawnMock.mockReturnValueOnce(ffmpegChild);

      const pcm = Buffer.from("fake-pcm-data");
      const promise = convertPcmToFormat(pcm, 22050, "wav", 10000);

      // Verify ffmpeg was spawned with correct args
      expect(spawnMock).toHaveBeenCalledWith("ffmpeg", [
        "-f",
        "s16le",
        "-ar",
        "22050",
        "-ac",
        "1",
        "-i",
        "pipe:0",
        "-f",
        "wav",
        "pipe:1",
      ]);

      // Simulate ffmpeg writing output and closing
      const wavOutput = Buffer.from("RIFF-fake-wav-data");
      ffmpegChild.stdout.emit("data", wavOutput);
      ffmpegChild.emit("close", 0);

      const result = await promise;
      expect(result).toEqual(wavOutput);
    });

    it("passes correct args for mp3 format", async () => {
      const ffmpegChild = createMockChild();
      spawnMock.mockReturnValueOnce(ffmpegChild);

      const promise = convertPcmToFormat(Buffer.alloc(10), 44100, "mp3", 10000);

      expect(spawnMock).toHaveBeenCalledWith("ffmpeg", [
        "-f",
        "s16le",
        "-ar",
        "44100",
        "-ac",
        "1",
        "-i",
        "pipe:0",
        "-f",
        "mp3",
        "-b:a",
        "128k",
        "pipe:1",
      ]);

      ffmpegChild.stdout.emit("data", Buffer.from("mp3-data"));
      ffmpegChild.emit("close", 0);
      await promise;
    });

    it("passes correct args for opus format", async () => {
      const ffmpegChild = createMockChild();
      spawnMock.mockReturnValueOnce(ffmpegChild);

      const promise = convertPcmToFormat(Buffer.alloc(10), 48000, "opus", 10000);

      expect(spawnMock).toHaveBeenCalledWith("ffmpeg", [
        "-f",
        "s16le",
        "-ar",
        "48000",
        "-ac",
        "1",
        "-i",
        "pipe:0",
        "-f",
        "ogg",
        "-c:a",
        "libopus",
        "-b:a",
        "64k",
        "pipe:1",
      ]);

      ffmpegChild.stdout.emit("data", Buffer.from("opus-data"));
      ffmpegChild.emit("close", 0);
      await promise;
    });

    it("rejects when ffmpeg is not found (ENOENT)", async () => {
      const ffmpegChild = createMockChild();
      spawnMock.mockReturnValueOnce(ffmpegChild);

      const promise = convertPcmToFormat(Buffer.alloc(10), 22050, "wav", 10000);

      const err = new Error("spawn ffmpeg ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      ffmpegChild.emit("error", err);

      await expect(promise).rejects.toThrow("ffmpeg not found");
    });

    it("rejects on non-ENOENT spawn error", async () => {
      const ffmpegChild = createMockChild();
      spawnMock.mockReturnValueOnce(ffmpegChild);

      const promise = convertPcmToFormat(Buffer.alloc(10), 22050, "wav", 10000);
      ffmpegChild.emit("error", new Error("EPERM"));

      await expect(promise).rejects.toThrow("Failed to run ffmpeg: EPERM");
    });

    it("rejects on non-zero exit code without leaking stderr", async () => {
      const ffmpegChild = createMockChild();
      spawnMock.mockReturnValueOnce(ffmpegChild);

      const promise = convertPcmToFormat(Buffer.alloc(10), 22050, "wav", 10000);

      ffmpegChild.stderr.emit("data", Buffer.from("some internal error details"));
      ffmpegChild.emit("close", 1);

      await expect(promise).rejects.toThrow("ffmpeg exited with code 1");
      // Verify stderr is NOT in the error message (F3 fix)
      try {
        await promise;
      } catch (e) {
        expect((e as Error).message).not.toContain("some internal error");
      }
    });

    it("rejects when output exceeds MAX_AUDIO_BUFFER_BYTES", async () => {
      const ffmpegChild = createMockChild();
      spawnMock.mockReturnValueOnce(ffmpegChild);

      const promise = convertPcmToFormat(Buffer.alloc(10), 22050, "wav", 10000);

      // Send a chunk larger than the limit
      const hugeChunk = Buffer.alloc(MAX_AUDIO_BUFFER_BYTES + 1);
      ffmpegChild.stdout.emit("data", hugeChunk);

      await expect(promise).rejects.toThrow("ffmpeg output exceeded maximum buffer size");
      expect(ffmpegChild.kill).toHaveBeenCalled();
    });

    it("rejects on timeout", async () => {
      vi.useFakeTimers();
      const ffmpegChild = createMockChild();
      spawnMock.mockReturnValueOnce(ffmpegChild);

      const promise = convertPcmToFormat(Buffer.alloc(10), 22050, "wav", 5000);

      vi.advanceTimersByTime(5001);

      await expect(promise).rejects.toThrow("ffmpeg audio conversion timed out");
      expect(ffmpegChild.kill).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("caps stderr accumulation at MAX_STDERR_BYTES", async () => {
      const ffmpegChild = createMockChild();
      spawnMock.mockReturnValueOnce(ffmpegChild);

      const promise = convertPcmToFormat(Buffer.alloc(10), 22050, "wav", 10000);

      // Send stderr larger than the cap
      const bigStderr = Buffer.alloc(MAX_STDERR_BYTES + 1000, 65); // 'A'
      ffmpegChild.stderr.emit("data", bigStderr);
      ffmpegChild.emit("close", 1);

      // It should reject but not crash from unbounded allocation
      await expect(promise).rejects.toThrow("ffmpeg exited with code 1");
    });

    it("writes PCM data to ffmpeg stdin", async () => {
      const ffmpegChild = createMockChild();
      spawnMock.mockReturnValueOnce(ffmpegChild);

      const pcm = Buffer.from("test-pcm");
      const promise = convertPcmToFormat(pcm, 22050, "wav", 10000);

      expect(ffmpegChild.stdin.write).toHaveBeenCalledWith(pcm);
      expect(ffmpegChild.stdin.end).toHaveBeenCalled();

      ffmpegChild.stdout.emit("data", Buffer.from("wav"));
      ffmpegChild.emit("close", 0);
      await promise;
    });
  });

  describe("piperTTS", () => {
    it("rejects when modelPath is not configured", async () => {
      const config = { ...PIPER_CONFIG, modelPath: undefined };
      await expect(
        piperTTS({ text: "hello", config, outputFormat: "wav", timeoutMs: 10000 }),
      ).rejects.toThrow("Piper TTS requires modelPath to be configured");
    });

    it("spawns piper with correct args and converts output", async () => {
      const piperChild = createMockChild();
      const ffmpegChild = createMockChild();
      spawnMock.mockReturnValueOnce(piperChild).mockReturnValueOnce(ffmpegChild);

      const promise = piperTTS({
        text: "hello world",
        config: PIPER_CONFIG,
        outputFormat: "mp3",
        timeoutMs: 30000,
      });

      // Verify piper spawn args
      expect(spawnMock).toHaveBeenCalledWith("piper", [
        "--model",
        "/models/en-us.onnx",
        "--output-raw",
        "--length-scale",
        "1",
        "--sentence-silence",
        "0.2",
      ]);

      // Verify text was sanitized and written to stdin
      expect(piperChild.stdin.write).toHaveBeenCalledWith("hello world");
      expect(piperChild.stdin.end).toHaveBeenCalled();

      // Simulate piper producing PCM output
      piperChild.stdout.emit("data", Buffer.alloc(100, 0x42));
      piperChild.emit("close", 0);

      // Now ffmpeg should be spawned for conversion
      ffmpegChild.stdout.emit("data", Buffer.from("converted-mp3"));
      ffmpegChild.emit("close", 0);

      const result = await promise;
      expect(result).toEqual(Buffer.from("converted-mp3"));
    });

    it("includes configPath arg when configured", async () => {
      const piperChild = createMockChild();
      const ffmpegChild = createMockChild();
      spawnMock.mockReturnValueOnce(piperChild).mockReturnValueOnce(ffmpegChild);

      const config = { ...PIPER_CONFIG, configPath: "/models/en-us.json" };
      const promise = piperTTS({
        text: "test",
        config,
        outputFormat: "wav",
        timeoutMs: 10000,
      });

      const piperArgs = spawnMock.mock.calls[0][1] as string[];
      expect(piperArgs).toContain("--config");
      expect(piperArgs).toContain("/models/en-us.json");

      piperChild.stdout.emit("data", Buffer.alloc(10));
      piperChild.emit("close", 0);
      ffmpegChild.stdout.emit("data", Buffer.from("wav-data"));
      ffmpegChild.emit("close", 0);
      await promise;
    });

    it("includes speaker arg when non-zero", async () => {
      const piperChild = createMockChild();
      const ffmpegChild = createMockChild();
      spawnMock.mockReturnValueOnce(piperChild).mockReturnValueOnce(ffmpegChild);

      const config = { ...PIPER_CONFIG, speaker: 5 };
      const promise = piperTTS({
        text: "test",
        config,
        outputFormat: "wav",
        timeoutMs: 10000,
      });

      const piperArgs = spawnMock.mock.calls[0][1] as string[];
      expect(piperArgs).toContain("--speaker");
      expect(piperArgs).toContain("5");

      piperChild.stdout.emit("data", Buffer.alloc(10));
      piperChild.emit("close", 0);
      ffmpegChild.stdout.emit("data", Buffer.from("wav-data"));
      ffmpegChild.emit("close", 0);
      await promise;
    });

    it("includes --cuda flag when useCuda is true", async () => {
      const piperChild = createMockChild();
      const ffmpegChild = createMockChild();
      spawnMock.mockReturnValueOnce(piperChild).mockReturnValueOnce(ffmpegChild);

      const config = { ...PIPER_CONFIG, useCuda: true };
      const promise = piperTTS({
        text: "test",
        config,
        outputFormat: "wav",
        timeoutMs: 10000,
      });

      const piperArgs = spawnMock.mock.calls[0][1] as string[];
      expect(piperArgs).toContain("--cuda");

      piperChild.stdout.emit("data", Buffer.alloc(10));
      piperChild.emit("close", 0);
      ffmpegChild.stdout.emit("data", Buffer.from("wav-data"));
      ffmpegChild.emit("close", 0);
      await promise;
    });

    it("rejects when piper binary not found (ENOENT)", async () => {
      const piperChild = createMockChild();
      spawnMock.mockReturnValueOnce(piperChild);

      const promise = piperTTS({
        text: "test",
        config: PIPER_CONFIG,
        outputFormat: "wav",
        timeoutMs: 10000,
      });

      const err = new Error("spawn piper ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      piperChild.emit("error", err);

      await expect(promise).rejects.toThrow("Piper binary not found: piper");
    });

    it("rejects on non-ENOENT spawn error", async () => {
      const piperChild = createMockChild();
      spawnMock.mockReturnValueOnce(piperChild);

      const promise = piperTTS({
        text: "test",
        config: PIPER_CONFIG,
        outputFormat: "wav",
        timeoutMs: 10000,
      });

      piperChild.emit("error", new Error("EACCES"));

      await expect(promise).rejects.toThrow("Failed to run piper: EACCES");
    });

    it("rejects on non-zero exit code without leaking stderr", async () => {
      const piperChild = createMockChild();
      spawnMock.mockReturnValueOnce(piperChild);

      const promise = piperTTS({
        text: "test",
        config: PIPER_CONFIG,
        outputFormat: "wav",
        timeoutMs: 10000,
      });

      piperChild.stderr.emit("data", Buffer.from("model loading error at /secret/path"));
      piperChild.emit("close", 1);

      await expect(promise).rejects.toThrow("Piper exited with code 1");
      try {
        await promise;
      } catch (e) {
        expect((e as Error).message).not.toContain("/secret/path");
      }
    });

    it("rejects when piper produces no output", async () => {
      const piperChild = createMockChild();
      spawnMock.mockReturnValueOnce(piperChild);

      const promise = piperTTS({
        text: "test",
        config: PIPER_CONFIG,
        outputFormat: "wav",
        timeoutMs: 10000,
      });

      // Close without any stdout data
      piperChild.emit("close", 0);

      await expect(promise).rejects.toThrow("Piper produced no audio output");
    });

    it("rejects when piper output exceeds buffer limit", async () => {
      const piperChild = createMockChild();
      spawnMock.mockReturnValueOnce(piperChild);

      const promise = piperTTS({
        text: "test",
        config: PIPER_CONFIG,
        outputFormat: "wav",
        timeoutMs: 10000,
      });

      const hugeChunk = Buffer.alloc(MAX_AUDIO_BUFFER_BYTES + 1);
      piperChild.stdout.emit("data", hugeChunk);

      await expect(promise).rejects.toThrow("Piper output exceeded maximum buffer size");
      expect(piperChild.kill).toHaveBeenCalled();
    });

    it("rejects on timeout", async () => {
      vi.useFakeTimers();
      const piperChild = createMockChild();
      spawnMock.mockReturnValueOnce(piperChild);

      const promise = piperTTS({
        text: "test",
        config: PIPER_CONFIG,
        outputFormat: "wav",
        timeoutMs: 3000,
      });

      vi.advanceTimersByTime(3001);

      await expect(promise).rejects.toThrow("Piper TTS timed out");
      expect(piperChild.kill).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("sanitizes control characters from stdin text", async () => {
      const piperChild = createMockChild();
      const ffmpegChild = createMockChild();
      spawnMock.mockReturnValueOnce(piperChild).mockReturnValueOnce(ffmpegChild);

      const textWithControlChars = "hello\0world\x01\x02test\ttab\nnewline";
      const promise = piperTTS({
        text: textWithControlChars,
        config: PIPER_CONFIG,
        outputFormat: "wav",
        timeoutMs: 10000,
      });

      // Null bytes and C0 control chars stripped, but \t and \n preserved
      expect(piperChild.stdin.write).toHaveBeenCalledWith("helloworldtest\ttab\nnewline");

      piperChild.stdout.emit("data", Buffer.alloc(10));
      piperChild.emit("close", 0);
      ffmpegChild.stdout.emit("data", Buffer.from("wav"));
      ffmpegChild.emit("close", 0);
      await promise;
    });

    it("subtracts elapsed piper time from ffmpeg timeout", async () => {
      vi.useFakeTimers();
      const piperChild = createMockChild();
      const ffmpegChild = createMockChild();
      spawnMock.mockReturnValueOnce(piperChild).mockReturnValueOnce(ffmpegChild);

      const promise = piperTTS({
        text: "test",
        config: PIPER_CONFIG,
        outputFormat: "wav",
        timeoutMs: 10000,
      });

      // Simulate piper taking 7 seconds
      vi.advanceTimersByTime(7000);
      piperChild.stdout.emit("data", Buffer.alloc(10));
      piperChild.emit("close", 0);

      // ffmpeg should get a timeout of max(10000-7000, 5000) = 5000ms
      // Advancing 5001ms should trigger the ffmpeg timeout
      vi.advanceTimersByTime(5001);

      await expect(promise).rejects.toThrow("ffmpeg audio conversion timed out");
      vi.useRealTimers();
    });

    it("caps stderr accumulation at MAX_STDERR_BYTES", async () => {
      const piperChild = createMockChild();
      spawnMock.mockReturnValueOnce(piperChild);

      const promise = piperTTS({
        text: "test",
        config: PIPER_CONFIG,
        outputFormat: "wav",
        timeoutMs: 10000,
      });

      // Send more stderr than the cap allows
      const bigStderr = Buffer.alloc(MAX_STDERR_BYTES + 5000, 65); // 'A'
      piperChild.stderr.emit("data", bigStderr);
      piperChild.emit("close", 1);

      // Should reject without crashing
      await expect(promise).rejects.toThrow("Piper exited with code 1");
    });
  });
});
