import { discoverClaudeSessions, readTranscriptTail, SESSIONS_DIR, PROJECTS_DIR } from './discover-claude.mjs';
import { discoverGeminiSessions, readGeminiTranscriptTail } from './discover-gemini.mjs';
import { discoverAntigravitySessions } from './discover-antigravity.mjs';

const STATE_RANK = {
  'needs-attention': 0,
  'idle-question': 1,
  running: 2,
  busy: 3,
  idle: 4,
};

// Each agent's discovery runs independently and is wrapped in try/catch so
// one broken/uninstalled agent (e.g. no `agy` binary at all) can't blank the
// whole dashboard.
async function discoverSafely(fn, label) {
  try {
    return await fn();
  } catch (e) {
    console.error(`fleet-monitor: ${label} discovery failed: ${e?.message ?? e}`);
    return [];
  }
}

export async function discoverSessions() {
  const [claude, gemini, antigravity] = await Promise.all([
    discoverSafely(discoverClaudeSessions, 'claude'),
    discoverSafely(discoverGeminiSessions, 'gemini'),
    discoverSafely(discoverAntigravitySessions, 'antigravity'),
  ]);

  const results = [...claude, ...gemini, ...antigravity];

  results.sort((a, b) => {
    const rankDiff = STATE_RANK[a.state] - STATE_RANK[b.state];
    if (rankDiff !== 0) return rankDiff;
    return (b.statusUpdatedAt ?? 0) - (a.statusUpdatedAt ?? 0);
  });

  return results;
}

export async function readTranscriptTail(session, maxBytes = 262144) {
  if (session.agent === 'gemini') {
    return readGeminiTranscriptTail(session.transcriptPath, maxBytes);
  }
  if (session.agent === 'antigravity') {
    return null; // signals "not supported" to the caller - see tui.mjs
  }
  return readClaudeTranscriptTail(session.transcriptPath, maxBytes);
}

export { SESSIONS_DIR, PROJECTS_DIR };
