import { beforeEach, describe, expect, it, vi } from "vitest";
import { withEnv } from "../../test-utils/env.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("../../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  withStrictGuardedFetchMode: (opts: Record<string, unknown>) => ({ ...opts, mode: "strict" }),
  withTrustedEnvProxyGuardedFetchMode: (opts: Record<string, unknown>) => ({
    ...opts,
    mode: "trusted_env_proxy",
  }),
}));

import { createWebSearchTool, __testing } from "./web-search.js";

const {
  normalizeBraveLanguageParams,
  normalizeFreshness,
  resolveGrokApiKey,
  resolveGrokModel,
  resolveGrokInlineCitations,
  extractGrokContent,
} = __testing;

describe("web_search brave language param normalization", () => {
  it("normalizes and auto-corrects swapped Brave language params", () => {
    expect(normalizeBraveLanguageParams({ search_lang: "tr-TR", ui_lang: "tr" })).toEqual({
      search_lang: "tr",
      ui_lang: "tr-TR",
    });
    expect(normalizeBraveLanguageParams({ search_lang: "EN", ui_lang: "en-us" })).toEqual({
      search_lang: "en",
      ui_lang: "en-US",
    });
  });

  it("flags invalid Brave language formats", () => {
    expect(normalizeBraveLanguageParams({ search_lang: "en-US" })).toEqual({
      invalidField: "search_lang",
    });
    expect(normalizeBraveLanguageParams({ ui_lang: "en" })).toEqual({
      invalidField: "ui_lang",
    });
  });
});

describe("web_search freshness normalization", () => {
  it("accepts Brave shortcut values", () => {
    expect(normalizeFreshness("pd", "brave")).toBe("pd");
    expect(normalizeFreshness("PW", "brave")).toBe("pw");
  });

  it("accepts valid date ranges", () => {
    expect(normalizeFreshness("2024-01-01to2024-01-31", "brave")).toBe("2024-01-01to2024-01-31");
  });

  it("rejects invalid date ranges", () => {
    expect(normalizeFreshness("2024-13-01to2024-01-31", "brave")).toBeUndefined();
    expect(normalizeFreshness("2024-02-30to2024-03-01", "brave")).toBeUndefined();
    expect(normalizeFreshness("2024-03-10to2024-03-01", "brave")).toBeUndefined();
  });
});

describe("web_search grok config resolution", () => {
  it("uses config apiKey when provided", () => {
    expect(resolveGrokApiKey({ apiKey: "xai-test-key" })).toBe("xai-test-key");
  });

  it("returns undefined when no apiKey is available", () => {
    withEnv({ XAI_API_KEY: undefined }, () => {
      expect(resolveGrokApiKey({})).toBeUndefined();
      expect(resolveGrokApiKey(undefined)).toBeUndefined();
    });
  });

  it("uses default model when not specified", () => {
    expect(resolveGrokModel({})).toBe("grok-4-1-fast");
    expect(resolveGrokModel(undefined)).toBe("grok-4-1-fast");
  });

  it("uses config model when provided", () => {
    expect(resolveGrokModel({ model: "grok-3" })).toBe("grok-3");
  });

  it("defaults inlineCitations to false", () => {
    expect(resolveGrokInlineCitations({})).toBe(false);
    expect(resolveGrokInlineCitations(undefined)).toBe(false);
  });

  it("respects inlineCitations config", () => {
    expect(resolveGrokInlineCitations({ inlineCitations: true })).toBe(true);
    expect(resolveGrokInlineCitations({ inlineCitations: false })).toBe(false);
  });
});

describe("web_search grok response parsing", () => {
  it("extracts content from Responses API message blocks", () => {
    const result = extractGrokContent({
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "hello from output" }],
        },
      ],
    });
    expect(result.text).toBe("hello from output");
    expect(result.annotationCitations).toEqual([]);
  });

  it("extracts url_citation annotations from content blocks", () => {
    const result = extractGrokContent({
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "hello with citations",
              annotations: [
                {
                  type: "url_citation",
                  url: "https://example.com/a",
                  start_index: 0,
                  end_index: 5,
                },
                {
                  type: "url_citation",
                  url: "https://example.com/b",
                  start_index: 6,
                  end_index: 10,
                },
                {
                  type: "url_citation",
                  url: "https://example.com/a",
                  start_index: 11,
                  end_index: 15,
                }, // duplicate
              ],
            },
          ],
        },
      ],
    });
    expect(result.text).toBe("hello with citations");
    expect(result.annotationCitations).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("falls back to deprecated output_text", () => {
    const result = extractGrokContent({ output_text: "hello from output_text" });
    expect(result.text).toBe("hello from output_text");
    expect(result.annotationCitations).toEqual([]);
  });

  it("returns undefined text when no content found", () => {
    const result = extractGrokContent({});
    expect(result.text).toBeUndefined();
    expect(result.annotationCitations).toEqual([]);
  });

  it("extracts output_text blocks directly in output array (no message wrapper)", () => {
    const result = extractGrokContent({
      output: [
        { type: "web_search_call" },
        {
          type: "output_text",
          text: "direct output text",
          annotations: [
            {
              type: "url_citation",
              url: "https://example.com/direct",
              start_index: 0,
              end_index: 5,
            },
          ],
        },
      ],
    } as Parameters<typeof extractGrokContent>[0]);
    expect(result.text).toBe("direct output text");
    expect(result.annotationCitations).toEqual(["https://example.com/direct"]);
  });
});

