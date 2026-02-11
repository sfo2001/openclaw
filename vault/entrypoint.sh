#!/bin/sh
# Vault sidecar entrypoint: decrypt secrets, render nginx config, start proxy.
#
# Expects:
#   AGE_SECRET_KEY          - age private key (from .env on host, 0600 root-owned)
#   /etc/vault.age          - age-encrypted secrets file (bind-mounted, read-only)
#   /etc/nginx/nginx.conf.template - nginx config template with ${VAR} placeholders
#   /run/secrets/           - tmpfs mount (volatile, never persisted to disk)
#
# Secret variables are discovered dynamically from the nginx template.
# Adding a new provider only requires editing two files:
#   1. vault/nginx.conf.template: add a server block with ${SECRET_VAR} placeholder
#   2. src/vault/operations.ts: add the entry to VAULT_PROVIDER_DEFAULTS
set -eu

VAULT_AGE="/etc/vault.age"
TEMPLATE="/etc/nginx/nginx.conf.template"
SECRETS_DIR="/run/secrets"

# Validate required inputs
if [ -z "${AGE_SECRET_KEY:-}" ]; then
  echo "ERROR: AGE_SECRET_KEY not set" >&2
  exit 1
fi

if [ ! -f "$VAULT_AGE" ]; then
  echo "ERROR: $VAULT_AGE not found" >&2
  exit 1
fi

if [ ! -f "$TEMPLATE" ]; then
  echo "ERROR: $TEMPLATE not found" >&2
  exit 1
fi

# Extract secret variable names from the nginx template.
# Matches ${UPPER_CASE_NAMES} only — skips nginx builtins ($host,
# $http_upgrade, $remote_addr, etc.) which are lowercase or use $ without braces.
SECRET_VARS=$(grep -oE '\$\{[A-Z][A-Z0-9_]*\}' "$TEMPLATE" | sort -u)

if [ -z "$SECRET_VARS" ]; then
  echo "ERROR: No secret variables found in $TEMPLATE" >&2
  exit 1
fi

# Build envsubst argument string (space-separated ${VAR} references)
ENVSUBST_ARGS=$(printf '%s ' $SECRET_VARS)

# Decrypt secrets to temporary env file on tmpfs
echo "$AGE_SECRET_KEY" | age -d -i - "$VAULT_AGE" > "$SECRETS_DIR/env"
unset AGE_SECRET_KEY

# Parse secrets line-by-line and export as environment variables.
# Uses IFS-based read instead of shell sourcing to prevent command injection
# via crafted secret values (e.g. values containing $(...) or backticks).
# Tracks which vars came from the vault file so only those are unset later
# (compose environment vars like HA_UPSTREAM_URL must survive).
VAULT_VARS=""
while IFS='=' read -r key value; do
  # Skip blank lines and comments
  case "$key" in
    ''|'#'*) continue ;;
  esac
  # Validate secret name: must be [A-Z][A-Z0-9_]* to prevent env hijacking
  # (e.g. PATH, LD_PRELOAD). Mirrors VALID_SECRET_NAME in vault-cli.ts.
  case "$key" in
    [A-Z]*) ;; # starts with uppercase — check rest below
    *) echo "WARNING: skipping invalid secret name: $key" >&2; continue ;;
  esac
  # shellcheck disable=SC2254
  case "$key" in
    *[!A-Z0-9_]*) echo "WARNING: skipping invalid secret name: $key" >&2; continue ;;
  esac
  export "$key=$value"
  VAULT_VARS="$VAULT_VARS $key"
done < "$SECRETS_DIR/env"

# Validate: warn about all template variables missing from environment.
# Non-fatal — allows partial deployments (some providers unconfigured).
MISSING=""
for var_ref in $SECRET_VARS; do
  var=$(echo "$var_ref" | tr -d '${}')
  if [ -z "$(printenv "$var" 2>/dev/null || true)" ]; then
    MISSING="$MISSING $var"
  fi
done
if [ -n "$MISSING" ]; then
  echo "WARNING: Missing secrets for template variables:$MISSING" >&2
  echo "WARNING: Proxy requests for these providers will fail with 401 errors." >&2
fi

# Render nginx config with secrets injected.
# Explicit variable list prevents envsubst from replacing nginx variables
# like $http_upgrade, $host, etc.
envsubst "$ENVSUBST_ARGS" < "$TEMPLATE" > "$SECRETS_DIR/nginx.conf"

# Wipe plaintext secrets (now embedded in rendered nginx.conf on tmpfs).
# Only unset vars that came from vault.age — compose environment vars
# (e.g. HA_UPSTREAM_URL) are not secrets and must remain available.
rm -f "$SECRETS_DIR/env"
for var in $VAULT_VARS; do
  unset "$var" 2>/dev/null || true
done

# Lock down rendered config (contains plaintext secrets).
chmod 0400 "$SECRETS_DIR/nginx.conf"

echo "SUCCESS: Secrets decrypted, starting nginx reverse proxy"
# Master process runs as root to open log fds (/dev/stderr, /dev/stdout)
# and bind ports, then drops to 'user nginx' for worker processes via
# the nginx.conf 'user' directive. This is nginx's standard privilege model.
exec nginx -c "$SECRETS_DIR/nginx.conf" -g 'daemon off;'
