#!/usr/bin/env node
/**
 * Run the test suite under a DSH_HOME of its own, and prove it stayed there.
 *
 * A real `deepseek-acp` records every session under DSH_HOME and keeps it
 * forever (this project's Grok Build ancestor: 80 sessions accumulated in
 * ~/.grok this way, each pointing at a scratch directory that had since been
 * deleted, and each able to crash the daemon on resume —
 * test/spawn-failure.test.ts).
 *
 * Two mechanisms, because one is not enough:
 *
 *   PREVENT  every test process inherits DSH_HOME pointing at a scratch dir,
 *            so forgetting to isolate costs nothing.
 *   DETECT   the real ~/.dsh is counted before and after. If the suite wrote
 *            there anyway — through a subprocess that resets the variable, say —
 *            this exits non-zero and names what leaked.
 *
 * Per-file discipline was tried first and drifted: `isolatedDshHome()` existed
 * and one of three tools used it.
 *
 * FIXED 2026-09-05: this wrapper still injected GROK_HOME and still snapshotted
 * ~/.grok/sessions after the deepseek-acp backend swap — an env var nothing
 * reads any more, and the wrong directory to watch. Both PREVENT and DETECT
 * were silently inert for this backend until now.
 */
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';

const REAL_SESSIONS = join(process.env.HOME ?? homedir(), '.dsh', 'sessions');

/**
 * Real leaks from forgetting DSH_HOME write sessions whose cwd is a scratch
 * dir (mkdtemp under os.tmpdir(), or a test-named path). Concurrent real
 * `deepseek-acp` work in a normal project also creates new session folders
 * during a long suite — that is not a suite leak. Only scratch cwds count as
 * DETECT hits.
 */
function isScratchCwd(cwd) {
  if (!cwd) return false;
  const t = tmpdir();
  if (cwd === t || cwd.startsWith(t + sep) || cwd.startsWith(t + '/')) return true;
  if (cwd.startsWith('/tmp/') || cwd.startsWith('/var/folders/')) return true;
  if (/dshrc-testhome|dshrc-leadertest|isolated-test|node-test-/.test(cwd)) return true;
  return false;
}

/** Every session id currently in the developer's real DeepSeek Harness history. */
async function snapshot() {
  const found = new Set();
  let groups;
  try {
    groups = await readdir(REAL_SESSIONS);
  } catch {
    return found; // no history yet — nothing to protect
  }
  for (const g of groups) {
    const dir = join(REAL_SESSIONS, g);
    try {
      if (!(await stat(dir)).isDirectory()) continue;
      for (const s of await readdir(dir)) found.add(`${decodeURIComponent(g)}::${s}`);
    } catch {
      /* raced with a delete, or not a directory */
    }
  }
  return found;
}

const before = await snapshot();
const home = await mkdtemp(join(tmpdir(), 'dshrc-testhome-'));

// Credentials come along, or a real agent cannot authenticate and the tests
// that genuinely exercise `deepseek-acp` fail for a reason that has nothing to
// do with them. Same file `isolatedDshHome()` copies, and same 0600 mode it
// needs (see that function's doc comment in harness.mjs) — a loose-mode copy
// makes deepseek-acp refuse to boot outright, not merely fail to authenticate.
const realHome = join(process.env.HOME ?? homedir(), '.dsh');
await copyFile(join(realHome, '.credentials.yaml'), join(home, '.credentials.yaml'), {
  mode: 0o600,
}).catch(() => {});

const child = spawn(process.execPath, process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, DSH_HOME: home },
});

const code = await new Promise((resolve) => {
  child.on('close', (c) => resolve(c ?? 1));
  child.on('error', () => resolve(1));
});

await rm(home, { recursive: true, force: true });

const after = await snapshot();
const newcomers = [...after].filter((s) => !before.has(s));
const leaked = newcomers.filter((s) => isScratchCwd(s.split('::')[0] ?? ''));
const concurrent = newcomers.filter((s) => !isScratchCwd(s.split('::')[0] ?? ''));

if (concurrent.length) {
  console.error(
    `\n  · ignored ${concurrent.length} new real ~/.dsh session(s) with non-scratch cwd` +
      ` (concurrent agent work, not a suite leak)\n`
  );
}

if (leaked.length) {
  console.error(`\n  ✗ the suite wrote ${leaked.length} session(s) into your real ~/.dsh:\n`);
  for (const s of leaked.slice(0, 10)) {
    const [cwd, id] = s.split('::');
    console.error(`      ${id}  cwd=${cwd}`);
  }
  console.error(
    '\n  These outlive their working directory and become unresumable clutter.\n' +
      '  Set DSH_HOME in the offending test before importing the daemon.\n'
  );
  process.exit(1);
}

process.exit(code);
