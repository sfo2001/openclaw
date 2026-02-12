#!/bin/bash
# Connect SearXNG to the vault-external network so the OpenClaw gateway
# can reach it by hostname. Required because SearXNG runs outside the
# compose stack (Unraid GUI container) on the default bridge network.
#
# Install on Unraid:
#   Copy to /boot/config/plugins/user.scripts/scripts/openclaw-bridge-network/script
#   Set schedule to "At Startup of Array" in User Scripts plugin

NETWORK="openclaw_vault-external"
CONTAINER="SearXNG"
MAX_WAIT=120
WAITED=0

# Wait for both the network and container to exist
while true; do
  if docker network inspect "$NETWORK" >/dev/null 2>&1 && \
     docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
    break
  fi
  sleep 5
  WAITED=$((WAITED + 5))
  if [ $WAITED -ge $MAX_WAIT ]; then
    echo "ERROR: $NETWORK or $CONTAINER not ready after ${MAX_WAIT}s"
    exit 1
  fi
done

if docker inspect -f '{{json .NetworkSettings.Networks}}' "$CONTAINER" | grep -q "$NETWORK"; then
  echo "$CONTAINER already connected to $NETWORK"
else
  docker network connect --alias searxng "$NETWORK" "$CONTAINER"
  echo "SUCCESS: Connected $CONTAINER to $NETWORK"
fi
