# Tardis coqui-local TTS add-on — local multilingual TTS

Builds on `feat/tardis-whisper`. Adds one OpenClaw extension
(`extensions/coqui-local/`) and one config block to
`deploy/openclaw-tardis.json`. **No change to `docker-compose.tardis.yml`** —
the TTS service runs on **matrix** (192.168.178.159), not on tardis.

## What changes

| File                            | Change                                                                |
| ------------------------------- | --------------------------------------------------------------------- |
| `extensions/coqui-local/` (new) | New TS speech provider plugin (`coqui-local`) calling matrix over LAN |
| `deploy/openclaw-tardis.json`   | Adds `messages.tts.providers.coqui-local` and selects it as default   |

## Architecture

```
┌─ tardis (Unraid, 192.168.178.71) ────────┐    ┌─ matrix (192.168.178.159) ─────┐
│  openclaw-gateway container              │    │  coqui-tts container           │
│   ├── extensions/coqui-local/            │ ─→ │   ├── ROCm 6.2 / RX 7800 XT    │
│   └── messages.tts.provider = coqui-local│    │   ├── Coqui XTTS-v2 (idiap)    │
│                                          │    │   └── FastAPI :8765            │
│                                          │    │      /health /tts /voices      │
└──────────────────────────────────────────┘    └────────────────────────────────┘
```

The OpenClaw container's existing `extra_hosts` block already maps
`matrix:192.168.178.159`, so the plugin reaches the service by hostname.

## Resource expectations (on matrix)

| Resource   | Steady state             | Peak (during synthesis)      |
| ---------- | ------------------------ | ---------------------------- |
| VRAM       | ~4–6 GB (fp16)           | same                         |
| RAM        | ~1.5 GB                  | ~2 GB                        |
| Cold start | ~5 s on first request    | —                            |
| Warm RTT   | ~200–400 ms (≤150 chars) | grows linearly with text     |
| Network    | LAN only, no auth header | trust-the-LAN security model |

## Languages supported

`de`, `en`, `it` — XTTS-v2 supports 17 languages but the client surface is
restricted to these three by validation. To enable others, edit
`extensions/coqui-local/shared.ts` and the FastAPI request model.

## Pre-deploy

The TTS service ships as part of [matrix-server-toolkit][toolkit] —
install the deb, then drive the service via `matrix-coqui-tts`:

[toolkit]: https://gitea.192.168.178.3/stefan/matrix-server-toolkit

```bash
# Install on the matrix host:
sudo dpkg -i matrix-server-toolkit_1.1.0-1_all.deb

# First-time build of the Docker image (~10–20 min):
matrix-coqui-tts build

# Start the service:
matrix-coqui-tts up
matrix-coqui-tts logs              # wait for "xtts_loaded"

# Or enable at boot:
sudo systemctl enable --now matrix-coqui-tts.service
```

Source lives at `/usr/share/matrix-toolkit/coqui-tts/` (Dockerfile,
docker-compose.yml, FastAPI app). Configuration overrides via
`/etc/matrix-toolkit/coqui-tts.conf` (bind IP, port, model dir, UID/GID).
Model weights persist under `/home/models/shared/coqui` alongside ollama,
piper, whisper.

First request triggers a model download (~2 GB) — takes 1–3 min on first
run, instant after (cached in named volume).

## Bring-up (tardis)

```bash
# Sync the patched openclaw-tardis.json to tardis appdata:
ssh tardis 'cat > /mnt/user/appdata/openclaw/config/openclaw.json' \
  < deploy/openclaw-tardis.json

# Rebuild + restart OpenClaw to pick up the new extension:
ssh tardis 'cd /mnt/user/appdata/openclaw && \
  docker compose -f docker-compose.tardis.yml restart openclaw-gateway'

# Smoke-test that the plugin loaded:
ssh tardis 'docker exec OpenClaw curl -s http://matrix:8765/health'
# expected: {"status":"ok","model_loaded":true,"languages":["de","en","it"]}
```

## openclaw-tardis.json patch (already staged)

```jsonc
"messages": {
  "ackReactionScope": "group-mentions",
  "tts": {
    "provider": "coqui-local",
    "providers": {
      "coqui-local": {
        "baseUrl": "http://matrix:8765",
        "language": "de",
        "voice": "daisy",
        "speed": 1.0,
        "format": "wav"
      }
    }
  }
}
```

`baseUrl` uses the `matrix` hostname which is mapped via `extra_hosts` in
`docker-compose.tardis.yml`. Defaults pick German/Daisy/wav so callers can
omit those fields.

## Rollback

```bash
# Disable the plugin via config:
ssh tardis 'jq "del(.messages.tts)" /mnt/user/appdata/openclaw/config/openclaw.json'

# Or stop the service on matrix:
docker compose -f ~/devel/coqui-tts-service/docker-compose.yml down
```

The plugin code itself is harmless when `baseUrl` points nowhere; failures
return a provider HTTP error rather than crashing the gateway.

## License notice

The XTTS-v2 model weights served by the matrix container are released
under the **Coqui Public Model License (CPML) — non-commercial only**. Use
on a personal homelab is permitted; commercial use requires a separate
license. The wrapper code (this branch + the coqui-tts-service repo) is
MIT-licensed.
