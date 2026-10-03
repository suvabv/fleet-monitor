import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { discoverSessions, readTranscriptTail, SESSIONS_DIR } from './discover.mjs';

const POLL_MS = 1000;

const BUSY_SUBSTATES = ['shell', 'thinking', 'compacting', 'resuming'];

const BADGE_CHAR = {
  'needs-attention': '!',
  'idle-question': '?',
  waiting: ':',
  running: '*',
  busy: '*',
  idle: 'o',
};

const BADGE_COLOR = {
  'needs-attention': '\x1b[1;31m', // bold red
  'idle-question': '\x1b[1;33m',   // bold yellow
  waiting: '\x1b[1;33m',           // bold yellow, same as idle-question
  running: '\x1b[32m',             // green
  busy: '\x1b[32m',
  idle: '\x1b[90m',                // gray
};

const STATE_LABELS = {
  'needs-attention': 'STUCK!',
  'idle-question': 'question?',
  waiting: 'question?',
  running: 'running!',
  busy: 'busy!',
  idle: 'idle',
};

for (const s of BUSY_SUBSTATES) {
  BADGE_CHAR[s] = '*';
  BADGE_COLOR[s] = '\x1b[32m'; // green, same as busy/running
  STATE_LABELS[s] = s;
}

const STATE_COL_WIDTH = 10;
const AGENT_COL_WIDTH = 6;

const AGENT_LABELS = {
  claude: 'claude',
  gemini: 'gemini',
  antigravity: 'antigrav',
};

function ctxColor(pct) {
  if (pct == null) return DIM;
  if (pct >= 80) return '\x1b[1;31m'; // bold red
  if (pct >= 50) return '\x1b[33m';   // yellow
  return '\x1b[32m';                 // green
}

