#!/usr/bin/env node
// Block until the next review event appears in the state dir, print it to
// stdout, then exit. Harness-agnostic: any agent can drive the review loop
// by re-running this script.
// exit codes: 0 = event printed, 2 = timeout, 3 = server dead and nothing pending.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function waitOnce(stateDir, timeoutMs, pollMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const names = fs.existsSync(stateDir) ? fs.readdirSync(stateDir) : [];
    const pending = names
      .map((n) => /^submission-(\d+)\.json$/.exec(n))
      .filter(Boolean)
      .map((m) => ({ name: m[0], seq: Number(m[1]) }))
      .sort((a, b) => a.seq - b.seq);
    if (pending.length) {
      const file = path.join(stateDir, pending[0].name);
      const output = fs.readFileSync(file, 'utf8');
      fs.renameSync(file, file + '.consumed');
      return { code: 0, output };
    }
    if (names.includes('done.json')) {
      return { code: 0, output: fs.readFileSync(path.join(stateDir, 'done.json'), 'utf8') };
    }
    const infoFile = path.join(stateDir, 'server-info.json');
    if (fs.existsSync(infoFile)) {
      let pid = null;
      try {
        pid = JSON.parse(fs.readFileSync(infoFile, 'utf8')).pid;
      } catch {
        // info file mid-write; treat as alive
      }
      if (pid) {
        try {
          process.kill(pid, 0);
        } catch (e) {
          if (e.code === 'ESRCH') {
            return { code: 3, output: JSON.stringify({ type: 'server-dead', pid }) };
          }
          // EPERM etc.: process exists but is not ours - treat as alive
        }
      }
    }
    if (Date.now() >= deadline) return { code: 2, output: '' };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  let stateDir;
  let timeoutSec = 540;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--state-dir') stateDir = args[++i];
    else if (args[i] === '--timeout-sec') timeoutSec = Number(args[++i]);
  }
  if (!stateDir) {
    console.error('usage: node wait_for_review.mjs --state-dir DIR [--timeout-sec N]');
    process.exit(1);
  }
  const { code, output } = await waitOnce(stateDir, timeoutSec * 1000);
  if (output) console.log(output);
  process.exit(code);
}
