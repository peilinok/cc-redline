// Per-test review server: a temp doc + state dir, the real server.mjs as a
// child process, and the URL read from server-info.json — the same file-based
// protocol the driving agent uses.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../skills/cc-redline/scripts/server.mjs', import.meta.url));

export const FIXTURE_MD = `Intro line before any heading.

# Alpha

First paragraph with **bold** text and \`code\`.

## Beta

- item one
- item two

| A | B |
|---|---|
| 1 | 2 |

\`\`\`js
const x = 1;
\`\`\`

\`\`\`mermaid
graph TD; A-->B;
\`\`\`

Inline $E=mc^2$ math.

# Gamma

Tail paragraph.
`;

export async function startReview({ doc = FIXTURE_MD } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-e2e-'));
  const mdPath = path.join(root, 'doc.md');
  fs.writeFileSync(mdPath, doc);
  const stateDir = path.join(root, 'state');
  const proc = spawn(process.execPath, [SERVER, mdPath, '--state-dir', stateDir, '--no-open'], {
    stdio: 'ignore',
  });
  const infoPath = path.join(stateDir, 'server-info.json');
  const deadline = Date.now() + 10_000;
  let info = null;
  while (!info && Date.now() < deadline) {
    try {
      info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  if (!info) {
    proc.kill();
    throw new Error('review server did not write server-info.json in time');
  }
  return {
    url: info.url,
    pid: info.pid,
    mdPath,
    stateDir,
    proc,
    stop() {
      try { proc.kill(); } catch { /* already gone */ }
    },
  };
}

// Poll until a file exists (e.g. submission-1.json / done.json), else throw.
export async function waitForFile(file, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${file}`);
}

// Poll until the child server process has exited.
export async function waitForExit(proc, timeoutMs = 8000) {
  if (proc.exitCode !== null) return proc.exitCode;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not exit')), timeoutMs);
    proc.once('exit', (code) => { clearTimeout(t); resolve(code); });
  });
}
