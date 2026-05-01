# Tardis lean migration — concrete steps

## Live state (verified via SSH 2026-05-01)

| Container                       | Status                 | Action                            |
| ------------------------------- | ---------------------- | --------------------------------- |
| `OpenClaw` (openclaw-hardened)  | **Exited 2 weeks ago** | rebuild from `deploy/tardis-lean` |
| `openclaw-vault`                | Up 2 weeks (healthy)   | **stop + remove**                 |
| `openclaw-autorouter`           | Up 6 days              | **stop + remove**                 |
| `SearXNG`                       | Up 12 days             | **keep**                          |
| Local registry, gitea, HA, etc. | Up                     | unchanged                         |

OpenClaw itself is not running — the migration disturbs nothing in production.

## Files staged at /tmp/openclaw-tardis-lean/

- `docker-compose.tardis.yml` — slim compose (no vault, no autorouter networks/aliases)
- `openclaw-tardis.json` — transformed live config (vault block removed; 9 autorouter
  tier aliases re-bound to underlying Ollama models)

Both are derived from the live state on tardis. **Not deployed; review only.**

## Autorouter-tier → Ollama mapping applied

| Old alias                 | New ollama target                                            |
| ------------------------- | ------------------------------------------------------------ |
| `autorouter/fast`         | `ollama/nemotron-3-nano:4b-q8_0` (alias `fast`)              |
| `autorouter/standard`     | `ollama/nemotron-cascade-2:30b` (alias `standard`)           |
| `autorouter/complex`      | `ollama/qwen3.6:latest-64k` (alias `complex`)                |
| `autorouter/coding`       | `ollama/qwen3-coder-next` (alias `coding`)                   |
| `autorouter/coding-light` | `ollama/devstral-small-official-128k` (alias `coding-light`) |
| `autorouter/flagship`     | `ollama/qwen3.5:122b-64k` (alias `flagship`)                 |
| `autorouter/nemotron`     | `ollama/nemotron-3-super` (alias `nemotron`)                 |
| `autorouter/vision`       | `ollama/qwen3.5:9b` (alias `vision`)                         |
| `autorouter/thinking`     | **collapsed onto `complex`** (same underlying qwen3.6)       |
| `autorouter/reasoning`    | **collapsed onto `complex`** (same underlying qwen3.6)       |

OpenClaw alias keys are unique per model — autorouter exposed three tier names
backed by the same Ollama model, so two are dropped (functionality identical to
`complex`). User can still invoke `/model complex` or `/model nemotron` for
"thinking" workloads.

## Vault-routed providers → direct cloud endpoints

| Old (vault-fronted)                     | New direct                                        |
| --------------------------------------- | ------------------------------------------------- |
| `nebius` baseUrl `http://vault:8092/v1` | `https://api.studio.nebius.ai/v1`                 |
| `nvidia` baseUrl `http://vault:8093/v1` | `https://integrate.api.nvidia.com/v1`             |
| API key `vault-proxy-managed`           | `${env:NEBIUS_API_KEY}` / `${env:NVIDIA_API_KEY}` |

User decision: read keys from `vault.age` once (decrypt with `AGE_SECRET_KEY`
from `/mnt/user/appdata/openclaw/.env`), then store either as:
a) container env vars in compose,
b) plain strings in `openclaw-tardis.json` (simplest, file is `0640` already),
c) per-agent `auth-profiles.json` under `~/.openclaw/agents/seven/agent/`
(cleanest; matches CLAUDE.md guidance).

Any provider not used in agents (e.g. perplexity, brave, deepgram, mistral,
groq, xai, openai-compat) was already absent from `models.providers` — they
were vault-only entries and are gone with the vault block.

## Branch construction (do this on workstation, not tardis)

```bash
git fetch origin
git worktree add /tmp/openclaw-tardis-lean -b deploy/tardis-lean origin/main
cd /tmp/openclaw-tardis-lean

# Cherry-pick the three keep-buckets (find SHAs in the existing worktrees)
git cherry-pick $(git -C /tmp/openclaw-fix-heartbeat log origin/main..HEAD --format=%H | tac)
git cherry-pick $(git -C /tmp/openclaw-fix-security-hardening log origin/main..HEAD --format=%H | tac)
git cherry-pick $(git -C /tmp/openclaw-fix-exec-workdir-hint log origin/main..HEAD --format=%H | tac)

# Optional: piper TTS binary from feat/local-hardening if you still want it
# (verify upstream feat/piper-tts-provider isn't already in main first)

# Drop in the new compose + config under deploy/
cp /tmp/openclaw-tardis-lean/docker-compose.tardis.yml deploy/
cp /tmp/openclaw-tardis-lean/openclaw-tardis.json     deploy/

git add deploy/docker-compose.tardis.yml deploy/openclaw-tardis.json
git commit -m "deploy(tardis-lean): minimal compose + config without vault/autorouter"

# Run the changed gate before push
pnpm check:changed
git push -u gitea deploy/tardis-lean
```

