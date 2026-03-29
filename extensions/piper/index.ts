import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildPiperSpeechProvider } from "./speech-provider.js";

export default definePluginEntry({
  id: "piper",
  name: "Piper TTS",
  description: "Bundled Piper local neural TTS provider",
  register(api) {
    api.registerSpeechProvider(buildPiperSpeechProvider());
  },
});
