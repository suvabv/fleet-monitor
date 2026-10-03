#!/usr/bin/env node
import { FleetTUI } from './lib/tui.mjs';
import { discoverSessions } from './lib/discover.mjs';

const args = process.argv.slice(2);

async function printOnce() {
  const sessions = await discoverSessions();
  if (sessions.length === 0) {
    console.log('No running agent sessions found.');
    return;
  }
  for (const s of sessions) {
    const context = s.contextPct === null ? '-' : `${s.contextPct}%`;
    const tokens = s.totalTokens === null ? '-' : s.totalTokens;
    console.log(`${s.agent.padEnd(8)} ${s.state.padEnd(16)} ${s.name.padEnd(30)} context:${context.padEnd(4)} tokens:${tokens} ${s.cwd}`);
  }
}

if (args.includes('--once') || args.includes('--list')) {
  await printOnce();
} else if (args.includes('--help') || args.includes('-h')) {
  console.log(`fleet-monitor - live dashboard of Claude Code, Gemini CLI, and Antigravity CLI sessions on this machine

Usage:
  fleet-monitor          Launch the interactive dashboard
  fleet-monitor --once   Print current session states once and exit (no TTY needed)
  fleet-monitor --help   Show this help

Keys (interactive mode):
  up/down or j/k   move selection
  enter            inspect selected session's recent transcript (not supported for Antigravity)
  a                attach to selected session (claude/gemini: --resume <id>; not supported for Antigravity)
  q                quit (or back, while inspecting)
`);
} else {
  const tui = new FleetTUI();
  await tui.start();
}
