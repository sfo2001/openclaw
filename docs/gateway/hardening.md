---
summary: "Maximum security deployment for isolated environments with local-only models"
read_when:
  - You want to run OpenClaw in a fully isolated environment
  - You need to prevent AI agent network access
  - You are deploying with local Ollama models only
---

# Hardened Deployment

Deploy OpenClaw in a fully isolated environment using only local Ollama models,
with strict network controls to prevent any external access.

## Threat Model

| Goal                                        | Mitigation                               |
| ------------------------------------------- | ---------------------------------------- |
| Prevent AI agent from reaching the internet | Docker internal network + iptables DROP  |
| Prevent access to home network              | Whitelist only Ollama endpoint           |
| Limit tool capabilities                     | Tool policy: allow only read/write/edit  |
| Contain sandbox escapes                     | No shell execution, dropped capabilities |

## Architecture

```
Host Machine
+-------------------------------------------------+
|                                                 |
|  iptables DOCKER-USER chain                     |
|  [ALLOW matrix:11434] [DROP *]                  |
|                                                 |
|  +-------------------------------------------+  |
|  | Docker: openclaw-isolated (internal)      |  |
|  |                                           |  |
|  |  +-------------------------------------+  |  |
|  |  | openclaw-hardened container         |  |  |
|  |  | - read-only root                    |  |  |
|  |  | - no capabilities                   |  |  |
|  |  | - resource limits                   |  |  |
|  |  +-------------------------------------+  |  |
|  |                                           |  |
|  +-------------------------------------------+  |
|                     |                           |
|                     | (whitelist only)          |
|                     v                           |
+-------------------------------------------------+
                      |
                      v
              matrix:11434 (Ollama)
```

## Prerequisites

- Docker with compose plugin
- SSH access to Ollama server (named `matrix` in `/etc/hosts` or DNS)
- sudo access for iptables rules

## Setup Steps

### 1. Build the Sandbox Image

```bash
cd /path/to/openclaw
./scripts/sandbox-setup.sh
```

### 2. Build the Main Image

```bash
docker build -t openclaw:local .
```

### 3. Resolve Ollama Server IP

Add to `/etc/hosts` or verify DNS resolution:

```bash
getent hosts matrix
# Should return: 192.168.x.x matrix
```

### 4. Create Configuration Directory

```bash
mkdir -p ./config
```

### 5. Create Hardened Configuration

Create `./config/openclaw.json`:

```json
{
  "models": {
    "mode": "replace",
    "providers": {
      "ollama": {
        "baseUrl": "http://matrix:11434/v1",
        "apiKey": "ollama-local",
        "api": "openai-completions",
        "models": [
          {
            "id": "devstral-small-official-128k",
            "name": "Devstral Small 128K",
            "reasoning": false,
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 128000,
            "maxTokens": 8192
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "ollama/devstral-small-official-128k"
      },
      "sandbox": {
        "mode": "all",
        "scope": "session",
        "workspaceAccess": "none",
        "docker": {
          "image": "openclaw-sandbox:bookworm-slim",
          "readOnlyRoot": true,
          "network": "none",
          "capDrop": ["ALL"],
          "tmpfs": ["/tmp:size=64m,noexec,nosuid,nodev", "/var/tmp:size=32m,noexec,nosuid,nodev"],
          "pidsLimit": 64,
          "memory": "512m",
          "cpus": 1
        },
        "browser": { "enabled": false },
        "tools": {
          "allow": ["read", "write", "edit"],
          "deny": ["exec", "process", "browser", "canvas", "nodes", "cron", "gateway"]
        }
      }
    }
  },
  "gateway": {
    "mode": "local",
    "bind": "loopback",
    "port": 18789
  },
  "tools": {
    "browser": { "enabled": false },
    "canvas": { "enabled": false }
  }
}
```

### 6. Configure Docker Compose

Update `docker-compose.hardened.yml` with the matrix IP:

```bash
MATRIX_IP=$(getent hosts matrix | awk '{print $1}')
sed -i "s/MATRIX_IP_HERE/$MATRIX_IP/" docker-compose.hardened.yml
```

