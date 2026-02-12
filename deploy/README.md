# OpenClaw Hardened Deployment to TARDIS (Unraid)

Deploy the hardened OpenClaw container to Unraid N100 server "TARDIS" using a private Docker registry.

## Network Topology

```
Dev Machine --> Registry (192.168.178.72:5000)
                     |
                     v
               TARDIS (Unraid N100)
                     |
                     +--> Matrix (192.168.178.159:11434) - Ollama
                     |
                     +--> Autorouter (bridge, :4000 port mapping)
                     |
                     +--> NFS (192.168.178.71:/nfs/openclaw)
```

## One-Time TARDIS Setup

### 1. Configure Docker Insecure Registry

Edit `/boot/config/docker.cfg` or use Unraid Docker settings to add:

```json
{ "insecure-registries": ["192.168.178.72:5000"] }
```

Restart Docker after this change.

### 2. Install Docker Compose

Install the **Docker Compose Manager** plugin from Unraid Community Applications.
This provides `docker compose` (v2 syntax) integrated with Docker on Unraid.

### 3. Create Directories and Home Setup

```bash
# Create directories
mkdir -p /mnt/user/appdata/openclaw/{config,docs,home}

# Create gitconfig with safe.directory for NFS workspace
cat > /mnt/user/appdata/openclaw/home/.gitconfig << 'EOF'
[safe]
    directory = /home/node/clawd
[user]
    name = Seven of Nine
    email = seven@openclaw.local
EOF

# Create .openclaw state directory inside home
mkdir -p /mnt/user/appdata/openclaw/home/.openclaw

# Set ownership to container's node user (UID 1000)
chown -R 1000:1000 /mnt/user/appdata/openclaw/home
chown 1000:1000 /mnt/user/appdata/openclaw/config
```

The home directory structure allows the container (read-only root filesystem) to write:

- `.gitconfig` - git configuration and safe.directory
- `.openclaw/` - persistent state (pairing, sessions, telegram cache)
- `.bash_history` - shell history (if needed)
- `.ssh/` - SSH keys for git operations (optional)

### 4. Mount NFS Workspace

Add NFS mount in Unraid (Settings > NFS):

- Server: `192.168.178.71`
- Share: `/nfs/openclaw`
- Mount: `/mnt/nfs/openclaw`

Or add to `/etc/fstab`:

```
192.168.178.71:/nfs/openclaw /mnt/nfs/openclaw nfs defaults 0 0
```

