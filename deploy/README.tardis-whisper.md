# Tardis whisper add-on — local STT for Telegram voice notes

Builds on `deploy/tardis-lean`. Adds one sibling service to the compose file
and one config block to `openclaw.json`. No image rebuild required — the
whisper container is a stock `ghcr.io/hwdsl2/docker-whisper:latest`.

## What changes

| File                               | Change                                                              |
| ---------------------------------- | ------------------------------------------------------------------- |
| `deploy/docker-compose.tardis.yml` | New `whisper` service; `openclaw-gateway.depends_on: [whisper]`     |
| `deploy/openclaw-tardis.json`      | Adds `tools.media.audio` block pointing at `http://whisper:9000/v1` |

The image is multi-arch (amd64 + arm64) and ships an OpenAI-compatible
`/v1/audio/transcriptions` endpoint backed by [faster-whisper][fw]. CPU-only
on tardis; matrix's GPU could host it later if speed matters.

## Resource expectations

| Resource   | Steady state                                                           | Peak (during transcription) |
| ---------- | ---------------------------------------------------------------------- | --------------------------- |
| RAM        | ~800 MB                                                                | ~1 GB                       |
| Disk       | ~1.5 GB (model cache at `/mnt/user/appdata/whisper/models`)            | —                           |
| CPU        | idle                                                                   | spikes 1–4 cores            |
| Cold-start | first request loads the model (~5 s extra)                             | —                           |
| Throughput | ~5–15 s for a 30 s German voice note (large-v3-turbo, int8, 4 threads) | —                           |

## Pre-deploy

```bash
ssh tardis 'mkdir -p /mnt/user/appdata/whisper/models'
```

## Bring-up

```bash
# Pull the image and start the new service. OpenClaw will recreate because
# of the new depends_on edge.
ssh tardis 'cd /mnt/user/appdata/openclaw && \
  docker compose -f docker-compose.tardis.yml pull whisper && \
  docker compose -f docker-compose.tardis.yml up -d --force-recreate'

# Smoke-test the API directly (no auth, internal network only):
ssh tardis 'docker exec OpenClaw curl -s http://whisper:9000/v1/models'
# expected: a JSON listing with the loaded large-v3-turbo model

# First request triggers a model download (~1.5 GB) — takes 1–2 min on
# first run, instant after. Watch with:
ssh tardis 'docker logs -f whisper'
```

## openclaw.json patch (already staged in `deploy/openclaw-tardis.json`)

The deployed config under `/mnt/user/appdata/openclaw/config/openclaw.json`
needs the same `tools.media.audio` block. Either re-deploy the staged
`openclaw-tardis.json` over it, or hand-merge:

```jsonc
"tools": {
  ...
  "media": {
    "audio": {
      "enabled": true,
      "models": [
        {
          "id": "whisper-large-v3-turbo",
          "transport": "openai-compatible-audio",
          "request": {
            "baseUrl": "http://whisper:9000/v1",
            "endpoint": "/audio/transcriptions",
            "auth": { "type": "none" }
          }
        }
      ],
      "transcriptFormat": "📝 \"{transcript}\""
    }
  },
  ...
}
```

After config change: `docker compose -f docker-compose.tardis.yml up -d --force-recreate openclaw-gateway`
(compose-only edits don't trigger restart on plain `up -d`).

## Sanity test

Send a German voice note via Telegram. Expected:

1. Bot replies immediately with `📝 "transcribed text here"` (echo from
   `transcriptFormat`).
2. The same transcript is fed to Seven as the user message — normal agent
   reply follows.

If the echo never appears:

- `docker logs whisper` — model load error or auth failure?
- `docker logs OpenClaw 2>&1 | grep -iE "audio|transcrib"` — config wiring miss?

## Tuning knobs

| Env var                | Current          | When to change                                                                             |
| ---------------------- | ---------------- | ------------------------------------------------------------------------------------------ |
| `WHISPER_MODEL`        | `large-v3-turbo` | Drop to `medium` if RAM-tight; bump to `large-v3` only if turbo's accuracy is insufficient |
| `WHISPER_LANGUAGE`     | `de`             | Set to `auto` if you also use the bot in English                                           |
| `WHISPER_THREADS`      | `4`              | Match to free cores on tardis; more threads ≠ more speed past a point                      |
| `WHISPER_COMPUTE_TYPE` | `int8`           | `float16` is more accurate but uses ~2× RAM; only worth it on GPU                          |
| `WHISPER_DEVICE`       | `cpu`            | `cuda` if you migrate to matrix or add a GPU to tardis                                     |

## Future: TTS (out of scope for this branch)

`hwdsl2/docker-whisper` is STT-only. If you later want the bot to speak
back, swap to `speaches-ai/speaches` (same compose slot, different image)
which adds OpenAI-compatible TTS via piper / Kokoro. That's a follow-up
branch.

## Rollback

```bash
ssh tardis 'cd /mnt/user/appdata/openclaw && \
  docker compose -f docker-compose.tardis.yml stop whisper && \
  docker compose -f docker-compose.tardis.yml rm -f whisper'
# revert openclaw.json (drop the tools.media.audio block) and:
ssh tardis 'cd /mnt/user/appdata/openclaw && \
  docker compose -f docker-compose.tardis.yml up -d --force-recreate openclaw-gateway'
```

The model cache at `/mnt/user/appdata/whisper/models` can be deleted to
reclaim ~1.5 GB once the service is gone.

[fw]: https://github.com/SYSTRAN/faster-whisper
