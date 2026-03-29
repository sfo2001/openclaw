import { spawn } from "node:child_process";
import path from "node:path";
import type { SpeechProviderConfig, SpeechProviderPlugin } from "openclaw/plugin-sdk/speech-core";

/** Hard limit on buffered audio data from piper/ffmpeg subprocesses (100 MB). */
const MAX_AUDIO_BUFFER_BYTES = 100 * 1024 * 1024;

/** Hard limit on buffered stderr from subprocesses (4 KB). */
const MAX_STDERR_BYTES = 4096;

/** Floor for ffmpeg conversion timeout when piper consumes most of the budget. */
const MIN_FFMPEG_TIMEOUT_MS = 5000;

const PIPER_DEFAULTS = {
  binaryPath: "piper",
  sampleRate: 22050,
  lengthScale: 1.0,
  sentenceSilence: 0.2,
  speaker: 0,
};

type PiperProviderConfig = {
  binaryPath: string;
  modelPath?: string;
  configPath?: string;
  sampleRate: number;
  lengthScale: number;
  sentenceSilence: number;
  useCuda: boolean;
  speaker: number;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizePiperProviderConfig(rawConfig: Record<string, unknown>): PiperProviderConfig {
  // Support both tools.tts.piper.* (legacy/direct) and tools.tts.providers.piper.* (new path).
  const providers = asObject(rawConfig.providers);
  const rawPiper = asObject(rawConfig.piper);
  const rawProvider = asObject(providers?.piper);
  const raw = { ...(rawPiper ?? {}), ...(rawProvider ?? {}) };
  return {
    binaryPath: asString(raw.binaryPath) ?? PIPER_DEFAULTS.binaryPath,
    modelPath: asString(raw.modelPath),
    configPath: asString(raw.configPath),
    sampleRate: asNumber(raw.sampleRate) ?? PIPER_DEFAULTS.sampleRate,
    lengthScale: asNumber(raw.lengthScale) ?? PIPER_DEFAULTS.lengthScale,
    sentenceSilence: asNumber(raw.sentenceSilence) ?? PIPER_DEFAULTS.sentenceSilence,
    useCuda: asBoolean(raw.useCuda) ?? false,
    speaker: asNumber(raw.speaker) ?? PIPER_DEFAULTS.speaker,
  };
}

function readPiperProviderConfig(providerConfig: SpeechProviderConfig): PiperProviderConfig {
  return normalizePiperProviderConfig(providerConfig as Record<string, unknown>);
}

async function convertPcmToFormat(
  pcm: Buffer,
  sampleRate: number,
  format: "wav" | "mp3" | "opus",
  timeoutMs: number,
): Promise<Buffer> {
  const formatArgs: Record<string, string[]> = {
    wav: ["-f", "wav"],
    mp3: ["-f", "mp3", "-b:a", "128k"],
    opus: ["-f", "ogg", "-c:a", "libopus", "-b:a", "64k"],
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = <T>(fn: (v: T) => void, value: T) => {
      if (settled) {
        return;
      }
      settled = true;
      fn(value);
    };

    const args = [
      "-f",
      "s16le",
      "-ar",
      String(sampleRate),
      "-ac",
      "1",
      "-i",
      "pipe:0",
      ...formatArgs[format],
      "pipe:1",
    ];

    const ffmpeg = spawn("ffmpeg", args);

    const timer = setTimeout(() => {
      try {
        ffmpeg.kill();
      } catch {
        /* already exited */
      }
      settle(reject, new Error("ffmpeg audio conversion timed out"));
    }, timeoutMs);

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let stderr = "";

    ffmpeg.stdout.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_AUDIO_BUFFER_BYTES) {
        clearTimeout(timer);
        try {
          ffmpeg.kill();
        } catch {
          /* already exited */
        }
        settle(reject, new Error("ffmpeg output exceeded maximum buffer size"));
        return;
      }
      chunks.push(chunk);
    });

    ffmpeg.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) {
        stderr += chunk.toString().slice(0, MAX_STDERR_BYTES - stderr.length);
      }
    });

    ffmpeg.on("error", (err) => {
      clearTimeout(timer);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        settle(
          reject,
          new Error(
            "ffmpeg not found. Piper TTS requires ffmpeg to convert audio. " +
              "Install ffmpeg: https://ffmpeg.org/download.html",
          ),
        );
      } else {
        settle(reject, new Error(`Failed to run ffmpeg: ${err.message}`));
      }
    });

    ffmpeg.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        settle(reject, new Error(`ffmpeg exited with code ${code}`));
        return;
      }
      settle(resolve, Buffer.concat(chunks));
    });

    ffmpeg.stdin.write(pcm);
    ffmpeg.stdin.end();
  });
}

