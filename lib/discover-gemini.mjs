import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const GEMINI_DIR = path.join(os.homedir(), '.gemini');
const PROJECTS_JSON_PATH = path.join(GEMINI_DIR, 'projects.json');
const TMP_DIR = path.join(GEMINI_DIR, 'tmp');

const GEMINI_ACTIVE_MS = 8000;

const CONTEXT_WINDOW_BY_MODEL_SUBSTRING = [['gemini-3', 1_000_000]];

function resolveContextWindowForModel(model) {
  if (!model) return null;
  const hit = CONTEXT_WINDOW_BY_MODEL_SUBSTRING.find(([substr]) => model.includes(substr));
  return hit ? hit[1] : null;
}

async function readProjectsMap() {
  try {
    const raw = await fs.readFile(PROJECTS_JSON_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed.projects ?? {};
  } catch {
    return {};
  }
}

function geminiAfterComm(statRaw) {
  return statRaw.slice(statRaw.lastIndexOf(')') + 1).trim().split(/\s+/);
}

async function findLiveGeminiPids() {
  let entries;
  try {
    entries = await fs.readdir('/proc');
  } catch {
    return [];
  }
  const candidates = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    let cmdline;
    try {
      cmdline = await fs.readFile(`/proc/${pid}/cmdline`, 'utf8');
    } catch {
      continue;
    }
    const args = cmdline.split('\0').filter(Boolean);
    const isGemini = args.some((a) => a.includes('/') && path.basename(a) === 'gemini');
    if (!isGemini) continue;
    let ppid = null;
    try {
      const statRaw = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
      ppid = Number(geminiAfterComm(statRaw)[1]);
    } catch {
      // leave ppid null - treated as having no live parent below
    }
    candidates.push({ pid, ppid });
  }
  const candidatePids = new Set(candidates.map((c) => c.pid));
  const parentPids = new Set(
    candidates.filter((c) => candidatePids.has(c.ppid)).map((c) => c.ppid)
  );
  return candidates.filter((c) => !parentPids.has(c.pid)).map((c) => c.pid);
}

async function resolveGeminiCwd(pid) {
  try {
    return await fs.readlink(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

async function findChatFileForSlug(slug) {
  const chatsDir = path.join(TMP_DIR, slug, 'chats');
  let names;
  try {
    names = await fs.readdir(chatsDir);
  } catch {
    return null;
  }
  const jsonlFiles = names.filter((n) => n.endsWith('.jsonl'));
  if (jsonlFiles.length === 0) return null;
  const withStats = await Promise.all(
    jsonlFiles.map(async (n) => {
      const p = path.join(chatsDir, n);
      try {
        const stat = await fs.stat(p);
        return { path: p, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    })
  );
  const valid = withStats.filter(Boolean);
  if (valid.length === 0) return null;
  // Verified in testing: an active session's chat file is always the
  // newest one being written to for that project.
  valid.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return valid[0];
}

const geminiUsageCache = new Map();

async function computeGeminiUsage(transcriptPath) {
  let cached = geminiUsageCache.get(transcriptPath);
  if (!cached) {
    cached = { offset: 0, totalTokens: 0, lastTokens: null, lastModel: null, sessionId: null, lastCountedId: null, carry: '' };
    geminiUsageCache.set(transcriptPath, cached);
  }

  let fh;
  try {
    fh = await fs.open(transcriptPath, 'r');
  } catch {
    return cached;
  }
  try {
    const stat = await fh.stat();
    if (stat.size < cached.offset) {
      cached.offset = 0;
      cached.totalTokens = 0;
      cached.lastTokens = null;
      cached.lastModel = null;
      cached.sessionId = null;
      cached.lastCountedId = null;
      cached.carry = '';
    }
    const length = stat.size - cached.offset;
    if (length > 0) {
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, cached.offset);
      cached.offset = stat.size;
      const text = cached.carry + buf.toString('utf8');
      const parts = text.split('\n');
      cached.carry = parts.pop() ?? '';
      for (const line of parts) {
        if (!line.trim()) continue;
        let d;
        try {
          d = JSON.parse(line);
        } catch {
          continue;
        }
        if (d.sessionId && !cached.sessionId) cached.sessionId = d.sessionId;
        if (d.type === 'gemini' && d.tokens) {
          cached.lastTokens = d.tokens;
          cached.lastModel = d.model ?? cached.lastModel;
          const id = d.id ?? null;
          if (id !== null && id === cached.lastCountedId) continue;
          cached.totalTokens += (d.tokens.total || 0) - (d.tokens.cached || 0);
          if (id !== null) cached.lastCountedId = id;
        }
      }
    }
  } finally {
    await fh.close();
  }
  return cached;
}

export async function discoverGeminiSessions() {
  const [pids, projectsMap] = await Promise.all([findLiveGeminiPids(), readProjectsMap()]);
  const now = Date.now();

  const results = await Promise.all(
    pids.map(async (pid) => {
      const cwd = await resolveGeminiCwd(pid);
      if (!cwd) return null;
      // Gemini CLI writes this entry itself the first time a cwd is used;
      // a brand-new cwd can lack one for a couple seconds at startup.
      const slug = projectsMap[cwd];
      if (!slug) return null;
      const chatFile = await findChatFileForSlug(slug);
      if (!chatFile) return null;
      const usage = await computeGeminiUsage(chatFile.path);
      const contextWindow = resolveContextWindowForModel(usage.lastModel);
      const contextTokens = usage.lastTokens?.total ?? null;
      const contextPct = contextWindow && contextTokens !== null
        ? Math.min(100, Math.round((contextTokens / contextWindow) * 100))
        : null;
      const state = now - chatFile.mtimeMs <= GEMINI_ACTIVE_MS ? 'running' : 'idle';
      return {
        agent: 'gemini',
        pid,
        sessionId: usage.sessionId,
        name: path.basename(cwd),
        cwd,
        kind: 'interactive',
        daemonStatus: null,
        state,
        stateSource: 'transcript',
        statusUpdatedAt: Math.round(chatFile.mtimeMs),
        transcriptPath: chatFile.path,
        contextTokens,
        contextWindow,
        contextPct,
        totalTokens: usage.totalTokens,
        model: usage.lastModel,
      };
    })
  );

  return results.filter(Boolean);
}

export async function readGeminiTranscriptTail(transcriptPath, maxBytes = 262144) {
  let fh;
  try {
    fh = await fs.open(transcriptPath, 'r');
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
    if (start > 0 && lines.length > 0) lines.shift();
    const events = [];
    for (const line of lines) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed.$set || !parsed.type) continue; // incremental patch / session header, not renderable
      events.push(parsed);
    }
    return events;
  } finally {
    await fh.close();
  }
}

