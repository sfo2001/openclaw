#!/bin/bash
# Build and push OpenClaw hardened images to private registry
#
# Usage:
#   ./scripts/build-and-push.sh                    # Push as :latest
#   ./scripts/build-and-push.sh --tag 2026-02-01   # Push with specific tag
#   ./scripts/build-and-push.sh --sandbox-only     # Only push sandbox image

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Registry configuration
REGISTRY="192.168.178.72:5000"
MAIN_IMAGE="openclaw-hardened"
SANDBOX_IMAGE="openclaw-sandbox"

# Default tag
TAG="latest"
SANDBOX_ONLY=false
MAIN_ONLY=false

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

usage() {
    cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Build and push OpenClaw images to private registry ($REGISTRY).

Options:
  -t, --tag TAG       Tag for images (default: latest)
  --sandbox-only      Only build/push sandbox image
  --main-only         Only build/push main image
  --no-cache          Build without cache
  -h, --help          Show this help

Examples:
  $(basename "$0")                           # Build and push all as :latest
  $(basename "$0") --tag \$(date +%Y-%m-%d)   # Tag with date
  $(basename "$0") --sandbox-only            # Only sandbox image

EOF
}

NO_CACHE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        -t|--tag)
            TAG="$2"
            shift 2
            ;;
        --sandbox-only)
            SANDBOX_ONLY=true
            shift
            ;;
        --main-only)
            MAIN_ONLY=true
            shift
            ;;
        --no-cache)
            NO_CACHE="--no-cache"
            shift
            ;;
        -h|--help)
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

cd "$PROJECT_DIR"

# Build and push sandbox image
build_sandbox() {
    log_info "Building sandbox image..."

    if [[ ! -f "scripts/sandbox-setup.sh" ]]; then
        log_error "sandbox-setup.sh not found"
        exit 1
    fi

    # Build sandbox using existing script
    ./scripts/sandbox-setup.sh

    # Tag for registry (sandbox-setup.sh builds as :bookworm-slim)
    local local_tag="openclaw-sandbox:bookworm-slim"
    local remote_tag="${REGISTRY}/${SANDBOX_IMAGE}:${TAG}"

    log_info "Tagging: $local_tag -> $remote_tag"
    docker tag "$local_tag" "$remote_tag"

    log_info "Pushing: $remote_tag"
    docker push "$remote_tag"

    # Also tag as latest if not already
    if [[ "$TAG" != "latest" ]]; then
        local latest_tag="${REGISTRY}/${SANDBOX_IMAGE}:latest"
        docker tag "$local_tag" "$latest_tag"
        docker push "$latest_tag"
    fi

    log_info "Sandbox image pushed successfully"
}

# Build and push main image
build_main() {
    log_info "Building main image..."

    local local_tag="openclaw:local"
    local remote_tag="${REGISTRY}/${MAIN_IMAGE}:${TAG}"

    docker build $NO_CACHE -t "$local_tag" .

    log_info "Tagging: $local_tag -> $remote_tag"
    docker tag "$local_tag" "$remote_tag"

    log_info "Pushing: $remote_tag"
    docker push "$remote_tag"

    # Also tag as latest if not already
    if [[ "$TAG" != "latest" ]]; then
        local latest_tag="${REGISTRY}/${MAIN_IMAGE}:latest"
        docker tag "$local_tag" "$latest_tag"
        docker push "$latest_tag"
    fi

    log_info "Main image pushed successfully"
}

# Main execution
log_info "Registry: $REGISTRY"
log_info "Tag: $TAG"
echo ""

if [[ "$SANDBOX_ONLY" == "true" ]]; then
    build_sandbox
elif [[ "$MAIN_ONLY" == "true" ]]; then
    build_main
else
    build_sandbox
    echo ""
    build_main
fi

echo ""
log_info "Build complete!"
echo ""
echo "To deploy on TARDIS:"
echo "  docker pull ${REGISTRY}/${MAIN_IMAGE}:${TAG}"
echo "  docker pull ${REGISTRY}/${SANDBOX_IMAGE}:${TAG}"
echo "  docker-compose -f docker-compose.unraid.yml up -d --force-recreate"
