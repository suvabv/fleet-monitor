import { promises as fs } from 'node:fs';
import path from 'node:path';

function agyAfterComm(statRaw) {
  return statRaw.slice(statRaw.lastIndexOf('(') + 1).trim().split(/\s+/);
}

async function findLiveAgyPids() {
  let entries;
  try {
    entries = await fs.readdir('/proc');
  } catch {
    return [];
  }

  const pids = [];
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
    if (args.length === 0) continue;
    if (path.basename(args[0]) === 'agy') pids.push(pid);
  }

  return pids;
}

async function resolveAgyCwd(pid) {
  try {
    return await fs.readlink(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

async function agyProcessStartTime(pid) {
  try {
    const [statRaw, procstatRaw] = await Promise.all([
      fs.readFile(`/proc/${pid}/stat`, 'utf8'),
    ]);

    const fields = agyAfterComm(statRaw);
    const starttimeTicks = Number(fields[19]); // field 22 overall, index 19 after comm+state+ppid
    const btimeMatch = procstatRaw.match(/btime (\d+)/m);
    if (!btimeMatch || isNaN(starttimeTicks)) return null;
    const CLK_TCK = 100; // not exposed via /proc; 100 is the universal Linux value in practice
    return Math.round((Number(btimeMatch[1]) + starttimeTicks / CLK_TCK) * 1000);
  } catch {
    return null;
  }
}

export async function discoverAntigravitySessions() {
  const pids = await findLiveAgyPids();
  const results = await Promise.all(
    pids.map(async (pid) => {
      const cwd = await resolveAgyCwd(pid);
      if (!cwd) return null;
      const statusUpdatedAt = await agyProcessStartTime(pid);
      return {
        agent: 'antigravity',
        pid,
        sessionId: null,
        name: path.basename(cwd),
        cwd,
        kind: 'interactive',
        daemonStatus: null,
        state: 'running',
        stateSource: 'process',
        statusUpdatedAt,
        transcriptPath: null,
        contextTokens: null,
        contextWindow: null,
        contextPct: null,
        totalTokens: null,
        model: null,
      };
    })
  );
  return results.filter(Boolean);
}
