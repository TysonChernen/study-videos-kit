#!/bin/bash
# One-paste setup for Mac and Linux. Nothing needs to be installed first.
#
#   curl -fsSL https://raw.githubusercontent.com/TysonChernen/study-videos-kit/main/setup.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/TysonChernen/study-videos-kit/main/setup.sh | bash -s -- --brightspace https://learn.myschool.edu
#
# 1. Downloads the kit to ~/study-videos-kit (or updates it).
# 2. Uses your Node.js if it is 18 or newer; otherwise downloads a private copy of
#    Node into the kit folder (no admin password, nothing installed system-wide).
# 3. Runs install.mjs, which adds the tools to your AI apps.
set -euo pipefail

REPO="TysonChernen/study-videos-kit"
KIT="${STUDY_VIDEOS_KIT:-$HOME/study-videos-kit}"
RUNTIME="$KIT/.runtime"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Study videos kit setup"

# ── 1. The kit ───────────────────────────────────────────────────────────────
if [ -d "$KIT/.git" ] && command -v git >/dev/null 2>&1; then
  echo "  Updating $KIT"
  git -C "$KIT" pull -q --ff-only || echo "  (could not update; using the copy you have)"
else
  echo "  Downloading the kit to $KIT"
  curl -fsSL "https://github.com/$REPO/archive/refs/heads/main.zip" -o "$TMP/kit.zip"
  unzip -q "$TMP/kit.zip" -d "$TMP"
  mkdir -p "$KIT"
  cp -R "$TMP"/study-videos-kit-main/. "$KIT"/
fi

# ── 2. Node.js ───────────────────────────────────────────────────────────────
NODE=""
if [ -x "$RUNTIME/node/bin/node" ]; then
  NODE="$RUNTIME/node/bin/node"
elif [ -z "${FORCE_PRIVATE_NODE:-}" ] && command -v node >/dev/null 2>&1 \
     && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ]; then
  NODE="$(command -v node)"
fi

if [ -z "$NODE" ]; then
  case "$(uname -s)" in Darwin) OS=darwin ;; Linux) OS=linux ;; *) echo "Unsupported system: $(uname -s)"; exit 1 ;; esac
  case "$(uname -m)" in arm64|aarch64) ARCH=arm64 ;; x86_64|amd64) ARCH=x64 ;; *) echo "Unsupported CPU: $(uname -m)"; exit 1 ;; esac
  BASE="https://nodejs.org/dist/latest-v22.x"
  echo "  Node.js not found. Downloading a private copy for $OS-$ARCH (about 50 MB)..."
  curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  FILE="$(grep -o "node-v[0-9.]*-$OS-$ARCH.tar.gz" "$TMP/SHASUMS256.txt" | head -1)"
  [ -n "$FILE" ] || { echo "Could not find a Node download for $OS-$ARCH"; exit 1; }
  curl -fsSL "$BASE/$FILE" -o "$TMP/$FILE"
  EXPECTED="$(grep " $FILE\$" "$TMP/SHASUMS256.txt" | cut -d' ' -f1)"
  if command -v shasum >/dev/null 2>&1; then ACTUAL="$(shasum -a 256 "$TMP/$FILE" | cut -d' ' -f1)"; else ACTUAL="$(sha256sum "$TMP/$FILE" | cut -d' ' -f1)"; fi
  [ "$EXPECTED" = "$ACTUAL" ] || { echo "Node download failed its checksum. Try again."; exit 1; }
  mkdir -p "$RUNTIME"
  rm -rf "$RUNTIME/node"
  tar -xzf "$TMP/$FILE" -C "$TMP"
  mv "$TMP/${FILE%.tar.gz}" "$RUNTIME/node"
  NODE="$RUNTIME/node/bin/node"
  echo "  Node $("$NODE" -v) ready"
fi

# ── 3. Install ───────────────────────────────────────────────────────────────
export PATH="$(dirname "$NODE"):$PATH"
exec "$NODE" "$KIT/install.mjs" "$@"
