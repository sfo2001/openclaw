#!/bin/bash
# Attach OpenClaw container to the default bridge network so it can
# reach host services (e.g. Home Assistant) via host.docker.internal.
# Required because ipvlan (br0) containers cannot reach their own host.
#
# Install on Unraid:
#   Copy to /boot/config/plugins/user.scripts/scripts/openclaw-bridge-network/script
#   Set schedule to "At Startup of Array" in User Scripts plugin

CONTAINER=OpenClaw
MAX_WAIT=60
WAITED=0

while ! docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; do
  sleep 2
  WAITED=$((WAITED + 2))
  if [ $WAITED -ge $MAX_WAIT ]; then
    echo "ERROR: $CONTAINER not running after ${MAX_WAIT}s, giving up"
    exit 1
  fi
done

if docker inspect -f '{{json .NetworkSettings.Networks}}' "$CONTAINER" | grep -q '"bridge"'; then
  echo "$CONTAINER already connected to bridge network"
else
  docker network connect bridge "$CONTAINER"
  echo "SUCCESS: Connected $CONTAINER to bridge network"
fi
