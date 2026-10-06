#!/usr/bin/env bash
# Publish the current VERSION: build and push the multi-arch image to GHCR, then
# tag the commit. Run it from main after merging a VERSION bump.
#
#   ./release.sh
#
# Does nothing if v$VERSION is already tagged on origin, so it is safe to re-run.
# Needs Docker running and a gh token with the write:packages scope; once only:
#   gh auth refresh -h github.com -s write:packages
set -euo pipefail
cd "$(dirname "$0")"

IMAGE="ghcr.io/heyitsmiike101/mantel"
VERSION="$(tr -d '[:space:]' < VERSION)"
SERIES="${VERSION%.*}"

# Release the commit that is actually pushed, from a tree that matches it.
branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "main" ]; then
  echo "Releases are cut from main, but you are on '$branch'." >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is not clean. Commit or stash first." >&2
  exit 1
fi
git fetch --quiet origin main --tags
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "Local main is not the same as origin/main. Push (or pull) first." >&2
  exit 1
fi

if git ls-remote --exit-code --tags origin "refs/tags/v${VERSION}" >/dev/null 2>&1; then
  echo "Already released: v${VERSION}. Nothing to publish."
  exit 0
fi
echo "New version: v${VERSION}. Publishing."

if ! docker info >/dev/null 2>&1; then
  echo "Cannot reach the Docker daemon. Start Docker Desktop and try again." >&2
  exit 1
fi

# The gh token must be able to push packages; check before building for ten minutes.
if ! gh auth status 2>&1 | grep -q "write:packages"; then
  echo "The gh token lacks the write:packages scope. Run this once, then retry:" >&2
  echo "  gh auth refresh -h github.com -s write:packages" >&2
  exit 1
fi
gh auth token | docker login ghcr.io -u "$(gh api user --jq .login)" --password-stdin

# QEMU provides the arm64 leg; the frontend stage pins itself to BUILDPLATFORM,
# so only the Python layer is emulated.
if ! docker buildx ls | grep -q "linux/arm64"; then
  echo "Installing arm64 emulation..."
  docker run --privileged --rm tonistiigi/binfmt --install arm64
fi

./build.sh --push "$IMAGE"

# Tag only after the push succeeded, so a failed build never leaves a release tag.
git tag -a "v${VERSION}" -m "Release v${VERSION}"
git push origin "v${VERSION}"

echo
echo "Released v${VERSION}"
echo "  ${IMAGE}:${VERSION}"
echo "  ${IMAGE}:${SERIES}"
echo "  ${IMAGE}:latest"
