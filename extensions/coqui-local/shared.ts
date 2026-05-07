export const COQUI_LOCAL_PROVIDER_ID = "coqui-local" as const;

export const COQUI_SUPPORTED_LANGUAGES = ["de", "en", "it"] as const;
export type CoquiLanguage = (typeof COQUI_SUPPORTED_LANGUAGES)[number];

export const DEFAULT_COQUI_BASE_URL = "http://127.0.0.1:8765";
export const DEFAULT_COQUI_LANGUAGE: CoquiLanguage = "en";
export const DEFAULT_COQUI_VOICE = "daisy";

export function normalizeCoquiBaseUrl(value: string | undefined): string {
  const trimmed = (value ?? "").trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : DEFAULT_COQUI_BASE_URL;
}

export function isSupportedCoquiLanguage(value: string): value is CoquiLanguage {
  return (COQUI_SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}
