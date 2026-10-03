import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');

const CONTEXT_WINDOW_1M = 1000000;
const CONTEXT_WINDOW_STANDARD = 200000;

const CONVERSATIONAL_TYPES = new Set(['assistant', 'user']);
const TAIL_BYTES = 65536;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let cachedDefaultModelIs1m = null;
async function cacheDefaultModelIs1m() {
  if (cachedDefaultModelIs1m !== null) return cachedDefaultModelIs1m;
  try {
    const raw = await fs.readFile(SETTINGS_PATH, 'utf8');
    const settings = JSON.parse(raw);
    cachedDefaultModelIs1m = typeof settings.model === 'string' && settings.model.includes('1m');
  } catch {
    cachedDefaultModelIs1m = false;
  }
  return cachedDefaultModelIs1m;
}

async function processHas1mModelFlag(pid) {
  try {
    const raw = await fs.readFile(`/proc/${pid}/cmdline`, 'utf8');
    const args = raw.split('\0').filter(Boolean);
    const flagIndex = args.indexOf('--model');
    if (flagIndex === -1 || flagIndex + 1 >= args.length) return null;
    return args[flagIndex + 1].includes('1m');
  } catch {
    return null;
  }
}

async function resolveContextWindow(pid) {
  const explicit = await processHas1mModelFlag(pid);
  if (explicit !== null) {
    return explicit ? CONTEXT_WINDOW_1M : CONTEXT_WINDOW_STANDARD;
  }
  const defaultIs1m = await cacheDefaultModelIs1m();
  return defaultIs1m ? CONTEXT_WINDOW_1M : CONTEXT_WINDOW_STANDARD;
}

function cwdToProjectSlug(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

async function readSessionFiles() {
  let names;
  try {
    names = await fs.readdir(SESSIONS_DIR);
  } catch {
    return [];
  }
  const jsonFiles = names.filter((n) => n.endsWith('.json'));
  const sessions = [];
  for (const name of jsonFiles) {
    try {
      const raw = await fs.readFile(path.join(SESSIONS_DIR, name), 'utf8');
      sessions.push(JSON.parse(raw));
    } catch {
      // skip unreadable/malformed session file
    }
  }
  return sessions;
}

async function tailLines(filepath, maxBytes = TAIL_BYTES) {
  let fh;
  try {
    fh = await fs.open(filepath, 'r');
  } catch {
    return [];
  }
  try {
    const stat = await fh.stat();
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, start);
    const text = buf.toString('utf8');
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    // first line may be a truncated partial line if we didn't start at byte 0
    if (start > 0 && lines.length > 0) lines.shift();
    return lines;
  } finally {
    await fh.close();
  }
}

function parseEvents(lines) {
  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // skip malformed line
    }
  }
  return events;
}

const usageCache = new Map();
async function computeUsage(transcriptPath) {
  let cached = usageCache.get(transcriptPath);
  if (cached) {
    offset = 0,

  let cached = usageCache.get(transcriptPath);
  if (!cached) {
    cached = {
      offset: 0,
      totalTokens: 0,
      lastContextTokens: 0,
      lastModel: null,
      lastCountedMessageId: null,
      lastPermissionMode: null,
      lastAiTitle: null,
      carry: '',
    };
    usageCache.set(transcriptPath, cached);
  }

  let fh;
  try {
    fh = await fs.open(transcriptPath, 'r');
  } catch {
    return {
      totalTokens: cached.totalTokens,
      lastContextTokens: cached.lastContextTokens,
      lastModel: cached.lastModel,
      lastPermissionMode: cached.lastPermissionMode,
      lastAiTitle: cached.lastAiTitle,
    };
  }
  try {
    const stat = await fh.stat();
    if (stat.size < cached.offset) {
      // file shrank/rotated unexpectedly - reset rather than read negative length
      cached.offset = 0;
      cached.totalTokens = 0;
      cached.lastContextTokens = 0;
      cached.lastModel = null;
      cached.lastCountedMessageId = null;
      cached.lastPermissionMode = null;
      cached.lastAiTitle = null;
      cached.carry = '';
    }
    const length = stat.size - cached.offset;
    if (length > 0) {
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, cached.offset);
      cached.offset = stat.size;
      const text = cached.carry + buf.toString('utf8');
      const parts = text.split('\n');
      cached.carry = parts.pop() ?? ''; // last part may be an incomplete line
      for (const line of parts) {
        if (!line.trim()) continue;
        if (
          !line.includes('"usage"') &&
          !line.includes('"permission-mode"') &&
          !line.includes('"ai-title"')
        ) continue;
        let d;
        try {
          d = JSON.parse(line);
        } catch {
          continue;
        }
        if (d.type === 'permission-mode') {
          cached.lastPermissionMode = d.permissionMode ?? cached.lastPermissionMode;
          continue;
        }
        if (d.type === 'ai-title') {
          cached.lastAiTitle = d.aiTitle ?? cached.lastAiTitle;
          continue;
        }
        if (d.type !== 'assistant') continue;
        const u = d.message?.usage;
        if (!u) continue;
        const ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        cached.lastContextTokens = ctx;
        cached.lastModel = d.message.model ?? cached.lastModel;
        const messageId = d.message.id ?? null;
        // Only count each turn's usage once, no matter how many content-block
        // lines it's split across.
        if (messageId !== null && messageId === cached.lastCountedMessageId) continue;
        cached.totalTokens += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
        if (messageId !== null) cached.lastCountedMessageId = messageId;
      }
    }
  } finally {
    await fh.close();
  }
  return {
    totalTokens: cached.totalTokens,
    lastContextTokens: cached.lastContextTokens,
    lastModel: cached.lastModel,
    lastPermissionMode: cached.lastPermissionMode,
    lastAiTitle: cached.lastAiTitle,
  };
}

