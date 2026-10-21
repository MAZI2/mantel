#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# Dedicated builder owns this workflow's build cache, so cleanup needs no global prune.
builder=mantel-local-preview-builder
export BUILDX_BUILDER="$builder"
export LOCAL_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
compose=(docker compose --env-file /dev/null -p mantel-local-preview -f compose.local.yml)

ensure_builder() {
  if ! docker buildx inspect "$builder" >/dev/null 2>&1; then
    docker buildx create --name "$builder" --driver docker-container >/dev/null
  fi
}

up() {
  ensure_builder
  "${compose[@]}" build app
  "${compose[@]}" up -d --wait app
  echo "Local preview: http://localhost:${LOCAL_PORT:-8081}"
}

case "${1:-up}" in
  up) up ;;
  test)
    up
    "${compose[@]}" --profile test build frontend-tests backend-tests browser-tests
    "${compose[@]}" run --rm --no-deps frontend-tests
    "${compose[@]}" run --rm --no-deps backend-tests
    "${compose[@]}" run --rm --no-deps browser-tests
    ;;
  logs) "${compose[@]}" logs -f app ;;
  status) "${compose[@]}" ps ;;
  stop) "${compose[@]}" stop ;;
  clean)
    # Only this Compose project, its test database, images and dedicated builder/cache.
    "${compose[@]}" --profile test down --volumes --rmi all --remove-orphans
    # Rebuilds leave older image IDs without tags. Compose labels still identify them.
    mapfile -t old_images < <(docker image ls -aq --filter label=com.docker.compose.project=mantel-local-preview)
    if ((${#old_images[@]})); then
      docker image rm "${old_images[@]}"
    fi
    if docker buildx inspect "$builder" >/dev/null 2>&1; then
      docker buildx rm "$builder"
    fi
    ;;
  *) echo "Usage: $0 {up|test|logs|status|stop|clean}" >&2; exit 2 ;;
esac
