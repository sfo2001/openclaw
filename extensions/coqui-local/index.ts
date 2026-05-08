import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildCoquiLocalSpeechProvider } from "./speech-provider.js";

export default definePluginEntry({
  id: "coqui-local",
  name: "Coqui Local TTS",
  description: "Self-hosted Coqui XTTS-v2 speech provider over HTTP (DE/EN/IT).",
  register(api) {
    api.registerSpeechProvider(buildCoquiLocalSpeechProvider());
  },
});
