#!/bin/bash
# openclaw-hardened.sh - Interact with hardened OpenClaw deployment
#
# Usage:
#   ./scripts/openclaw-hardened.sh --message "Hello"
#   ./scripts/openclaw-hardened.sh --list
#   ./scripts/openclaw-hardened.sh --status
#   ./scripts/openclaw-hardened.sh --help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.hardened.yml"
CONFIG_FILE="$PROJECT_DIR/config/openclaw.json"
CONTAINER_NAME="openclaw-hardened"

# Gateway auth token (read from config or use default)
GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-9c154ccbc8695f8c063ed1c682d8eed0}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

usage() {
    cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Interact with the hardened OpenClaw deployment using local Ollama models.

Options:
  -m, --message MSG    Send a message to the agent
  -l, --list           List available models
  -s, --status         Show gateway status
  -h, --health         Check gateway health
  --start              Start the hardened container
  --stop               Stop the hardened container
  --logs               Show container logs
  --firewall           Apply firewall rules
  --devices            List pending and paired devices
  --pair-approve [ID]  Approve a pending pairing request (first if no ID)
  --help               Show this help message

Environment:
  OPENCLAW_GATEWAY_TOKEN    Gateway auth token (default: from config)

Examples:
  $(basename "$0") --message "What can you help me with?"
  $(basename "$0") --list
  $(basename "$0") --start && $(basename "$0") --firewall
  $(basename "$0") --devices                    # List pairing requests
  $(basename "$0") --pair-approve               # Approve first pending request
  $(basename "$0") --pair-approve <request-id>  # Approve specific request

EOF
}

log_info() {
    echo -e "${GREEN}[INFO]${NC} $*"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $*"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $*" >&2
}

check_docker() {
    if ! command -v docker &>/dev/null; then
        log_error "Docker is not installed"
        exit 1
    fi

    if ! docker info &>/dev/null; then
        log_error "Docker daemon is not running or you lack permissions"
        log_info "Try: sudo usermod -aG docker \$USER && newgrp docker"
        exit 1
    fi
}

check_compose_file() {
    if [[ ! -f "$COMPOSE_FILE" ]]; then
        log_error "Compose file not found: $COMPOSE_FILE"
        log_info "Run from the openclaw project directory"
        exit 1
    fi
}

check_config() {
    if [[ ! -f "$CONFIG_FILE" ]]; then
        log_warn "Config file not found: $CONFIG_FILE"
        log_info "Creating config directory and copying from ~/.openclaw/openclaw.json"
        mkdir -p "$(dirname "$CONFIG_FILE")"
        if [[ -f ~/.openclaw/openclaw.json ]]; then
            cp ~/.openclaw/openclaw.json "$CONFIG_FILE"
        else
            log_error "No config file found. Create ~/.openclaw/openclaw.json first"
            exit 1
        fi
    fi
}

is_container_running() {
    docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER_NAME}$"
}

ensure_container_running() {
    if ! is_container_running; then
        log_warn "Container not running. Starting..."
        start_container
        log_info "Waiting for gateway to be ready..."
        sleep 3

        # Wait for health
        local retries=10
        while ((retries > 0)); do
            if docker exec "$CONTAINER_NAME" node dist/index.js gateway health &>/dev/null; then
                log_info "Gateway is ready"
                return 0
            fi
            ((retries--))
            sleep 1
        done

        log_error "Gateway failed to start. Check logs: $0 --logs"
        exit 1
    fi
}

start_container() {
    check_compose_file
    check_config

    log_info "Starting hardened container..."

    # Use docker-compose or docker compose
    if command -v docker-compose &>/dev/null; then
        docker-compose -f "$COMPOSE_FILE" up -d
    else
        docker compose -f "$COMPOSE_FILE" up -d
    fi

    log_info "Container started"
    log_warn "Remember to apply firewall rules: $0 --firewall"
}

stop_container() {
    check_compose_file

    log_info "Stopping hardened container..."

    if command -v docker-compose &>/dev/null; then
        docker-compose -f "$COMPOSE_FILE" down
    else
        docker compose -f "$COMPOSE_FILE" down
    fi

    log_info "Container stopped"
}

show_logs() {
    docker logs "$CONTAINER_NAME" --tail 50
}

apply_firewall() {
    local firewall_script="$PROJECT_DIR/setup-openclaw-firewall.sh"

    if [[ ! -x "$firewall_script" ]]; then
        log_error "Firewall script not found or not executable: $firewall_script"
        exit 1
    fi

    log_info "Applying firewall rules (requires sudo)..."
    sudo "$firewall_script"
}

gateway_health() {
    ensure_container_running
    docker exec "$CONTAINER_NAME" node dist/index.js gateway health
}

gateway_status() {
    ensure_container_running
    docker exec "$CONTAINER_NAME" node dist/index.js status
}

list_models() {
    ensure_container_running
    docker exec "$CONTAINER_NAME" node dist/index.js models list
}

send_message() {
    local message="$1"

    ensure_container_running

    docker exec -it \
        -e "OPENCLAW_GATEWAY_TOKEN=$GATEWAY_TOKEN" \
        "$CONTAINER_NAME" \
        node dist/index.js agent --agent main --message "$message"
}

list_devices() {
    ensure_container_running
    docker exec "$CONTAINER_NAME" node dist/index.js devices list
}

pair_approve() {
    local request_id="${1:-}"

    ensure_container_running

    if [[ -z "$request_id" ]]; then
        # Get first pending request ID
        request_id=$(docker exec "$CONTAINER_NAME" node dist/index.js devices list --json 2>/dev/null \
            | jq -r '.pending[0].requestId // empty' 2>/dev/null)

        if [[ -z "$request_id" ]]; then
            log_warn "No pending pairing requests"
            return 0
        fi
        log_info "Auto-selecting first pending request: $request_id"
    fi

    docker exec "$CONTAINER_NAME" node dist/index.js devices approve "$request_id"
    log_info "Device pairing approved"
}

# Parse arguments
if [[ $# -eq 0 ]]; then
    usage
    exit 0
fi

check_docker

while [[ $# -gt 0 ]]; do
    case "$1" in
        -m|--message)
            if [[ -z "${2:-}" ]]; then
                log_error "Missing message argument"
                exit 1
            fi
            send_message "$2"
            shift 2
            ;;
        -l|--list)
            list_models
            shift
            ;;
        -s|--status)
            gateway_status
            shift
            ;;
        -h|--health)
            gateway_health
            shift
            ;;
        --start)
            start_container
            shift
            ;;
        --stop)
            stop_container
            shift
            ;;
        --logs)
            show_logs
            shift
            ;;
        --firewall)
            apply_firewall
            shift
            ;;
        --devices)
            list_devices
            shift
            ;;
        --pair-approve)
            pair_approve "${2:-}"
            shift
            # Shift again if a request ID was provided
            if [[ -n "${1:-}" && "$1" != --* ]]; then
                shift
            fi
            ;;
        --help)
            usage
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            usage
            exit 1
            ;;
    esac
done
