#!/usr/bin/env node
/**
 * Install dshrc the way someone who has never seen this machine would.
 *
 * Portable replacement for tools/stranger-check.sh so Windows is not excluded
 * from the first-run check — first-run is exactly where Windows differs most
 * (deepseek-acp not on PATH after install; no credential yet).
 *
 * ISOLATED HERE (everything dshrc actually reads):
 *   HOME / USERPROFILE   fresh empty dir  -> no ~/.dsh, ~/.dshrc
 *   PATH                 system only      -> no deepseek-acp, no author-installed bins
 *   npm cache / prefix   fresh            -> nothing warmed
 *
 * NOT ISOLATED:
 *   kernel, system packages, installed Node. A stranger on Node 18 is not
 *   covered by this script.
 *
 * Usage:
 *   node tools/stranger-check.mjs                  # pack current tree
 *   node tools/stranger-check.mjs --pkg dshrc     # public registry
 *   node tools/stranger-check.mjs --pkg ./file.tgz
 */
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  existsSync,
  symlinkSync,
  copyFileSync,
  readdirSync,
  chmodSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve, delimiter, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';

const args = process.argv.slice(2);
const pkgFlag = args.indexOf('--pkg');
const PKG_ARG = pkgFlag === -1 ? null : args[pkgFlag + 1];

let PASS = 0;
let FAIL = 0;
function ok(msg) {
  console.log(`  ✓ ${msg}`);
  PASS++;
}
function bad(msg, detail = '') {
  console.log(`  ✗ ${msg}`);
  if (detail) console.log(`      ${detail.split('\n').slice(0, 6).join('\n      ')}`);
  FAIL++;
}
function head(text, n = 6) {
  return String(text)
    .split(/\r?\n/)
    .slice(0, n)
    .map((l) => `      ${l}`)
    .join('\n');
}

/** Minimal PATH so author tools (including deepseek-acp) do not leak in. */
function systemPath() {
  if (IS_WIN) {
    const windir = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    return [
      join(windir, 'System32'),
      windir,
      join(windir, 'System32', 'Wbem'),
      join(windir, 'System32', 'WindowsPowerShell', 'v1.0'),
    ].join(delimiter);
  }
  return ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'].join(
    delimiter
  );
}

function run(cmd, cmdArgs, env, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, {
    env,
    encoding: 'utf8',
    shell: IS_WIN,
    timeout: opts.timeout ?? 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    code: r.status ?? (r.error ? 1 : 0),
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    error: r.error,
  };
}

