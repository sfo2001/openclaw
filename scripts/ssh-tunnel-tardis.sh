#!/bin/bash
# SSH tunnel to OpenClaw gateway on TARDIS.
# Provides localhost access for browser secure context (WebSocket).
#
# Usage: ./ssh-tunnel-tardis.sh
# Then open: http://localhost:18790

set -e

LOCAL_PORT="18790"
REMOTE_PORT="18790"

echo "Starting SSH tunnel to OpenClaw on TARDIS..."
echo "OpenClaw UI will be available at: http://localhost:$LOCAL_PORT"
echo "Press Ctrl+C to stop"
echo ""

ssh -NL "${LOCAL_PORT}:localhost:${REMOTE_PORT}" tardis