function fmtCtxPct(pct) {
  return pct == null ? '  - ' : `${pct}%`;
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

const DIM = '\x1b[90m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const REVERSE = '\x1b[7m';
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const ANSI_RE_ANCHORED = /^\x1b\[[0-9;]*m/;

function fmtAge(ts) {
  if (!ts) return '-';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function visibleLength(str) {
  return str.replace(ANSI_RE, '').length;
}

// Truncates to 'len' VISIBLE columns without cutting an ANSI escape
// sequence in half, and without stripping color from text that fits.
function truncate(str, len) {
  const visLen = visibleLength(str);
  if (visLen <= len) return str;
  if (len <= 1) return '';
  const targetVisible = len - 1; // room for the ellipsis
  let out = '';
  let visible = 0;
  let i = 0;
  while (i < str.length && visible < targetVisible) {
    if (str[i] === '\x1b') {
      const match = ANSI_RE_ANCHORED.exec(str.slice(i));
      if (match) {
        out += match[0];
        i += match[0].length;
        continue;
      }
    }
    out += str[i];
    visible += 1;
    i += 1;
  }
  return out + '…' + RESET;
}

// Pads a string to 'width' visible columns, ignoring embedded ANSI codes
// when measuring length so colored text still lines up.
function padVisible(str, width) {
  const len = visibleLength(str);
  if (len >= width) return str;
  return str + ' '.repeat(width - len);
}

const MIN_INNER_WIDTH = 67;

function boxTop(title, innerWidth) {
  const label = ` ${title} `;
  const rest = Math.max(0, innerWidth - label.length - 1);
  return `┌─${label}${'─'.repeat(rest)}┐`;
}

function boxDivider(innerWidth) {
  return `├${'─'.repeat(innerWidth)}┤`;
}

function boxBottom(innerWidth) {
  return `└${'─'.repeat(innerWidth)}┘`;
}

function boxLine(content, innerWidth, reverse = false) {
  const padded = padVisible(content, innerWidth);
  if (!reverse) return `│${padded}│`;
  const rewrapped = padded.split(RESET).join(`${RESET}${REVERSE}`);
  return `│${REVERSE}${rewrapped}${RESET}│`;
}

const CLEAR = '\x1b[2J\x1b[H';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

export class FleetTUI {
  constructor() {
    this.sessions = [];
    this.selected = 0;
    this.mode = 'list'; // 'list' | 'inspect'
    this.inspectLines = [];
    this.inspectScroll = 0;
    this.pollTimer = null;
    this.watcher = null;
    this.pendingRefresh = false;
    this.error = null;
    this.onDataHandler = null;
  }

  async start() {
    if (!process.stdin.isTTY) {
      console.error('fleet-monitor needs a TTY. Run it directly in a terminal.');
      process.exitCode = 1;
      return;
    }
    process.stdout.write(HIDE_CURSOR);
    readline_setRawMode(true);
    this.onDataHandler = (buf) => this.onKey(buf);
    process.stdin.on('data', this.onDataHandler);
    process.on('SIGWINCH', () => this.render());
    this.setupWatcher();
    await this.refresh();
    this.pollTimer = setInterval(() => this.refresh(), POLL_MS);
  }

  setupWatcher() {
    try {
      this.watcher = fs.watch(SESSIONS_DIR, { persistent: false }, () => {
        if (this.pendingRefresh) return;
        this.pendingRefresh = true;
        setTimeout(() => {
          this.pendingRefresh = false;
          this.refresh();
        }, 150);
      });
    } catch {
      // directory may not exist yet; poll timer still covers us
    }
  }

  async refresh() {
    try {
      this.sessions = await discoverSessions();
      this.error = null;
    } catch (e) {
      this.error = String(e?.message ?? e);
    }
    if (this.selected >= this.sessions.length) {
      this.selected = Math.max(0, this.sessions.length - 1);
    }
    this.render();
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.watcher) this.watcher.close();
    if (this.onDataHandler) {
      process.stdin.off('data', this.onDataHandler);
      process.stdin.pause();
    }
    readline_setRawMode(false);
    process.stdout.write(SHOW_CURSOR);
  }

  onKey(buf) {
    const key = buf.toString('utf8');
    if (this.mode === 'inspect') {
      this.onKeyInspect(key);
      return;
    }
    this.onKeyList(key);
  }

  onKeyList(key) {
    if (key === 'q' || key === '\x03') {
      this.stop();
      process.exit(0);
    }
    if (key === '\x1b[A' || key === 'k') {
      this.selected = Math.max(0, this.selected - 1);
      this.render();
    } else if (key === '\x1b[B' || key === 'j') {
      this.selected = Math.min(this.sessions.length - 1, this.selected + 1);
      this.render();
    } else if (key === '\r' || key === '\n') {
      this.openInspect();
    } else if (key === 'a') {
      this.attach();
    }
  }

  onKeyInspect(key) {
    if (key === 'q' || key === '\x1b') {
      this.mode = 'list';
      this.render();
      return;
    }
    if (key === '\x1b[A' || key === 'k') {
      this.inspectScroll = Math.max(0, this.inspectScroll - 1);
      this.render();
    } else if (key === '\x1b[B' || key === 'j') {
      this.inspectScroll += 1;
      this.render();
    }
  }

  async openInspect() {
    const s = this.sessions[this.selected];
    if (!s) return;
    this.mode = 'inspect';
    this.inspectScroll = 0;
    if (s.agent === 'antigravity') {
      this.inspectLines = [
        "Antigravity CLI transcript inspection isn't supported -",
        'its session format is proprietary/undocumented.',
      ];
      this.render();
      return;
    }
    this.inspectLines = ['Loading...'];
    this.render();
    const events = await readTranscriptTail(s);
    this.inspectLines = renderTranscript(events, s.agent);
    this.render();
  }

  attach() {
    const s = this.sessions[this.selected];
    if (!s) return;
    if (s.agent === 'antigravity') {
      this.inspectLines = ["agy sessions can't be attached to - no resumable session ID is exposed on disk."];
      this.inspectScroll = 0;
      this.mode = 'inspect';
      this.render();
      return;
    }
    this.stop();
    const bin = s.agent === 'gemini' ? 'gemini' : 'claude';
    console.log(`\nAttaching to ${s.name} (session ${s.sessionId})...\n`);
    const child = spawn(bin, ['--resume', s.sessionId], { stdio: 'inherit' });
    child.on('exit', () => {
      process.stdout.write(HIDE_CURSOR);
      readline_setRawMode(true);
      process.stdin.on('data', this.onDataHandler);
      this.render();
      this.pollTimer = setInterval(() => this.refresh(), POLL_MS);
    });
  }

  render() {
    if (this.mode === 'inspect') {
      this.renderInspect();
    } else {
      this.renderList();
    }
  }

  renderList() {
    const cols = process.stdout.columns || 100;
    const rows = process.stdout.rows || 30;
    const innerWidth = Math.max(MIN_INNER_WIDTH, Math.min(cols - 2, 130));

    const CTX_W = 7; // fits header "CONTEXT"; values like "100%" pad fine
    const TOK_W = 6; // "1.2M"
    const AGE_W = 4;
    const fixedOverhead = 9 + AGENT_COL_WIDTH + STATE_COL_WIDTH + CTX_W + TOK_W + AGE_W;
    const pool = innerWidth - fixedOverhead;
    const DIR_W_MIN = 6;
    const DIR_W_MAX = 16;
    const dirW = Math.max(DIR_W_MIN, Math.min(DIR_W_MAX, pool - 12));
    const nameW = Math.max(12, pool - dirW);

    const lines = [];
    lines.push(boxTop('fleet-monitor', innerWidth));

    const count = this.sessions.length;
    const summary = count === 1 ? '1 session' : `${count} sessions`;
    const stuck = this.sessions.filter((s) => s.state === 'needs-attention' || s.state === 'idle-question').length;
    const stuckNote = stuck > 0 ? `${DIM} ${RESET}${BADGE_COLOR['needs-attention']}${stuck} need${stuck === 1 ? 's' : ''} you${RESET}` : '';
    lines.push(boxLine(` ${summary}${stuckNote}`, innerWidth));
    lines.push(boxDivider(innerWidth));

    if (this.error) {
      lines.push(boxLine(` ${'\x1b[31m'}Error: ${this.error}${RESET}`, innerWidth));
    } else if (count === 0) {
      lines.push(boxLine(` ${DIM}No running agent sessions found.${RESET}`, innerWidth));
    } else {
      const header = '  ' +
        padVisible('AGENT', AGENT_COL_WIDTH) + ' ' +
        padVisible('NAME', nameW) + ' ' +
        padVisible('STATE', STATE_COL_WIDTH) + ' ' +
        padVisible('CONTEXT', CTX_W) + ' ' +
        padVisible('TOKENS', TOK_W) + ' ' +
        padVisible('DIR', dirW) + ' ' +
        padVisible('AGE', AGE_W);
      lines.push(boxLine(`${DIM}${header}${RESET}`, innerWidth));

      const maxRows = Math.max(1, rows - 9);
      const visible = this.sessions.slice(0, maxRows);
      visible.forEach((s, i) => {
        const isSelected = i === this.selected;
        const badgeColor = BADGE_COLOR[s.state] ?? '';
        const badge = `${badgeColor}${BADGE_CHAR[s.state] ?? '?'}${RESET} `;
        const label = STATE_LABELS[s.state] ?? s.state;
        const labelColored = `${badgeColor}${padVisible(truncate(label, STATE_COL_WIDTH), STATE_COL_WIDTH)}${RESET}`;
        const ctxColored = `${ctxColor(s.contextPct)}${padVisible(fmtCtxPct(s.contextPct), CTX_W)}${RESET}`;
        const dirName = truncate(path.basename(s.cwd), dirW);
        const agentLabel = AGENT_LABELS[s.agent] ?? s.agent;
        const row = ' ' + badge +
          padVisible(truncate(agentLabel, AGENT_COL_WIDTH), AGENT_COL_WIDTH) + ' ' +
          padVisible(truncate(s.name, nameW), nameW) + ' ' +
          labelColored + ' ' +
          ctxColored + ' ' +
          padVisible(fmtTokens(s.totalTokens), TOK_W) + ' ' +
          padVisible(dirName, dirW) + ' ' +
          padVisible(fmtAge(s.statusUpdatedAt), AGE_W);
        lines.push(boxLine(row, innerWidth, isSelected));
      });
    }

    lines.push(boxDivider(innerWidth));
    lines.push(boxLine(`${DIM} ↑/↓ select ⏎ inspect a attach q quit${RESET}`, innerWidth));
    lines.push(boxBottom(innerWidth));

    process.stdout.write(CLEAR + lines.join('\n') + '\n');
  }

  renderInspect() {
    const s = this.sessions[this.selected];
    const cols = process.stdout.columns || 100;
    const rows = process.stdout.rows || 30;
    const innerWidth = Math.max(MIN_INNER_WIDTH, Math.min(cols - 2, 116));

    const lines = [];
    lines.push(boxTop(s ? s.name : 'inspect', innerWidth));
    lines.push(boxLine(`${DIM} q/esc back ↑/↓ scroll${RESET}`, innerWidth));
    lines.push(boxDivider(innerWidth));

    const maxRows = Math.max(1, rows - 6);
    const visible = this.inspectLines.slice(this.inspectScroll, this.inspectScroll + maxRows);
    for (const line of visible) {
      lines.push(boxLine(` ${truncate(line, innerWidth - 1)}`, innerWidth));
    }
    for (let i = visible.length; i < maxRows; i++) {
      lines.push(boxLine('', innerWidth));
    }

    lines.push(boxBottom(innerWidth));
    process.stdout.write(CLEAR + lines.join('\n') + '\n');
  }
}

function renderTranscript(events, agent = 'claude') {
  const lines = agent === 'gemini' ? renderGeminiTranscript(events) : renderClaudeTranscript(events);
  if (lines.length === 0) lines.push('(no conversational content found)');
  return lines;
}

function renderClaudeTranscript(events) {
  const lines = [];
  for (const e of events) {
    if (e.type === 'assistant' || e.type === 'user') {
      const content = e.message?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (c.type === 'text' && c.text?.trim()) {
          const role = e.type === 'assistant' ? '\x1b[36massistant\x1b[0m' : '\x1b[33muser\x1b[0m';
          lines.push(`${role}: ${c.text.trim().split('\n').join(' ')}`);
        } else if (c.type === 'tool_use') {
          lines.push(`\x1b[35m ↳ tool_use\x1b[0m: ${c.name}`);
        } else if (c.type === 'tool_result') {
          const preview = typeof c.content === 'string' ? c.content : JSON.stringify(c.content);
          lines.push(`\x1b[90m ↳ tool_result\x1b[0m: ${truncate((preview ?? '').replace(/\s+/g, ' '), 100)}`);
        }
      }
    }
  }
  return lines;
}

function renderGeminiTranscript(events) {
  const lines = [];
  for (const e of events) {
    if (e.type === 'gemini' || e.type === 'user') {
      const role = e.type === 'gemini' ? '\x1b[36mgemini\x1b[0m' : '\x1b[33muser\x1b[0m';
      if (typeof e.content === 'string') {
        if (e.content.trim()) lines.push(`${role}: ${e.content.trim().split('\n').join(' ')}`);
        continue;
      }
      if (!Array.isArray(e.content)) continue;
      for (const c of e.content) {
        if (c.text?.trim()) {
          lines.push(`${role}: ${c.text.trim().split('\n').join(' ')}`);
        } else if (c.functionCall) {
          lines.push(`\x1b[35m ↳ functionCall\x1b[0m: ${c.functionCall.name}`);
        } else if (c.functionResponse) {
          const preview = JSON.stringify(c.functionResponse.response ?? c.functionResponse);
          lines.push(`\x1b[90m ↳ functionResponse\x1b[0m: ${truncate((preview ?? '').replace(/\s+/g, ' '), 100)}`);
        }
      }
    } else if (e.type === 'info' || e.type === 'error') {
      const label = e.type === 'error' ? '\x1b[1;31merror\x1b[0m' : '\x1b[90minfo\x1b[0m';
      if (e.content?.trim()) lines.push(`${label}: ${e.content.trim()}`);
    }
  }
  return lines;
}

function readline_setRawMode(enabled) {
  if (process.stdin.setRawMode) {
    process.stdin.setRawMode(enabled);
  }
  if (enabled) {
    process.stdin.resume();
  }
}