## Image rebuild on tardis

```bash
ssh tardis 'cd /mnt/user/appdata/openclaw && \
  git -C build clone --depth 1 -b deploy/tardis-lean \
    git@192.168.178.3:stefan/openclaw.git build/openclaw-tardis-lean && \
  cd build/openclaw-tardis-lean && \
  docker build -t localhost:5000/openclaw-hardened:lean -f Dockerfile.hardened . && \
  docker tag localhost:5000/openclaw-hardened:lean localhost:5000/openclaw-hardened:latest && \
  docker push localhost:5000/openclaw-hardened:latest'
```

(Adjust paths and Dockerfile name if your build flow differs — verify
`deploy/Dockerfile*` on the new branch first.)

## Cutover on tardis

```bash
# 1. Snapshot the live config + compose
ssh tardis 'cd /mnt/user/appdata/openclaw && \
  cp openclaw-tardis.json{,.bak.pre-lean-$(date +%Y%m%d)} 2>/dev/null ; \
  cp config/openclaw.json{,.bak.pre-lean-$(date +%Y%m%d)} ; \
  cp docker-compose.vault.yml{,.bak.pre-lean-$(date +%Y%m%d)}'

# 2. Stop and remove vault + autorouter (do not delete vault.age yet)
ssh tardis 'docker stop openclaw-vault openclaw-autorouter && \
            docker rm  openclaw-vault openclaw-autorouter'

# 3. Push the new files (review them first locally)
scp /tmp/openclaw-tardis-lean/openclaw-tardis.json \
    tardis:/mnt/user/appdata/openclaw/config/openclaw.json
scp /tmp/openclaw-tardis-lean/docker-compose.tardis.yml \
    tardis:/mnt/user/appdata/openclaw/docker-compose.tardis.yml

# 4. Migrate secrets (one-time, manual decision):
#    - read NEBIUS_API_KEY, NVIDIA_API_KEY, OPENAI_API_KEY etc. from vault.age
#    - place them where you chose: env, json, or auth-profiles.json
ssh tardis 'cat /mnt/user/appdata/openclaw/config/vault.age | \
            age -d -i <(echo "$AGE_SECRET_KEY") '   # interactive

# 5. Start the lean stack
ssh tardis 'cd /mnt/user/appdata/openclaw && \
            docker compose -f docker-compose.tardis.yml up -d'

# 6. Smoke-test
ssh tardis 'docker logs -f OpenClaw' &
# In Telegram: /model fast 1+1=?    → expect quick local reply
#              /model complex …     → expect qwen3.6 reply
#              /model coding …      → expect qwen3-coder-next reply
#              web search query     → expect searxng results
```

## Rollback (if anything goes wrong)

```bash
ssh tardis 'cd /mnt/user/appdata/openclaw && \
  docker compose -f docker-compose.tardis.yml down ; \
  cp config/openclaw.json.bak.pre-lean-* config/openclaw.json ; \
  docker compose -f docker-compose.vault.yml up -d'
```

## What will NOT be touched until you say so

- `vault.age` blob — kept until secrets are confirmed migrated
- `feat/vault-channel-tokens` and other side branches on gitea — keep until
  `deploy/tardis-lean` is proven stable for ≥1 week
- `openclaw-autorouter` image in local registry — kept (cheap, easy revert)
- Searxng, gitea, HA, mosquitto containers — unchanged

## Open user decisions

1. **Secrets storage**: env vars / plain config / auth-profiles.json — pick one
   before step 4 of cutover.
2. **Sandbox**: live config has `sandbox.mode: "off"` — keep off, or re-enable
   with docker-socket-proxy for the lean compose?
3. **`gateway.auth.token`**: lean config templated to `${env:OPENCLAW_GATEWAY_TOKEN}`.
   Either keep it as plain string in config (was the live behaviour) or move to env.
4. **Skills `homeassistant`, `deep-researcher`, `knowledge-base`, `ad-cutter`** —
   live config has them all enabled. Keep as-is, or audit for vault-coupled
   secrets first?
