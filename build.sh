#!/usr/bin/env bash

# Regenerates dist/fleet-monitor.mjs from the split source files
# (lib/discover*.mjs, lib/tui.mjs, bin.mjs), and copies dist/Skill.md,
# dist/install.sh, dist/install-local.sh so the packaged bundle always ships
# everything install.sh/install-local.sh need. Run this after editing
# lib/*.mjs, bin.mjs, install.sh, install-local.sh, or Skill.md - everything
# under dist/ is a copied artifact, not hand-edited.

# Skill.md has two possible sources, tried in order:
# 1. ~/.claude/skills/fleet-monitor/Skill.md - the canonical file Claude
#    Code itself reads as a skill, present on a dev machine that has this
#    skill installed. When found, it's also copied into skill/Skill.md so
#    that repo-tracked copy never goes stale (build.sh keeps it in sync;
#    it isn't hand-edited).
# 2. skill/Skill.md - the repo-tracked fallback, used in CI / a fresh
#    clone where the ~/.claude path doesn't exist.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$SCRIPT_DIR/dist/fleet-monitor.mjs"
SKILL_HOME_SRC="$HOME/.claude/skills/fleet-monitor/Skill.md"
SKILL_REPO_COPY="$SCRIPT_DIR/skill/Skill.md"
SKILL_OUT="$SCRIPT_DIR/dist/Skill.md"
INSTALL_SRC="$SCRIPT_DIR/install.sh"
INSTALL_OUT="$SCRIPT_DIR/dist/install.sh"
INSTALL_LOCAL_SRC="$SCRIPT_DIR/install-local.sh"
INSTALL_LOCAL_OUT="$SCRIPT_DIR/dist/install-local.sh"
mkdir -p "$SCRIPT_DIR/dist" "$SCRIPT_DIR/skill"

node "$SCRIPT_DIR/build.mjs" > "$OUT"
chmod +x "$OUT"
echo "Wrote $OUT"

if [ -f "$SKILL_HOME_SRC" ]; then
  cp "$SKILL_HOME_SRC" "$SKILL_REPO_COPY"
  echo "Wrote $SKILL_REPO_COPY (synced from $SKILL_HOME_SRC)"
  cp "$SKILL_HOME_SRC" "$SKILL_OUT"
  echo "Wrote $SKILL_OUT (copied from $SKILL_HOME_SRC)"
elif [ -f "$SKILL_REPO_COPY" ]; then
  cp "$SKILL_REPO_COPY" "$SKILL_OUT"
  echo "Wrote $SKILL_OUT (copied from $SKILL_REPO_COPY - $SKILL_HOME_SRC not found, e.g. CI)"
else
  echo "Warning: no Skill.md found at $SKILL_HOME_SRC or $SKILL_REPO_COPY - dist/Skill.md left as-is" >&2
fi

cp "$INSTALL_SRC" "$INSTALL_OUT"
chmod +x "$INSTALL_OUT"
echo "Wrote $INSTALL_OUT (copied from $INSTALL_SRC, so dist/ alone is installable)"

cp "$INSTALL_LOCAL_SRC" "$INSTALL_LOCAL_OUT"
chmod +x "$INSTALL_LOCAL_OUT"
echo "Wrote $INSTALL_LOCAL_OUT (copied from $INSTALL_LOCAL_SRC, so dist/ alone is installable)"
