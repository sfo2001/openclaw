#!/bin/bash
# Temporary firewall rules for OpenClaw - cleared on reboot
# Allows only Ollama traffic to matrix server + Brave Search API, drops everything else
#
# Prerequisites:
#   - Docker network openclaw-isolated must exist (run docker compose first)
#   - matrix hostname must be resolvable
#
# Usage:
#   ./setup-openclaw-firewall.sh
#
# To remove rules manually:
#   ./setup-openclaw-firewall.sh --remove

set -euo pipefail

OLLAMA_PORT=11434
COMMENT_TAG="openclaw-hardened"

# Brave Search API uses AWS Global Accelerator
# https://docs.aws.amazon.com/global-accelerator/latest/dg/introduction-ip-ranges.html
BRAVE_API_RANGES=(
    "3.33.128.0/17"      # AWS Global Accelerator
    "15.197.128.0/17"    # AWS Global Accelerator
)

remove_rules() {
    echo "Removing OpenClaw firewall rules..."
    # Remove rules by comment (may need multiple passes if duplicates exist)
    for _ in 1 2 3 4 5; do
        sudo iptables -D DOCKER-USER -m comment --comment "${COMMENT_TAG}-allow-out" 2>/dev/null || true
        sudo iptables -D DOCKER-USER -m comment --comment "${COMMENT_TAG}-allow-in" 2>/dev/null || true
        sudo iptables -D DOCKER-USER -m comment --comment "${COMMENT_TAG}-brave" 2>/dev/null || true
        sudo iptables -D DOCKER-USER -m comment --comment "${COMMENT_TAG}-https" 2>/dev/null || true
        sudo iptables -D DOCKER-USER -m comment --comment "${COMMENT_TAG}-dns" 2>/dev/null || true
        sudo iptables -D DOCKER-USER -m comment --comment "${COMMENT_TAG}-drop" 2>/dev/null || true
    done
    echo "Rules removed."
}

if [[ "${1:-}" == "--remove" ]]; then
    remove_rules
    exit 0
fi

# Resolve matrix IP (prefer IPv4 for iptables compatibility)
MATRIX_IP=$(getent ahostsv4 matrix | awk 'NR==1 {print $1}')
if [[ -z "$MATRIX_IP" ]]; then
    echo "ERROR: Cannot resolve 'matrix' hostname"
    echo "Add matrix to /etc/hosts or configure DNS"
    exit 1
fi

# Get Docker network interface for openclaw-isolated
NETWORK_ID=$(docker network inspect openclaw_openclaw-isolated -f '{{.Id}}' 2>/dev/null | cut -c1-12)
if [[ -z "$NETWORK_ID" ]]; then
    echo "ERROR: openclaw_openclaw-isolated network not found"
    echo "Run: docker compose -f docker-compose.hardened.yml up -d"
    exit 1
fi

DOCKER_IF="br-${NETWORK_ID}"

# Verify interface exists
if ! ip link show "$DOCKER_IF" &>/dev/null; then
    echo "ERROR: Docker interface $DOCKER_IF not found"
    echo "Network may not be active. Start containers first."
    exit 1
fi

echo "Configuration:"
echo "  Matrix IP:        $MATRIX_IP"
echo "  Ollama port:      $OLLAMA_PORT"
echo "  Docker interface: $DOCKER_IF"
echo ""

# Remove existing rules first to avoid duplicates
remove_rules

echo "Applying TEMPORARY firewall rules (cleared on reboot)..."

# Allow outbound to Ollama
sudo iptables -I DOCKER-USER -i "$DOCKER_IF" -d "$MATRIX_IP" -p tcp --dport "$OLLAMA_PORT" -j ACCEPT \
    -m comment --comment "${COMMENT_TAG}-allow-out"

# Allow established/related return traffic
sudo iptables -I DOCKER-USER -i "$DOCKER_IF" -s "$MATRIX_IP" -p tcp --sport "$OLLAMA_PORT" \
    -m state --state ESTABLISHED,RELATED -j ACCEPT \
    -m comment --comment "${COMMENT_TAG}-allow-in"

# Allow DNS to Cloudflare (1.1.1.1, 1.0.0.1) for hostname resolution
sudo iptables -I DOCKER-USER -i "$DOCKER_IF" -d 1.1.1.1 -p udp --dport 53 -j ACCEPT \
    -m comment --comment "${COMMENT_TAG}-dns"
sudo iptables -I DOCKER-USER -i "$DOCKER_IF" -d 1.0.0.1 -p udp --dport 53 -j ACCEPT \
    -m comment --comment "${COMMENT_TAG}-dns"

# Allow HTTPS to AWS Global Accelerator ranges (Brave Search API)
for range in "${BRAVE_API_RANGES[@]}"; do
    sudo iptables -I DOCKER-USER -i "$DOCKER_IF" -d "$range" -p tcp --dport 443 -j ACCEPT \
        -m comment --comment "${COMMENT_TAG}-brave"
done

# Allow general HTTPS for web_fetch tool
sudo iptables -I DOCKER-USER -i "$DOCKER_IF" -p tcp --dport 443 -j ACCEPT \
    -m comment --comment "${COMMENT_TAG}-https"

# Drop all other traffic from the isolated network
sudo iptables -A DOCKER-USER -i "$DOCKER_IF" -j DROP \
    -m comment --comment "${COMMENT_TAG}-drop"

echo ""
echo "Firewall rules applied successfully."
echo "OpenClaw containers can reach:"
echo "  - Ollama: $MATRIX_IP:$OLLAMA_PORT"
echo "  - DNS: 1.1.1.1, 1.0.0.1 (UDP 53)"
echo "  - HTTPS: all destinations (port 443) for web_fetch"
echo "  - Brave Search: AWS Global Accelerator ranges (HTTPS 443)"
echo "Rules are TEMPORARY and will be cleared on reboot."
echo ""
echo "Current DOCKER-USER rules:"
sudo iptables -L DOCKER-USER -n -v --line-numbers | head -20
echo ""
echo "To remove rules manually: $0 --remove"
