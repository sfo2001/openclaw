#!/bin/bash
# Port forward to OpenClaw container on br0 network
# Provides localhost access for browser secure context (WebSocket)
#
# Usage: ./ssh-tunnel-tardis.sh
# Then open: http://localhost:18790

set -e

LOCAL_PORT="18790"
CONTAINER_IP="192.168.178.4"
CONTAINER_PORT="18789"

echo "Starting port forward to OpenClaw..."
echo "OpenClaw UI will be available at: http://localhost:$LOCAL_PORT"
echo "Press Ctrl+C to stop"
echo ""

socat TCP-LISTEN:${LOCAL_PORT},fork,reuseaddr TCP:${CONTAINER_IP}:${CONTAINER_PORT}