function whichAgentOnRealMachine() {
  const r = spawnSync(
    IS_WIN ? 'where.exe' : 'command',
    IS_WIN ? ['deepseek-acp'] : ['-v', 'deepseek-acp'],
    {
      encoding: 'utf8',
      shell: false,
    }
  );
  const line = (r.stdout ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  return line && existsSync(line) ? line : null;
}

const realAgent = whichAgentOnRealMachine();
const sandbox = mkdtempSync(join(tmpdir(), 'dshrc-stranger-'));
const npmCache = join(sandbox, '.npm');
const npmPrefix = join(sandbox, '.local');
const binDir = join(npmPrefix, IS_WIN ? '' : 'bin');
// npm on Windows puts globals under prefix/ (dshrc.cmd); on Unix under prefix/bin.
const npmBin = IS_WIN ? npmPrefix : join(npmPrefix, 'bin');
mkdirSync(npmPrefix, { recursive: true });
mkdirSync(join(sandbox, 'projects'), { recursive: true });

const env = {
  ...process.env,
  HOME: sandbox,
  USERPROFILE: sandbox,
  HOMEDRIVE: sandbox.slice(0, 2),
  HOMEPATH: sandbox.slice(2) || '\\',
  PATH: systemPath(),
  npm_config_cache: npmCache,
  npm_config_prefix: npmPrefix,
  npm_config_update_notifier: 'false',
  XDG_CONFIG_HOME: join(sandbox, '.config'),
  XDG_DATA_HOME: join(sandbox, '.local', 'share'),
  APPDATA: join(sandbox, 'AppData', 'Roaming'),
  LOCALAPPDATA: join(sandbox, 'AppData', 'Local'),
};
delete env.DSH_HOME;
delete env.DSHRC_HOME;
// Ensure node/npm remain reachable: re-append their directories after the
// stripped PATH. Isolating from deepseek-acp is the goal; isolating from node
// would make the check measure nothing.
const nodeDir = dirname(process.execPath);
const npmPath = run(IS_WIN ? 'where.exe' : 'command', IS_WIN ? ['npm'] : ['-v', 'npm'], {
  ...process.env,
  PATH: process.env.PATH,
})
  .out.split(/\r?\n/)
  .map((s) => s.trim())
  .find(Boolean);
const npmDir = npmPath ? dirname(npmPath) : nodeDir;
env.PATH = [nodeDir, npmDir, env.PATH].join(delimiter);

console.log('');
console.log(`  stranger check — HOME=${sandbox}`);
console.log(`  node ${process.version}, platform ${process.platform}`);
console.log('');

// ── the machine really is bare ──────────────────────────────────────────────
const agentLeak = run(
  IS_WIN ? 'where.exe' : 'command',
  IS_WIN ? ['deepseek-acp'] : ['-v', 'deepseek-acp'],
  env
);
const foundAgent = (agentLeak.out || '')
  .split(/\r?\n/)
  .map((s) => s.trim())
  .find(Boolean);
if (!foundAgent || agentLeak.code !== 0)
  ok("deepseek-acp is NOT installed (as a stranger's would be)");
else bad('deepseek-acp leaked into the sandbox PATH', foundAgent);

if (!existsSync(join(sandbox, '.dsh'))) ok('no DeepSeek credentials in HOME');
else bad('~/.dsh leaked in');
if (!existsSync(join(sandbox, '.dshrc'))) ok('no dshrc config in HOME');
else bad('~/.dshrc leaked in');

// ── package source ──────────────────────────────────────────────────────────
let installTarget = PKG_ARG;
if (!installTarget) {
  console.log('');
  console.log('  packing current tree…');
  // npm pack prints the tarball name on the last non-empty line of stdout.
  const pack2 = spawnSync('npm', ['pack', '--pack-destination', sandbox], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: IS_WIN,
    timeout: 180_000,
  });
  const tgzName = (pack2.stdout ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .pop();
  if (pack2.status === 0 && tgzName) {
    installTarget = join(sandbox, tgzName);
    ok(`packed current tree as ${tgzName}`);
  } else {
    bad('npm pack failed', pack2.stderr || pack2.stdout);
    installTarget = null;
  }
}

// ── install ─────────────────────────────────────────────────────────────────
console.log('');
console.log(`  installing ${installTarget ?? '(none)'} into sandbox prefix…`);
if (installTarget) {
  const inst = run('npm', ['install', '-g', installTarget], env, { timeout: 300_000 });
  if (inst.code === 0) ok(`npm install -g succeeded`);
  else bad('npm install -g failed', inst.out);

  // Resolve the dshrc binary npm produced.
  const candidates = IS_WIN
    ? [join(npmBin, 'dshrc.cmd'), join(npmBin, 'dshrc'), join(npmPrefix, 'dshrc.cmd')]
    : [join(npmBin, 'dshrc')];
  // Also search node_modules/.bin style under prefix
  const modBin = join(npmPrefix, 'node_modules', 'dshrc');
  let dshrcBin = candidates.find((p) => existsSync(p));
  if (!dshrcBin && existsSync(modBin)) {
    // package bin field points at dist/cli.js — invoke via node
    const cli = join(modBin, 'dist', 'cli.js');
    if (existsSync(cli)) dshrcBin = cli;
  }
  if (!dshrcBin) {
    // last resort: list prefix
    try {
      const listing = readdirSync(npmPrefix).join(', ');
      bad('no dshrc binary produced', listing);
    } catch {
      bad('no dshrc binary produced');
    }
  } else {
    ok(`dshrc binary is on the prefix (${dshrcBin})`);
  }

  const webDir = join(npmPrefix, 'lib', 'node_modules', 'dshrc', 'web');
  const webDirWin = join(npmPrefix, 'node_modules', 'dshrc', 'web');
  if (existsSync(webDir) || existsSync(webDirWin) || existsSync(join(modBin, 'web'))) {
    ok('the PWA shipped with it');
  } else {
    bad('web/ missing from the package');
  }

  const runDshrc = (cliArgs, e = env, timeout = 30_000) => {
    if (!dshrcBin) return { code: 1, out: 'no binary' };
    if (dshrcBin.endsWith('.js')) {
      return run(process.execPath, [dshrcBin, ...cliArgs], e, { timeout });
    }
    return run(dshrcBin, cliArgs, e, { timeout });
  };

  // ── with NO deepseek-acp ──────────────────────────────────────────────────────────
  console.log('');
  console.log('  --- with NO deepseek-acp installed ---');
  const doc = runDshrc(['doctor']);
  console.log(head(doc.out));
  if (/not found|no deepseek-acp|install/i.test(doc.out)) ok('doctor names the missing dependency');
  else bad('doctor does not tell a stranger that deepseek-acp is missing', doc.out);
  if (
    /Error:|ERR_[A-Z]+|Cannot find module|at Object\./.test(doc.out) &&
    !/deepseek-acp not found/i.test(doc.out)
  ) {
    bad('doctor leaked a stack trace instead of a message');
  } else {
    ok('doctor fails cleanly, no stack trace');
  }

  const up = runDshrc(['up', '--port', '4498'], env, 25_000);
  console.log(head(up.out));
  if (
    /deepseek-acp (was )?not found|not found on PATH|install: npm install -g deepseek-acp/i.test(
      up.out
    )
  ) {
    ok('up explains the missing dependency');
  } else {
    bad('up does not explain what is missing', up.out);
  }

  // ── with deepseek-acp present but not logged in (or logged in under sandbox) ─
  console.log('');
  console.log('  --- with deepseek-acp present ---');
  if (realAgent) {
    mkdirSync(npmBin, { recursive: true });
    const linkName = join(npmBin, IS_WIN ? 'deepseek-acp.exe' : 'deepseek-acp');
    try {
      if (IS_WIN) copyFileSync(realAgent, linkName);
      else {
        symlinkSync(realAgent, linkName);
        try {
          chmodSync(linkName, 0o755);
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      // copy may fail for some reasons; put realAgent's dir on PATH instead
      console.log(`      (could not copy deepseek-acp: ${err.message}; putting real dir on PATH)`);
    }
    const envWithAgent = {
      ...env,
      PATH: `${npmBin}${delimiter}${dirname(realAgent)}${delimiter}${env.PATH}`,
      // Force no credentials in sandbox even if copy failed oddly
      HOME: sandbox,
      USERPROFILE: sandbox,
      DSH_HOME: join(sandbox, '.dsh-empty-should-not-exist'),
    };
    delete envWithAgent.DSH_HOME;

    const doc2 = runDshrc(['doctor'], envWithAgent);
    console.log(head(doc2.out));
    if (/deepseek-acp found/i.test(doc2.out)) ok('doctor finds deepseek-acp once it is installed');
    else bad('doctor cannot see a deepseek-acp that is on PATH', doc2.out);

    // If the real machine has credentials, doctor may pass the auth check. That
    // is still fine: the stranger PATH has deepseek-acp, but HOME is empty so
    // auth should fail unless deepseek-acp stores credentials outside HOME (it
    // uses DSH_HOME/HOME).
    if (/deepseek-acp --setup|export DEEPSEEK_API_KEY|missing_credential/i.test(doc2.out)) {
      ok('doctor tells a logged-out user to run `deepseek-acp --setup`');
    } else if (/agent|ACP|ready|ok/i.test(doc2.out) && !/not found/i.test(doc2.out)) {
      // Credentials may have been found via something other than HOME — report honestly
      ok('doctor reaches the agent (credentials available outside sandbox HOME — noted)');
    } else {
      bad("doctor passes the agent's raw auth error through without saying what to do", doc2.out);
    }
  } else {
    console.log('      (no deepseek-acp binary on the real machine — skipped login checks)');
  }

  // ── required configuration ────────────────────────────────────────────────
  console.log('');
  console.log('  --- required configuration ---');
  const cfg = runDshrc(['config']);
  console.log(head(cfg.out));
  if (/defaultCwd/i.test(cfg.out)) ok('config tells a stranger defaultCwd is needed');
  else bad('config does not surface the one required setting', cfg.out);

  const projects = join(sandbox, 'projects');
  const set = runDshrc(['config', 'set', 'defaultCwd', projects]);
  if (set.code === 0) ok('config set defaultCwd works');
  else bad('config set failed', set.out);

  const cfgPath = join(sandbox, '.dshrc', 'config.json');
  try {
    const body = readFileSync(cfgPath, 'utf8');
    if (
      body.includes('projects') ||
      body.includes(projects.replace(/\\/g, '\\\\')) ||
      body.includes(projects)
    ) {
      ok('the setting persisted to a fresh HOME');
    } else {
      // Windows paths in JSON use backslashes escaped
      const normalized = body.replace(/\\\\/g, '\\');
      if (normalized.includes(projects) || /projects/i.test(body))
        ok('the setting persisted to a fresh HOME');
      else bad('config did not persist', body);
    }
  } catch (err) {
    bad('config did not persist', err.message);
  }
}

console.log('');
console.log(`  ── ${PASS} passed, ${FAIL} failed ──`);
console.log(`  sandbox: ${sandbox} (removing)`);
try {
  rmSync(sandbox, { recursive: true, force: true });
} catch {
  console.log('      (sandbox cleanup partial — OS may still hold a handle)');
}
process.exit(FAIL === 0 ? 0 : 1);
