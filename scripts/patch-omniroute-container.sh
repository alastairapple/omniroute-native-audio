#!/usr/bin/env bash
#
# patch-omniroute-container.sh
#
# Downloads the native-audio overlay files from the alastairapple repo, pulls the
# prebuilt ghcr image, and recreates ONLY the `omniroute` service from the
# compose file. No full OmniRoute clone, no local docker build.
#
# Usage:
#   ./patch-omniroute-container.sh [repo] [ref]
#
# Defaults:
#   repo = alastairapple/omniroute-native-audio
#   ref  = main
#
# Requires: docker, curl, gh (or GH_TOKEN for API reads)

set -euo pipefail

REPO="${1:-alastairapple/omniroute-native-audio}"
REF="${2:-main}"

IMAGE="ghcr.io/alastairapple/omniroute:native-audio"
COMPOSE_DIR="/root/omniroute-docker"
COMPOSE_FILE="${COMPOSE_DIR}/compose.yaml"
ENV_FILE="${COMPOSE_DIR}/omniroute.env"
SERVICE="omniroute"
HEALTH_URL="http://127.0.0.1:20128/api/monitoring/health"

# Paths mirrored in the overlay repo, mirroring their location in the OmniRoute tree.
OVERLAY_PATHS=(
  "open-sse/config/nativeAudioVoices.ts"
  "open-sse/config/audioRegistry.ts"
  "open-sse/executors/kokoroTts.ts"
  "open-sse/executors/edgeTts.ts"
  "open-sse/executors/mistralAudio.ts"
  "open-sse/handlers/audioSpeech.ts"
  "open-sse/handlers/audioTranscription.ts"
  "src/shared/constants/providers/noauth.ts"
  "src/app/(dashboard)/dashboard/cache/media/MediaPageClient.tsx"
  "src/app/api/v1/models/catalog.ts"
)

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m error:\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "docker not found"
command -v curl   >/dev/null || die "curl not found"
[ -f "$COMPOSE_FILE" ] || die "compose file not found: $COMPOSE_FILE"
[ -f "$ENV_FILE" ]     || die "env file not found: $ENV_FILE"

WORKDIR="$(mktemp -d /tmp/omniroute-patch.XXXXXX)"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 1. Download the overlay files (individual paths, not a full clone)
# ---------------------------------------------------------------------------
log "downloading overlay files from ${REPO}@${REF}"

api_get() {
  # api_get <repo> <ref> <path> -> raw content on stdout
  local repo="$1" ref="$2" path="$3"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    gh api "repos/${repo}/contents/${path}?ref=${ref}" -H "Accept: application/vnd.github.raw" 2>/dev/null
  else
    curl -fsSL -H "Authorization: Bearer ${GH_TOKEN}" \
      -H "Accept: application/vnd.github.raw" \
      "https://api.github.com/repos/${repo}/contents/${path}?ref=${ref}"
  fi
}

for p in "${OVERLAY_PATHS[@]}"; do
  mkdir -p "${WORKDIR}/overlay/$(dirname "$p")"
  # URL-encode the path for the API (the MediaPageClient path has parens/spaces).
  encoded="$(printf '%s' "$p" | sed -e 's/(/%28/g' -e 's/)/%29/g' -e 's/ /%20/g')"
  if ! api_get "$REPO" "$REF" "$encoded" > "${WORKDIR}/overlay/$p"; then
    die "failed to download $p from ${REPO}@${REF}"
  fi
  # Guard against an HTML error page being written as a .ts file.
  if head -c 20 "${WORKDIR}/overlay/$p" | grep -qi '<!DOCTYPE'; then
    die "downloaded an HTML page instead of source for $p (private repo needs auth)"
  fi
  echo "    got $p"
done

# ---------------------------------------------------------------------------
# 2. Pull the prebuilt image
# ---------------------------------------------------------------------------
log "pulling ${IMAGE}"
docker pull "$IMAGE"

# ---------------------------------------------------------------------------
# 3. Recreate only the omniroute service from the compose file
#
# Everything else in compose.yaml is preserved: env_file, the /root/.omniroute
# volume, host networking, user 0:0, mem_limit, and restart policy. The image is
# overridden via COMPOSE_FILE's image field being replaced by an override file,
# so we never rewrite the operator's compose.yaml in place.
# ---------------------------------------------------------------------------
log "pointing ${SERVICE} at the new image (override, compose.yaml untouched)"

cat > "${WORKDIR}/image-override.yaml" <<EOF
services:
  ${SERVICE}:
    image: ${IMAGE}
EOF

log "stopping ${SERVICE}"
docker compose -f "$COMPOSE_FILE" -f "${WORKDIR}/image-override.yaml" \
  stop "$SERVICE" 2>/dev/null || true

log "recreating ${SERVICE}"
docker compose -f "$COMPOSE_FILE" -f "${WORKDIR}/image-override.yaml" \
  up -d --no-deps --force-recreate "$SERVICE"

# ---------------------------------------------------------------------------
# 4. Wait for health
# ---------------------------------------------------------------------------
log "waiting for health at ${HEALTH_URL}"
healthy=0
for i in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL" || true)"
  if [ "$code" = "200" ]; then
    healthy=1
    echo "    healthy after ${i} attempt(s)"
    break
  fi
  sleep 2
done

if [ "$healthy" -ne 1 ]; then
  warn "health check did not reach 200; recent logs:"
  docker logs --tail 40 "$SERVICE" >&2 || true
  die "service did not become healthy"
fi

log "done — ${SERVICE} is healthy on the native-audio image"