### 7. Start the Containers

```bash
docker compose -f docker-compose.hardened.yml up -d
```

### 8. Apply Firewall Rules

```bash
./setup-openclaw-firewall.sh
```

These rules are temporary and cleared on reboot (by design).

## Verification

### Check Internet Blocked

```bash
docker exec openclaw-hardened curl -s --max-time 5 https://example.com
# Should timeout/fail
```

### Check Ollama Reachable

```bash
docker exec openclaw-hardened curl -s http://matrix:11434/api/tags | head -c 100
# Should return JSON with model list
```

### Check Container Isolation

```bash
# Verify read-only root
docker exec openclaw-hardened touch /test 2>&1 | grep -q "Read-only" && echo "OK: Read-only root"

# Verify no capabilities
docker inspect openclaw-hardened --format '{{.HostConfig.CapDrop}}'
# Should show: [ALL]

# Verify resource limits
docker stats openclaw-hardened --no-stream --format "{{.MemLimit}}"
# Should show: 1GiB
```

### Check Firewall Rules

```bash
sudo iptables -L DOCKER-USER -n -v --line-numbers
```

Expected output shows ACCEPT for matrix:11434 and DROP for everything else.

## CLI Interaction

Enter the container for CLI access:

```bash
docker exec -it openclaw-hardened bash
```

Or run commands directly:

```bash
# Check status
docker exec openclaw-hardened node dist/index.mjs status

# List models
docker exec openclaw-hardened node dist/index.mjs models list

# Send a message
docker exec openclaw-hardened node dist/index.mjs agent --message "Hello"

# Check sandbox status
docker exec openclaw-hardened node dist/index.mjs sandbox list
docker exec openclaw-hardened node dist/index.mjs sandbox explain
```

## Security Layers

### Layer 1: Docker Network Isolation

The `openclaw-isolated` network is configured as `internal: true` with IP masquerade
disabled. Containers cannot route to external networks at the Docker level.

### Layer 2: iptables Firewall

The DOCKER-USER chain applies before Docker's NAT rules. Only traffic to
the Ollama endpoint is permitted; all other traffic is dropped.

### Layer 3: Container Hardening

- `read_only: true` - prevents filesystem modifications
- `cap_drop: ALL` - removes all Linux capabilities
- `security_opt: no-new-privileges` - prevents privilege escalation
- Resource limits prevent DoS

### Layer 4: Sandbox Isolation

Agent tool execution runs in nested containers with:

- No network access (`network: none`)
- Limited tools (read/write/edit only)
- No shell execution capability
- Separate filesystem namespace

### Layer 5: Tool Policy

The tool allow/deny policy restricts which tools the agent can invoke,
independent of sandbox settings.

## Troubleshooting

### Container Cannot Reach Ollama

1. Verify matrix IP in extra_hosts:

   ```bash
   docker exec openclaw-hardened cat /etc/hosts | grep matrix
   ```

2. Check firewall rules allow traffic:

   ```bash
   sudo iptables -L DOCKER-USER -n -v
   ```

3. Verify Ollama is running on matrix:
   ```bash
   ssh matrix curl -s http://localhost:11434/api/tags
   ```

### Firewall Rules Not Applied

The `openclaw-isolated` network must exist first:

```bash
docker compose -f docker-compose.hardened.yml up -d
./setup-openclaw-firewall.sh
```

### Models Not Found

Verify the model IDs match what Ollama reports:

```bash
ssh matrix ollama list
```

Update `openclaw.json` model IDs to match exactly.

## Rollback

Stop services and remove firewall rules:

```bash
# Stop containers
docker compose -f docker-compose.hardened.yml down

# Remove firewall rules (or just reboot)
./setup-openclaw-firewall.sh --remove

# Remove volumes (destroys data)
docker volume rm openclaw-workspace
```

## Related Docs

- [Sandboxing](/gateway/sandboxing) - sandbox configuration details
- [Local Models](/gateway/local-models) - Ollama and other local model setup
- [Configuration](/gateway/configuration) - full configuration reference