async function piperTTS(params: {
  text: string;
  config: PiperProviderConfig;
  outputFormat: "wav" | "mp3" | "opus";
  timeoutMs: number;
}): Promise<Buffer> {
  const { text, config, outputFormat, timeoutMs } = params;

  if (!config.modelPath) {
    throw new Error("Piper TTS requires modelPath to be configured");
  }

  const args = [
    "--model",
    config.modelPath,
    "--output-raw",
    "--length-scale",
    String(config.lengthScale),
    "--sentence-silence",
    String(config.sentenceSilence),
  ];

  if (config.configPath) {
    args.push("--config", config.configPath);
  }
  if (config.speaker !== undefined && config.speaker !== 0) {
    args.push("--speaker", String(config.speaker));
  }
  if (config.useCuda) {
    args.push("--cuda");
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = <T>(fn: (v: T) => void, value: T) => {
      if (settled) {
        return;
      }
      settled = true;
      fn(value);
    };

    const startTime = Date.now();
    const piper = spawn(config.binaryPath, args);

    const timer = setTimeout(() => {
      try {
        piper.kill();
      } catch {
        /* already exited */
      }
      settle(reject, new Error("Piper TTS timed out"));
    }, timeoutMs);

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let stderr = "";

    piper.stdout.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_AUDIO_BUFFER_BYTES) {
        clearTimeout(timer);
        try {
          piper.kill();
        } catch {
          /* already exited */
        }
        settle(reject, new Error("Piper output exceeded maximum buffer size"));
        return;
      }
      chunks.push(chunk);
    });

    piper.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) {
        stderr += chunk.toString().slice(0, MAX_STDERR_BYTES - stderr.length);
      }
    });

    piper.on("error", (err) => {
      clearTimeout(timer);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        settle(
          reject,
          new Error(
            `Piper binary not found at "${path.basename(config.binaryPath)}". Check piper.binaryPath configuration.`,
          ),
        );
      } else {
        settle(reject, new Error(`Failed to run piper: ${err.message}`));
      }
    });

    piper.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        settle(reject, new Error(`Piper exited with code ${code}`));
        return;
      }

      const pcmBuffer = Buffer.concat(chunks);
      if (pcmBuffer.length === 0) {
        settle(reject, new Error("Piper produced no audio output"));
        return;
      }

      const remaining = Math.max(timeoutMs - (Date.now() - startTime), MIN_FFMPEG_TIMEOUT_MS);
      convertPcmToFormat(pcmBuffer, config.sampleRate, outputFormat, remaining)
        .then((v) => settle(resolve, v))
        .catch((e) => settle(reject, e));
    });

    // Strip null bytes and C0 control characters (keep \t and \n for natural pauses)
    // eslint-disable-next-line no-control-regex
    const sanitized = text.replace(/[\0\x01-\x08\x0b-\x1f\x7f]/g, "");
    piper.stdin.write(sanitized);
    piper.stdin.end();
  });
}

export function buildPiperSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "piper",
    label: "Piper",
    resolveConfig: ({ rawConfig }) => normalizePiperProviderConfig(rawConfig),
    isConfigured: ({ providerConfig }) =>
      Boolean(readPiperProviderConfig(providerConfig).modelPath),
    synthesize: async (req) => {
      const config = readPiperProviderConfig(req.providerConfig);
      const outputFormat = req.target === "voice-note" ? "opus" : "mp3";
      const audioBuffer = await piperTTS({
        text: req.text,
        config,
        outputFormat,
        timeoutMs: req.timeoutMs,
      });
      return {
        audioBuffer,
        outputFormat,
        fileExtension: outputFormat === "opus" ? ".opus" : ".mp3",
        voiceCompatible: req.target === "voice-note",
      };
    },
    synthesizeTelephony: async (req) => {
      const config = readPiperProviderConfig(req.providerConfig);
      const audioBuffer = await piperTTS({
        text: req.text,
        config,
        outputFormat: "wav",
        timeoutMs: req.timeoutMs,
      });
      return {
        audioBuffer,
        outputFormat: "wav" as const,
        sampleRate: config.sampleRate,
      };
    },
  };
}

export const _test = {
  MAX_AUDIO_BUFFER_BYTES,
  MAX_STDERR_BYTES,
  piperTTS,
  convertPcmToFormat,
  normalizePiperProviderConfig,
};