describe("web_search vault proxy integration", () => {
  it("creates tool when vault is disabled (unchanged behavior)", () => {
    const tool = createWebSearchTool({
      config: {
        vault: { enabled: false },
        tools: { web: { search: { enabled: true, provider: "brave" } } },
      },
    });
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("web_search");
  });

  it("creates tool when vault is enabled with brave proxy", () => {
    const tool = createWebSearchTool({
      config: {
        vault: {
          enabled: true,
          proxies: { brave: "http://vault:8089" },
        },
        tools: { web: { search: { enabled: true, provider: "brave" } } },
      },
    });
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("web_search");
  });

  it("creates tool when vault is enabled with xai proxy (grok provider)", () => {
    const tool = createWebSearchTool({
      config: {
        vault: {
          enabled: true,
          proxies: { xai: "http://vault:8087" },
        },
        tools: { web: { search: { enabled: true, provider: "grok" } } },
      },
    });
    expect(tool).not.toBeNull();
  });

  it("creates tool when vault is enabled with perplexity proxy", () => {
    const tool = createWebSearchTool({
      config: {
        vault: {
          enabled: true,
          proxies: { perplexity: "http://vault:8090" },
        },
        tools: { web: { search: { enabled: true, provider: "perplexity" } } },
      },
    });
    expect(tool).not.toBeNull();
  });

  it("creates tool without vault config (no vault section)", () => {
    const tool = createWebSearchTool({
      config: {
        tools: { web: { search: { enabled: true, provider: "brave" } } },
      },
    });
    expect(tool).not.toBeNull();
  });
});

describe("web_search vault proxy execute path", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
  });

  function setupFetchMock(body: object): void {
    fetchWithSsrFGuardMock.mockImplementation(async (opts: { url: string }) => ({
      response: new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      finalUrl: opts.url,
      release: async () => {},
    }));
  }

  function getCapturedUrl(): string {
    return fetchWithSsrFGuardMock.mock.calls[0][0].url;
  }

  function getCapturedHeaders(): Record<string, string> {
    const init = fetchWithSsrFGuardMock.mock.calls[0][0].init ?? {};
    return Object.fromEntries(
      Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
    );
  }

  it("brave: routes through vault proxy URL, omits X-Subscription-Token", async () => {
    setupFetchMock({
      web: { results: [{ title: "test", url: "https://example.com", description: "desc" }] },
    });

    const tool = createWebSearchTool({
      config: {
        vault: { enabled: true, proxies: { brave: "http://vault:8089" } },
        tools: { web: { search: { enabled: true, provider: "brave" } } },
      },
    })!;

    await tool.execute("t1", { query: "test query" });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
    expect(getCapturedUrl()).toContain("http://vault:8089/res/v1/web/search");
    expect(getCapturedHeaders()).not.toHaveProperty("x-subscription-token");
  });

  it("perplexity: routes through vault proxy URL, omits Authorization header", async () => {
    setupFetchMock({
      choices: [{ message: { content: "answer" } }],
      citations: ["https://example.com"],
    });

    const tool = createWebSearchTool({
      config: {
        vault: { enabled: true, proxies: { perplexity: "http://vault:8090" } },
        tools: { web: { search: { enabled: true, provider: "perplexity" } } },
      },
    })!;

    await tool.execute("t2", { query: "test query" });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
    expect(getCapturedUrl()).toBe("http://vault:8090");
    expect(getCapturedHeaders()).not.toHaveProperty("authorization");
  });

  it("grok: routes through vault proxy URL, omits Authorization header", async () => {
    setupFetchMock({ output_text: "answer", citations: ["https://example.com"] });

    const tool = createWebSearchTool({
      config: {
        vault: { enabled: true, proxies: { xai: "http://vault:8087" } },
        tools: { web: { search: { enabled: true, provider: "grok" } } },
      },
    })!;

    await tool.execute("t3", { query: "test query" });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
    expect(getCapturedUrl()).toBe("http://vault:8087/v1/responses");
    expect(getCapturedHeaders()).not.toHaveProperty("authorization");
  });
});
