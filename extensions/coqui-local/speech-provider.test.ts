import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { buildCoquiLocalSpeechProvider } from "./speech-provider.js";

describe("coqui-local speech provider", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it("registers with the expected id and label", () => {
    const p = buildCoquiLocalSpeechProvider();
    expect(p.id).toBe("coqui-local");
    expect(p.label).toBe("Coqui Local");
    expect(p.models).toEqual(["xtts_v2"]);
  });

  it("isConfigured returns true when baseUrl is set", () => {
    const p = buildCoquiLocalSpeechProvider();
    const ctx = {
      providerConfig: { baseUrl: "http://matrix:8765" },
    } as Parameters<NonNullable<typeof p.isConfigured>>[0];
    expect(p.isConfigured(ctx)).toBe(true);
  });

  it("isConfigured returns true even with default baseUrl (always falls back)", () => {
    const p = buildCoquiLocalSpeechProvider();
    const ctx = {
      providerConfig: {},
    } as Parameters<NonNullable<typeof p.isConfigured>>[0];
    expect(p.isConfigured(ctx)).toBe(true);
  });

  it("synthesize POSTs to {baseUrl}/tts and returns wav buffer", async () => {
    const audio = new Uint8Array([0x52, 0x49, 0x46, 0x46]).buffer; // "RIFF"
    globalThis.fetch = vi.fn(
      async () =>
        new Response(audio, {
          status: 200,
          headers: { "Content-Type": "audio/wav" },
        }),
    ) as unknown as typeof fetch;

    const p = buildCoquiLocalSpeechProvider();
    const result = await p.synthesize({
      text: "Hallo Welt",
      providerConfig: { baseUrl: "http://matrix:8765" },
      providerOverrides: { language: "de", voice: "daisy" },
      target: "voice-note",
      timeoutMs: 10_000,
    } as Parameters<typeof p.synthesize>[0]);

    expect(result.outputFormat).toBe("wav");
    expect(result.fileExtension).toBe(".wav");
    expect(result.audioBuffer.byteLength).toBe(4);

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(1);
    const [calledUrl, init] = calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("http://matrix:8765/tts");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.text).toBe("Hallo Welt");
    expect(body.language).toBe("de");
    expect(body.voice).toBe("daisy");
  });

  it("parseDirectiveToken accepts language=de", () => {
    const p = buildCoquiLocalSpeechProvider();
    const result = p.parseDirectiveToken!({
      key: "language",
      value: "de",
      policy: { allowNormalization: true } as never,
      currentOverrides: {},
    } as never);
    expect(result.handled).toBe(true);
    expect((result.overrides as { language: string }).language).toBe("de");
  });

  it("parseDirectiveToken rejects unsupported language with warning", () => {
    const p = buildCoquiLocalSpeechProvider();
    const result = p.parseDirectiveToken!({
      key: "language",
      value: "ja",
      policy: { allowNormalization: true } as never,
      currentOverrides: {},
    } as never);
    expect(result.handled).toBe(true);
    expect(result.warnings?.[0]).toMatch(/unsupported language/);
  });

  it("parseDirectiveToken clamps speed via requireInRange", () => {
    const p = buildCoquiLocalSpeechProvider();
    const result = p.parseDirectiveToken!({
      key: "speed",
      value: "0.8",
      policy: { allowVoiceSettings: true } as never,
      currentOverrides: {},
    } as never);
    expect(result.handled).toBe(true);
    expect((result.overrides as { speed: number }).speed).toBe(0.8);
  });
});
