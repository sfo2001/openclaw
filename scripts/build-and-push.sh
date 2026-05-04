#!/bin/bash
# Build and push openclaw-hardened:lean image to private registry.
#
# Tardis-lean deployment toolchain. Successor to the older multi-image
# script (deploy/tardis-hardened) which also built openclaw-sandbox and
# openclaw-vault — both retired in the lean deployment (sandbox.mode is
# off in openclaw.json, the Vault sidecar was dropped on 2026-04-11).
#
# The lean runtime base is node:24-bookworm-slim, which omits a number of
# tools the full bookworm image includes by default. We restore the ones
# needed at runtime via the OPENCLAW_DOCKER_APT_PACKAGES build arg:
#
#   - openssh-client  : git push over ssh (the auto-commit hook in
#                       /home/node/clawd/scripts/auto-commit.sh uses ssh
#                       to push to git@192.168.178.3:stefan/openclaw-persona-seven.git)
#   - vim-tiny        : in-container debugging / human edits
#   - less            : pager for log inspection
#
# Pass --apt "..." to override this list.
#
# Usage:
#   ./scripts/build-and-push.sh                  # Build+push as :lean
#   ./scripts/build-and-push.sh --tag 2026-05-04 # Custom tag
#   ./scripts/build-and-push.sh --no-cache       # Force fresh build
#   ./scripts/build-and-push.sh --apt "openssh-client vim-tiny less jq"
#   ./scripts/build-and-push.sh --no-deploy      # Build+push only, skip deploy command print

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Registry configuration (matches openclaw-autorouter convention)
REGISTRY="${REGISTRY:-192.168.178.72:5000}"
MAIN_IMAGE="openclaw-hardened"

# Default tag — matches what tardis docker-compose.tardis.yml references
TAG="lean"
NO_CACHE=""
PRINT_DEPLOY=true

# Default apt packages baked into the runtime image to make the slim base
# practical for the tardis deployment. Override with --apt.
APT_PACKAGES_DEFAULT="openssh-client vim-tiny less"
APT_PACKAGES=""

# Optional: install the lobster CLI inside the image (legacy hook from the
# pre-lean deployment). Skipped when LOBSTER_REGISTRY is empty.
LOBSTER_REGISTRY="${LOBSTER_REGISTRY:-}"
LOBSTER_VERSION="${LOBSTER_VERSION:-latest}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

usage() {
    cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Build and push openclaw-hardened:<tag> to ${REGISTRY}.

Options:
  -t, --tag TAG       Image tag (default: lean — matches the running container)
  --apt "PACKAGES"    Override OPENCLAW_DOCKER_APT_PACKAGES build arg
                      (default: "$APT_PACKAGES_DEFAULT")
  --no-cache          Build without cache
  --no-deploy         Skip printing the deploy command at the end
  -h, --help          Show this help

Environment overrides:
  REGISTRY            Override registry (default: $REGISTRY)
  LOBSTER_REGISTRY    If set, the build also installs the lobster CLI from
                      this private npm registry (skipped if empty)
  LOBSTER_VERSION     Lobster CLI version to install (default: latest)

Example:
  REGISTRY=192.168.178.72:5000 ./scripts/build-and-push.sh --tag lean
  ./scripts/build-and-push.sh --apt "openssh-client vim-tiny less ffmpeg"

After build+push, deploy on tardis:
  ssh tardis 'docker pull ${REGISTRY}/${MAIN_IMAGE}:lean && \\
    cd /mnt/user/appdata/openclaw && \\
    docker compose -f docker-compose.tardis.yml up -d --force-recreate'
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -t|--tag)        TAG="$2"; shift 2 ;;
        --apt)           APT_PACKAGES="$2"; shift 2 ;;
        --no-cache)      NO_CACHE="--no-cache"; shift ;;
        --no-deploy)     PRINT_DEPLOY=false; shift ;;
        -h|--help)       usage; exit 0 ;;
        *)               log_error "Unknown option: $1"; usage; exit 1 ;;
    esac
done

APT_PACKAGES="${APT_PACKAGES:-$APT_PACKAGES_DEFAULT}"

cd "$PROJECT_DIR"

local_tag="openclaw:local"
remote_tag="${REGISTRY}/${MAIN_IMAGE}:${TAG}"

log_info "Registry:     $REGISTRY"
log_info "Image tag:    $TAG"
log_info "APT packages: $APT_PACKAGES"
[[ -n "$NO_CACHE" ]]         && log_info "Cache:        disabled (--no-cache)"
[[ -n "$LOBSTER_REGISTRY" ]] && log_info "Lobster:      $LOBSTER_REGISTRY @ $LOBSTER_VERSION"
echo

# Resolve a concrete lobster version if a registry is supplied. Done before
# `docker build` so a moving "latest" tag busts the lobster install cache.
LOBSTER_RESOLVED_VERSION="$LOBSTER_VERSION"
if [[ -n "$LOBSTER_REGISTRY" ]] && [[ "$LOBSTER_VERSION" == "latest" ]]; then
    if command -v npm >/dev/null 2>&1; then
        LOBSTER_RESOLVED_VERSION=$(npm view @clawdbot/lobster version --registry="$LOBSTER_REGISTRY" 2>/dev/null) \
            || LOBSTER_RESOLVED_VERSION="latest"
        log_info "Lobster version resolved: $LOBSTER_RESOLVED_VERSION"
    fi
fi

log_info "Building image..."
docker build $NO_CACHE \
    --build-arg OPENCLAW_DOCKER_APT_PACKAGES="$APT_PACKAGES" \
    --build-arg LOBSTER_REGISTRY="$LOBSTER_REGISTRY" \
    --build-arg LOBSTER_VERSION="$LOBSTER_RESOLVED_VERSION" \
    -t "$local_tag" .

log_info "Tagging:  $local_tag -> $remote_tag"
docker tag "$local_tag" "$remote_tag"

log_info "Pushing:  $remote_tag"
docker push "$remote_tag"

echo
log_info "Build + push complete."

if $PRINT_DEPLOY; then
    echo
    cat <<EOF
To deploy on tardis:
  ssh tardis 'docker pull ${remote_tag} && \\
    cd /mnt/user/appdata/openclaw && \\
    docker compose -f docker-compose.tardis.yml up -d --force-recreate'

Verify after restart (from this host):
  ssh tardis 'docker exec OpenClaw which ssh'           # → /usr/bin/ssh
  ssh tardis 'docker exec OpenClaw which less vim.tiny' # → /usr/bin/less, vim.tiny
  ssh tardis 'docker exec OpenClaw bash /home/node/clawd/scripts/auto-commit.sh'
EOF
fi
