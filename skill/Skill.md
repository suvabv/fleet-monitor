---
name: fleet-monitor
description: Launch or check the fleet-monitor CLI dashboard to see the live status of every Claude Code, Gemini CLI, and Antigravity CLI session running on this machine (busy, idle, or possibly stuck/asking a question) and to attach into one. Use when the user asks to monitor multiple sessions/agents at once, check if a session needs input, wants a live/real-time view across sessions, or asks about "fleet-monitor" by name.
---

# fleet-monitor

A standalone CLI, independent of any Agent/SendMessage tool call, that
discovers every running `claude`, `gemini`, and `agy` (Antigravity CLI)
process on this machine by reading each CLI's own on-disk session state
(`~/.claude/sessions/<pid>.json` + `~/.claude/projects/` for Claude Code,
`~/.gemini/projects.json` + `~/.gemini/tmp/*/chats/` for Gemini CLI, live
process scanning only for Antigravity), and renders a live, auto-refreshing
table of their status.

It is a small Node script at `~/.claude/tools/fleet-monitor/bin.mjs`, also
symlinked onto PATH as `fleet-monitor`.

## When to use this

The user wants to watch several coding-agent sessions at once — across
Claude Code, Gemini CLI, and/or Antigravity CLI — especially to notice when
one is stuck waiting on a permission prompt or has asked a question and is
idle waiting for a reply. This is complementary to the `ListAgents` /
`SendMessage` tools (which only see Claude sessions, and work turn-by-turn
from inside a conversation) — fleet-monitor is an always-on terminal
dashboard the user watches themselves, across all three agents.

## How to run it

This is an **interactive, full-screen terminal tool** meant to be watched by
a human in their own terminal — it requires a real TTY. Do not try to run it
via Bash and read its output as if it were a normal command; a raw-mode TUI
will not render sensibly that way and the tool will refuse to start
(`fleet-monitor needs a TTY`) rather than corrupt Bash output.

To let the user run it themselves: tell them to run `fleet-monitor` (or
`node ~/.claude/tools/fleet-monitor/bin.mjs`) directly in their own
terminal.

To get a one-shot, script-friendly snapshot (safe to run via Bash, no TTY
needed): `fleet-monitor --once` — prints one line per live session:
`<agent> <state> <name> context=<pct> tokens=<total> <cwd>`.

## Multi-agent support level

Not every agent has the same visibility on disk:

- **Claude Code**: full support: all states below, context %, token totals,
  transcript inspect, and attach.
- **Gemini CLI**: near-full support: `running`/`idle` state (from transcript
  recency; no `needs-attention` / `idle-question` yet — Gemini's
  permission-approval UI didn't leave a distinguishable on-disk trace during
  investigation), token totals, best-effort context % (static per-model-name
  table, since there's no on-disk field for it), transcript inspect, and
  attach via `gemini --resume <sessionId>`.
- **Antigravity CLI**: process-only: shown with state `running` if the
  process is alive, nothing else. Its session storage uses Google-internal
  protobuf/SQLite formats not plausible to reverse-engineer responsibly, so
  there's no context/token/transcript data, and no attach (no resumable
  session ID is exposed on disk).

## Columns shown (interactive dashboard)

Beyond name/state/dir/age, an AGENT column (`claude`/`gemini`/`antigrav`) and
two usage columns (no PID column — dropped per user request):

- **AGENT** — which CLI the session belongs to.
- **CONTEXT** — the live context size as a % of the model's context window.
  For Claude: from the most recent API call's `input_tokens +
  cache_creation_input_tokens + cache_read_input_tokens`; denominator is a
  best-effort guess (not verifiable on disk): 1,000,000 if that session's
  `--model` flag (or, when absent, `~/.claude/settings.json`'s default
  model) includes `[1m]`, otherwise 200,000. For Gemini: from the last
  turn's tokens total, against a static best-effort per-model-name window
  table. Shown as `-` for Antigravity (not available). Colored green (<50%),
  yellow (50-79%), red (80%+).
- **TOKENS** — cumulative token usage across the session so far (a rough
  usage indicator, not a live dollar cost). Shown as `-` for Antigravity.

## States shown

| State | Meaning |
|---|---|
| `needs-attention` | (Claude only) A tool call has been pending with no result for 8s+ — likely stuck on a permission prompt. Inferred from the transcript, not certain. |
| `idle-question` | (Claude only) The last assistant message ended in `?` and nothing followed — the session may be waiting on an answer. Also inferred, not certain. |
| `running` / `busy` | Actively working (Claude/Gemini from transcript signals; Antigravity always shows `running` while its process is alive — no finer classification is possible). |
| `idle` | Nothing pending, waiting for the next prompt (Claude/Gemini only). |

These heuristics can't be made exact — there's no on-disk field that says
"waiting for permission" or "waiting for input" for any of the three agents.
Present them to the user as likely/inferred, not as ground truth.

## Interactive keys

- `up`/`down` or `j`/`k` — move selection
- `enter` — inspect the selected session's recent transcript (read-only).
  Shows a placeholder message for Antigravity rows instead — its transcript
  format isn't readable.
- `a` — attach to the selected session via `claude --resume <sessionId>` or
  `gemini --resume <sessionId>` (whichever the row's agent is), handing over
  the terminal; returns to the dashboard on exit. Shows a message instead for
  Antigravity rows — no resumable session ID is exposed on disk.
- `q` — quit (or go back, while inspecting)

## Notes

- Claude session discovery cross-checks each `~/.claude/sessions/<pid>.json`
  file against the live process table (`process.kill(pid, 0)`); Gemini and
  Antigravity discovery scan `/proc` directly for live `gemini`/`agy`
  processes (there's no on-disk PID registry for either, unlike Claude Code)
  — all three approaches drop stale/exited entries automatically.
- The dashboard refreshes on a 1s timer and also on `fs.watch` events against
  `~/.claude/sessions/`, so Claude status changes usually show up within ~1s;
  Gemini/Antigravity rely on the 1s poll timer alone.
- No external npm dependencies; it's plain Node (v18+) using ANSI escapes.
- Linux-only (relies on `/proc` for process cwd/liveness/start-time lookups
  across all three agents).
