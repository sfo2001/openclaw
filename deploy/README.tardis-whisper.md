# Tardis whisper add-on — local STT for Telegram voice notes

Builds on `deploy/tardis-lean`. Adds **no service** to the tardis compose;
the Whisper STT service runs on **matrix** (192.168.178.159), provisioned
by `~/devel/matrix-server-toolkit` (`matrix-whisper`, version 1.3.1+),
backed by [speaches-ai/speaches][speaches] with a Bearer-token auth layer.

## Architecture

```
┌─ tardis (Unraid, 192.168.178.71) ────────┐    ┌─ matrix (192.168.178.159) ──────┐
│  openclaw-gateway container              │    │  matrix-whisper container       │
│   ├── tools.media.audio.openai           │ ─→ │   ├── speaches-ai/speaches:cpu  │
│   │   └── http://matrix:9000/v1          │    │   ├── faster-whisper backend    │
│   │   └── Authorization: Bearer ${KEY}   │    │   └── Bearer auth (api-key)     │
│   └── env_file: .env (MATRIX_WHISPER_…)  │    │       /v1/audio/transcriptions  │
└──────────────────────────────────────────┘    └─────────────────────────────────┘
```

The OpenClaw container's existing `extra_hosts` block already maps
`matrix:192.168.178.159`, so the audio plugin reaches the service by hostname.

## What changes

| File                              | Change                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `deploy/openclaw-tardis.json`     | Audio provider points at `matrix:9000`; apiKey reads `MATRIX_WHISPER_API_KEY` env |
| `/mnt/user/appdata/openclaw/.env` | New line: `MATRIX_WHISPER_API_KEY=<value-of-/etc/matrix-toolkit/whisper.api-key>` |

**No `docker-compose.tardis.yml` change** — the Whisper container lives on matrix.

## Default model: `Systran/faster-whisper-medium`

Matrix runs Speaches in CPU mode (the RX 7800 XT's 16 GB VRAM is reserved
for Ollama + Coqui XTTS-v2). Medium model gives ~5–8× realtime on the 7900X
CPU, with ~25% WER on German clean speech. To upgrade quality at the cost
of speed, override `WHISPER_MODEL=Systran/faster-whisper-large-v3-turbo`
in `/etc/matrix-toolkit/whisper.conf` on matrix; OpenClaw config does not
need a change because `Systran/faster-whisper-medium` is also accepted as
a `model` parameter in the request body and matrix's PRELOAD_MODELS list
can carry both.

## Pre-deploy checklist

On **matrix**:

```bash
# Install / refresh matrix-whisper from matrix-server-toolkit
ssh matrix 'sudo apt install matrix-toolkit'  # or rebuild deb if local
ssh matrix 'sudo matrix-whisper download Systran/faster-whisper-medium'
ssh matrix 'sudo matrix-whisper up'
ssh matrix 'matrix-whisper status'
ssh matrix 'matrix-whisper test'              # round-trips via curl with Bearer
```

On **tardis** — copy the API key into the OpenClaw `.env`:

```bash
KEY=$(ssh matrix 'sudo cat /etc/matrix-toolkit/whisper.api-key')
ssh tardis "echo MATRIX_WHISPER_API_KEY=$KEY | sudo tee -a /mnt/user/appdata/openclaw/.env"
ssh tardis 'sudo chmod 600 /mnt/user/appdata/openclaw/.env'
```

## Bring-up on tardis

```bash
# Recreate openclaw-gateway so it picks up the new .env value and config.
ssh tardis 'cd /mnt/user/appdata/openclaw && \
  docker compose -f docker-compose.tardis.yml up -d --force-recreate openclaw-gateway'

# Verify it can reach matrix-whisper:
ssh tardis 'docker exec OpenClaw wget -qO- --header="Authorization: Bearer $MATRIX_WHISPER_API_KEY" http://matrix:9000/v1/models'
```

## Sanity test

Send a German voice note via Telegram. Expected:

1. Bot replies immediately with `📝 "transcribed text here"` (echo from
   `echoFormat`).
2. The same transcript is fed to the agent as the user message — normal
   agent reply follows.

If the echo never appears:

- `docker logs OpenClaw 2>&1 | grep -iE "audio|transcrib"` — config wiring miss?
- On matrix: `matrix-whisper logs` — auth failure (401) or model load error?
- `ssh tardis 'docker exec OpenClaw env | grep MATRIX_WHISPER_API_KEY'` — env wired?

## openclaw.json patch (already staged in `deploy/openclaw-tardis.json`)

```jsonc
"models": {
  "providers": {
    "openai": {
      "baseUrl": "http://matrix:9000/v1",
      "apiKey": {"source": "env", "provider": "default", "id": "MATRIX_WHISPER_API_KEY"},
      "api": "openai-completions",
      "request": {"allowPrivateNetwork": true},
      "models": [
        { "id": "Systran/faster-whisper-medium",
          "name": "Whisper Medium (matrix Speaches)",
          "input": ["audio"] }
      ]
    }
  }
}
```

`request.allowPrivateNetwork: true` is required because OpenClaw's SSRF
guard otherwise blocks the matrix LAN address. The Bearer key is sent in
the `Authorization` header; Speaches enforces it (configured by
`matrix-whisper`'s postinst). The `/health` endpoint stays open and is
used by the container's healthcheck.

## Rollback

```bash
ssh matrix 'sudo matrix-whisper down'
# revert openclaw.json (or redeploy staged file from deploy/tardis-lean) and:
ssh tardis 'cd /mnt/user/appdata/openclaw && \
  docker compose -f docker-compose.tardis.yml up -d --force-recreate openclaw-gateway'
# Optional: clean .env:
ssh tardis 'sudo sed -i /MATRIX_WHISPER_API_KEY/d /mnt/user/appdata/openclaw/.env'
```

[speaches]: https://github.com/speaches-ai/speaches