Ensure the NFS workspace is owned by UID 1000 (container's node user):

```bash
# On the NFS server
chown -R 1000:1000 /nfs/openclaw
```

### 5. Deploy Config

Copy config template and set token:

```bash
# On dev machine
scp deploy/openclaw-tardis.template.json tardis:/mnt/user/appdata/openclaw/config/openclaw.json

# On TARDIS - edit and set secure token
nano /mnt/user/appdata/openclaw/config/openclaw.json
```

### 6. Copy Docs

```bash
# On dev machine
rsync -av docs/ tardis:/mnt/user/appdata/openclaw/docs/
```

## Unraid GUI Installation (Recommended)

Use the Unraid Docker template for full GUI integration.

### Install Template

```bash
# On TARDIS
mkdir -p /boot/config/plugins/dockerMan/templates-user

# From dev machine
scp deploy/unraid-template.xml tardis:/boot/config/plugins/dockerMan/templates-user/my-OpenClaw.xml
```

### Add Container via GUI

1. Go to Docker tab in Unraid
2. Click "Add Container"
3. Select "OpenClaw" from Template dropdown
4. Review/adjust settings:
   - Verify paths for Config, Docs, Workspace
   - Add BRAVE_API_KEY if using web search
5. Click "Apply"

The container will appear in the Docker tab with:

- Start/Stop/Restart controls
- WebUI link to Control UI
- Update button for new images
- Log viewer

### Volume Mount Order

The template configures these volume mounts in order:

| Host Path                              | Container Path     | Purpose                            |
| -------------------------------------- | ------------------ | ---------------------------------- |
| `/mnt/user/appdata/openclaw/home`      | `/home/node`       | Writable home directory            |
| `/mnt/remotes/192.168.178.71_openclaw` | `/home/node/clawd` | NFS workspace (overlays into home) |
| `/mnt/user/appdata/openclaw/docs`      | `/home/node/docs`  | Documentation (overlays into home) |
| `/mnt/user/appdata/openclaw/config`    | `/config`          | Config directory                   |

Docker handles nested mounts correctly - the NFS workspace appears inside `/home/node/clawd` even though `/home/node` is a separate volume.

### Notes

- Watch for trailing spaces in Unraid path fields - they cause mount failures
- State is stored in `/home/node/.openclaw` inside the home volume (no separate state mount needed)
- If you had a previous `/mnt/user/appdata/openclaw/state` directory, move it to `/mnt/user/appdata/openclaw/home/.openclaw`

## Build and Deploy

### From Development Machine

```bash
# Checkout deployment branch
git checkout deploy/tardis-hardened

# Build and push images (tags as :latest and :YYYY-MM-DD)
./scripts/build-and-push.sh --tag $(date +%Y-%m-%d)
```

### Deploy on TARDIS

```bash
cd /mnt/user/appdata/openclaw

# Copy compose file (first time only)
# scp deploy/docker-compose.unraid.yml tardis:/mnt/user/appdata/openclaw/docker-compose.yml

# Pull latest images
docker pull 192.168.178.72:5000/OpenClaw:latest
docker pull 192.168.178.72:5000/openclaw-sandbox:latest

# Start/restart
docker compose up -d --force-recreate
```

## Vault Deployment

The vault sidecar isolates API credentials from the OpenClaw container. Secrets
are age-encrypted at rest and decrypted only inside the vault container at
startup. See `docs/gateway/vault.md` for the full architecture.

### Initial Setup

```bash
# On dev machine: build and push vault image
./scripts/build-and-push.sh --vault

# On TARDIS: copy the compose file
scp deploy/docker-compose.vault.yml tardis:/mnt/user/appdata/openclaw/
```

### Migrate Secrets to Vault

Use `openclaw vault migrate` to generate the age keypair and encrypt existing
API keys from `openclaw.json` into `vault.age`:

```bash
# On TARDIS (interactive — prints the age secret key)
docker run --rm -it \
  -v /mnt/user/appdata/openclaw/config:/config \
  -e OPENCLAW_CONFIG_PATH=/config/openclaw.json \
  192.168.178.72:5000/openclaw-hardened:latest \
  node dist/index.js vault migrate --proxy-host vault

# Save the printed AGE_SECRET_KEY to .env
echo 'AGE_SECRET_KEY=<key-from-above>' > /mnt/user/appdata/openclaw/.env
chmod 0600 /mnt/user/appdata/openclaw/.env
```

### Start Vault Deployment

```bash
cd /mnt/user/appdata/openclaw
docker compose -f docker-compose.vault.yml up -d
```

### Vault Update Workflow

```bash
# On dev machine: rebuild and push
./scripts/build-and-push.sh --vault

# On TARDIS: pull new images and recreate
cd /mnt/user/appdata/openclaw
docker compose -f docker-compose.vault.yml pull
docker compose -f docker-compose.vault.yml up -d --force-recreate
```

### Rotate Secrets

Re-run `openclaw vault migrate` to re-encrypt with new keys, then update `.env`
with the new secret key and restart:

```bash
cd /mnt/user/appdata/openclaw
docker compose -f docker-compose.vault.yml restart vault
```

## Update Workflow

### Push New Version

```bash
# On dev machine
git checkout deploy/tardis-hardened
# make changes...
./scripts/build-and-push.sh
```

### Deploy Update on TARDIS

```bash
docker pull 192.168.178.72:5000/OpenClaw:latest
docker pull 192.168.178.72:5000/openclaw-sandbox:latest
docker compose up -d --force-recreate
```

## Verification Checklist

After deployment, verify:

```bash
# Gateway health
curl http://tardis:18790/health

# Ollama connectivity (from inside container)
docker exec OpenClaw curl http://matrix:11434/api/tags

# NFS workspace writable
docker exec OpenClaw touch /home/node/clawd/.test && \
docker exec OpenClaw rm /home/node/clawd/.test && \
echo "NFS write OK"

# Check logs
docker logs OpenClaw --tail 50

# Verify includeTimeInPrompt in system prompt
docker exec OpenClaw node dist/index.js status

# Vault: health check
docker exec openclaw-vault wget -qO- http://localhost:5335/live

# Vault: test a proxy endpoint
docker exec openclaw-vault wget -qO- http://localhost:8081/v1/models
```

## Troubleshooting

### Git "dubious ownership" error

If git commands fail with "detected dubious ownership in repository":

```bash
# Verify .gitconfig exists with safe.directory
cat /mnt/user/appdata/openclaw/home/.gitconfig

# Should contain:
# [safe]
#     directory = /home/node/clawd

# If missing, create it:
cat > /mnt/user/appdata/openclaw/home/.gitconfig << 'EOF'
[safe]
    directory = /home/node/clawd
[user]
    name = Seven of Nine
    email = seven@openclaw.local
EOF
chown 1000:1000 /mnt/user/appdata/openclaw/home/.gitconfig
```

### Container won't start

```bash
# Check logs
docker logs OpenClaw

# Verify config is valid JSON
cat /mnt/user/appdata/openclaw/config/openclaw.json | jq .

# Verify NFS mount
ls -la /mnt/nfs/openclaw
```

### Can't connect to Ollama

```bash
# Test from TARDIS host
curl http://192.168.178.159:11434/api/tags

# Verify extra_hosts in compose
docker inspect OpenClaw | jq '.[0].HostConfig.ExtraHosts'
```

### Vault sidecar won't start

```bash
# Check vault logs for decrypt/config errors
docker logs openclaw-vault --tail 50

# Verify .env exists and has correct permissions
ls -la /mnt/user/appdata/openclaw/.env
# Should be -rw------- (0600)

# Verify vault.age exists
ls -la /mnt/user/appdata/openclaw/config/vault.age

# Test decryption manually (prints secrets — use only for debugging)
docker run --rm \
  --env-file /mnt/user/appdata/openclaw/.env \
  -v /mnt/user/appdata/openclaw/config/vault.age:/etc/vault.age:ro \
  192.168.178.72:5000/openclaw-vault:latest \
  sh -c 'echo "$AGE_SECRET_KEY" | age -d -i - /etc/vault.age'
```

### Vault proxy returns 502/connection refused

```bash
# DNS resolution: nginx resolves upstreams at startup, not per-request.
# If DNS was unavailable at start, restart the vault.
cd /mnt/user/appdata/openclaw
docker compose -f docker-compose.vault.yml restart vault

# Verify vault-external network exists and vault is connected
docker network inspect vault-external | jq '.[0].Containers'

# Test from inside the vault container
docker exec openclaw-vault wget -qO- http://localhost:5335/live
```

### Vault capabilities error (Operation not permitted)

The vault sidecar needs CHOWN, SETUID, SETGID, NET_BIND_SERVICE capabilities.
These are configured in `docker-compose.vault.yml` via `cap_add`.

### Sandbox image not pulling

```bash
# Verify registry is accessible
curl http://192.168.178.72:5000/v2/_catalog

# Check insecure registry config
docker info | grep -A5 "Insecure Registries"
```

## Files

| File                             | Purpose                                       |
| -------------------------------- | --------------------------------------------- |
| `unraid-template.xml`            | Unraid Docker GUI template                    |
| `docker-compose.unraid.yml`      | Docker Compose for standalone gateway         |
| `docker-compose.vault.yml`       | Docker Compose for vault + gateway            |
| `openclaw-tardis.template.json`  | Config template (replace token before use)    |
| `../vault/`                      | Vault sidecar (Dockerfile, nginx, entrypoint) |
| `../scripts/build-and-push.sh`   | Build and push to private registry            |
| `../docker-compose.hardened.yml` | Local dev deployment                          |
