# fleet-monitor

A standalone, dependency-free Node CLI that shows a live, auto-refreshing
dashboard of every Claude Code, Gemini CLI, and Antigravity CLI session
running on your machine — which are busy, idle, or possibly stuck waiting on
a permission prompt or a question — and lets you inspect a session's recent
transcript or attach into it.

It works by reading each CLI's own on-disk session state; it does not use
any in-conversation tool calls, so it has zero runtime overhead on the
sessions it's watching.

## Why

Checking on multiple parallel agent sessions usually means switching
terminals one at a time to see which are done, which are stuck, and which
are quietly waiting on you. fleet-monitor is a standing dashboard for that
instead — one glance tells you what needs attention.

## Features

- Live view of every running Claude Code, Gemini CLI, and Antigravity CLI
  session, auto-refreshing in place
- Flags sessions that look stuck on a permission prompt or are waiting on an
  answer to a question
- Context-window usage and token totals per session (Claude/Gemini)
- Inspect a session's recent transcript without leaving the dashboard
- Attach directly into a session (`claude --resume` / `gemini --resume`)
- Zero npm dependencies

## Multi-agent support

| CLI | State detection | Context/tokens | Inspect | Attach |
|---|---|---|---|---|
| Claude Code | Full (including stuck/waiting-on-you) | Yes | Yes | Yes |
| Gemini CLI | Running/idle | Yes | Yes | Yes |
| Antigravity CLI | Process presence only | No | No | No |

GitHub Copilot CLI isn't currently supported.

## Install

**curl:**
```bash
curl -fsSL [https://github.com/](https://github.com/)<owner>/<repo>/releases/latest/download/install.sh | bash