const STUCK_TOOL_MS = 8000;

function classify(events, daemonStatus, now, permissionMode) {
  const convo = events.filter((e) => CONVERSATIONAL_TYPES.has(e.type));
  if (convo.length === 0) {
    return { state: daemonStatus, source: 'daemon' };
  }
  const last = convo[convo.length - 1];
  if (last.type === 'assistant') {
    const content = last.message?.content;
    const hasToolUse = Array.isArray(content) && content.some((c) => c?.type === 'tool_use');
    if (hasToolUse) {
      const ts = last.timestamp ? Date.parse(last.timestamp) : NaN;
      const elapsedMs = Number.isFinite(ts) ? now - ts : 0;
      if (elapsedMs >= STUCK_TOOL_MS && permissionMode !== 'auto') {
        return { state: 'needs-attention', source: 'transcript', elapsedMs };
      }
      return { state: 'running', source: 'transcript', elapsedMs };
    }
    const lastText = Array.isArray(content)
      ? content.filter((c) => c?.type === 'text' && c.text?.trim()).pop()?.text?.trim()
      : null;
    if (lastText && lastText.endsWith('?')) {
      return { state: 'idle-question', source: 'transcript' };
    }
  }
  return { state: daemonStatus, source: 'daemon' };
}

function dedupeBySessionId(sessions) {
  const bySessionId = new Map();
  for (const s of sessions) {
    const existing = bySessionId.get(s.sessionId);
    if (!existing) {
      bySessionId.set(s.sessionId, s);
      continue;
    }
    const existingTs = existing.statusUpdatedAt ?? existing.updatedAt ?? 0;
    const candidateTs = s.statusUpdatedAt ?? s.updatedAt ?? 0;
    if (candidateTs > existingTs) bySessionId.set(s.sessionId, s);
  }
  return [...bySessionId.values()];
}

export async function discoverClaudeSessions() {
  const rawSessions = await readSessionFiles();
  const live = dedupeBySessionId(rawSessions.filter((s) => s.pid && isAlive(s.pid)));

  const now = Date.now();
  const results = await Promise.all(
    live.map(async (s) => {
      const slug = cwdToProjectSlug(s.cwd);
      const transcriptPath = path.join(PROJECTS_DIR, slug, `${s.sessionId}.jsonl`);
      const [lines, usage, contextWindow] = await Promise.all([
        tailLines(transcriptPath),
        computeUsage(transcriptPath),
        resolveContextWindow(s.pid),
      ]);
      const events = parseEvents(lines);
      const { state, source } = classify(events, s.status ?? 'idle', now, usage.lastPermissionMode);
      const contextPct = contextWindow > 0
        ? Math.min(100, Math.round((usage.lastContextTokens / contextWindow) * 100))
        : null;
      return {
        agent: 'claude',
        pid: s.pid,
        sessionId: s.sessionId,
        name: usage.lastAiTitle ?? s.name ?? s.sessionId,
        cwd: s.cwd,
        kind: s.kind ?? 'interactive',
        daemonStatus: s.status ?? 'idle',
        state,
        stateSource: source,
        statusUpdatedAt: s.statusUpdatedAt ?? s.updatedAt ?? null,
        transcriptPath,
        contextTokens: usage.lastContextTokens,
        contextWindow,
        contextPct,
        totalTokens: usage.totalTokens,
        model: usage.lastModel,
      };
    })
  );
  return results;
}

export async function readClaudeTranscriptTail(transcriptPath, maxBytes = 262144) {
  const lines = await tailLines(transcriptPath, maxBytes);
  return parseEvents(lines);
}

export { SESSIONS_DIR, PROJECTS_DIR };

