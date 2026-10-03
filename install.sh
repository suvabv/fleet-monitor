#!/usr/bin/env bash

set -euo pipefail

REPO="suvabv/fleet-monitor"
BASE_URL="${FLEET_MONITOR_BASE_URL:-https://github.com/$REPO/releases/latest/download}"
INSTALL_DIR="${FLEET_MONITOR_INSTALL_DIR:-$HOME/.local/bin}"
SKILL_DIR="${FLEET_MONITOR_SKILL_DIR:-$HOME/.claude/skills/fleet-monitor}"
DEST="$INSTALL_DIR/fleet-monitor"

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required (v18+) but was not found on PATH" >&2
  exit 1
fi

node_major="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$node_major" -lt 18 ]; then
  echo "error: node v18+ required, found $(node --version)" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"

echo "Fetching fleet-monitor.mjs from $BASE_URL ..."
curl -fsSL "$BASE_URL/fleet-monitor.mjs" -o "$DEST"
chmod +x "$DEST"
echo "Installed CLI to $DEST"

if [ "${SKIP_SKILL:-0}" != "1" ]; then
  mkdir -p "$SKILL_DIR"
  echo "Fetching SKILL.md from $BASE_URL ..."
  curl -fsSL "$BASE_URL/SKILL.md" -o "$SKILL_DIR/SKILL.md"
  echo "Installed skill to $SKILL_DIR/SKILL.md"
else
  echo "Skipped skill install (SKIP_SKILL=1)"
fi

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo "Note: $INSTALL_DIR is not on your PATH. Add this to your shell profile:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac

echo "Run 'fleet-monitor' (or '$DEST') in a terminal to start the dashboard."

