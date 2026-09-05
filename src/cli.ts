#!/usr/bin/env node
/**
 * dshrc — remote control for DeepSeek Harness, via `deepseek-acp`
 * (github.com/xintaofei/deepseek-acp), an editor-facing ACP server over the
 * dsh core.
 *
 *   dshrc up [--port N] [--host H] [--model M] [--cwd DIR]
 *   dshrc pair
 *   dshrc devices
 *   dshrc revoke <deviceId|--all>
 *   dshrc doctor
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AuthStore } from './daemon/auth.ts';
import { isStrictlyInside } from './paths.ts';
import {
  CONFIG_KEYS,
  applyReload,
  coerceValue,
  configPath,
  isKnownKey,
  loadConfig,
  missingCwdNotice,
  saveConfig,
  validateConfig,
} from './daemon/config.ts';
import { ControlServer, ControlUnavailableError, controlRequest } from './daemon/control.ts';
import { checkPermissionPosture, posturteWarning } from './daemon/preflight.ts';
import { PushService } from './daemon/push.ts';
import { SessionManager, encodeDshCwd } from './daemon/session-manager.ts';
import { RemoteControlServer } from './daemon/server.ts';

const execFileAsync = promisify(execFile);
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_ROOT = resolve(PKG_ROOT, 'web');

interface Flags {
  [k: string]: string | boolean;
}

function parseArgs(argv: string[]): { cmd: string; rest: string[]; flags: Flags } {
  const flags: Flags = {};
  const rest: string[] = [];
  let cmd = 'help';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1]!.startsWith('-')) flags[a.slice(2)] = argv[++i]!;
      else flags[a.slice(2)] = true;
    } else if (cmd === 'help' && !rest.length) cmd = a;
    else rest.push(a);
  }
  return { cmd, rest, flags };
}

function lanAddress(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

const HELP = `
dshrc — remote control for DeepSeek Harness

  dshrc up          Start the daemon and serve the phone client
      --port <N>       Port (default 4319)
      --host <H>       Bind address (default 127.0.0.1 — loopback only)
      --lan            Bind 0.0.0.0 so other devices on your network can reach it
      --model <M>      Model override for new sessions (sets DEEPSEEK_ACP_MODEL
                       on the spawned agent — deepseek-acp has no --model flag)
      --cwd <DIR>      Default working directory for new sessions
      --agent-command <PATH>  deepseek-acp binary to spawn (default: deepseek-acp on PATH)
      --pair           Print a pairing code even if devices are already paired
      --history <N>    How many past sessions to list (default 10)
      --no-push        Disable Web Push (no VAPID keys, no subscriptions)
      --relay <URL>    Dial OUT to a relay — no inbound port, works on cellular
      --room <ID>      Relay room id (generated if omitted)
      --relay-key <K>  Relay room key (generated if omitted)

  dshrc relay       Run a self-hostable relay server
      --port <N>       Port (default 8080)

  dshrc term        Terminal client on the same session your phone drives
      --new            Start a new session
      --session <id>   Open a specific session
      --url <URL>      Daemon URL (default ws://127.0.0.1:4319)

  dshrc pair        Print a pairing code for a new device (needs a running daemon)
  dshrc config      Show settings  ·  config set <key> <value>  ·  config unset <key>
  dshrc devices     List paired devices
  dshrc revoke <id> Revoke a device  (--all to revoke everything)
  dshrc doctor      Check that deepseek-acp is installed and ACP responds

  --leader and --permission-mode are accepted for compatibility with this
  project's Grok Build ancestor but have no effect against deepseek-acp: it
  has no shared-backend "leader" concept, and its sandbox always asks before
  a tool runs outside the session cwd — see README "Why the fork" for detail.
`;

/**
 * The agent binary's version string, or null when it is not installed.
 *
 * Shared by `doctor` and `up`: a daemon that cannot spawn an agent is not a
 * degraded daemon, it is a useless one. `up` used to start anyway, print a
 * config warning, and listen — so a new user paired a phone and only discovered
 * the problem when every session failed.
 */
async function findAgent(command = 'deepseek-acp'): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, ['--version']);
    return stdout.trim();
  } catch {
    return null;
  }
}

const AGENT_MISSING = (command: string) =>
  `  \u2717 ${command} not found on PATH \u2014 install: npm install -g deepseek-acp`;

/** Addresses that genuinely cannot be reached from another machine. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '0:0:0:0:0:0:0:1']);

/**
 * What the bind address actually means for exposure.
 *
 * This used to be a two-way branch: `0.0.0.0` warned, and EVERYTHING ELSE was
 * announced as "loopback only". So `dshrc up --host 100.119.149.50` — a
 * Tailscale address, reachable by every machine on the tailnet — printed
 *
 *     loopback only. Use --lan to reach it from your phone, or tunnel it.
 *
 * which is the opposite of the truth, and the direction that matters: it
 * understates exposure, and it does so for the ONE remote-code-execution
 * surface this program has. Measured by binding to this machine's own tailnet
 * address and reading what it said.
 *
 * Exported so the claim is testable without binding a socket.
 */
export function exposureNotice(host: string, shown: string): string {
  if (host === '0.0.0.0' || host === '::') {
    return '  ⚠ bound to all interfaces — keep this on a trusted network or a Tailnet.';
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    return (
      `  ⚠ reachable from other machines on ${shown} — this is not loopback.\n` +
      '    Keep it on a trusted network or a Tailnet.'
    );
  }
  return '  loopback only. Use --lan to reach it from your phone, or tunnel it.';
}

async function cmdUp(flags: Flags): Promise<void> {
  // Before anything else. Starting without an agent means pairing a phone to a
  // daemon that cannot open a single session.
  const agentCommand = typeof flags['agent-command'] === 'string' ? flags['agent-command'] : 'deepseek-acp';
  const agentVersion = await findAgent(agentCommand);
  if (!agentVersion) {
    console.log('');
    console.log(AGENT_MISSING(agentCommand));
    console.log('    dshrc drives DeepSeek Harness via deepseek-acp — it cannot start a session without it.');
    console.log('    After installing, either run `deepseek-acp --setup` once, or export DEEPSEEK_API_KEY.');
    console.log('');
    process.exitCode = 1;
    return;
  }

  // Settings are the durable answer; flags override for this invocation only.
  const cfg = await loadConfig();
  const issues = validateConfig(cfg);
  if (issues.length) {
    console.log(`\n  ⚠ problems in ${configPath()}:`);
    for (const i of issues) console.log(`      ${i.key}: ${i.message}`);
    console.log('');
    if (issues.some((i) => i.fatal)) process.exit(1);
  }

  const auth = new AuthStore();
  await auth.load();

  const push = new PushService();
  if (flags['no-push'] !== true) await push.load();

  const sessions = new SessionManager({
    agentCommand,
    model: typeof flags.model === 'string' ? flags.model : cfg.model,
    // Grok Build-only fields, accepted but inert against deepseek-acp — see
    // StdioTransportOptions in src/acp/transport.ts.
    useLeader: flags.leader === true || cfg.leader === true,
    permissionMode:
      typeof flags['permission-mode'] === 'string'
        ? flags['permission-mode']
        : (cfg.permissionMode ?? 'auto'),
  });

  const lan = flags.lan === true || cfg.lan === true;
  const host = lan ? '0.0.0.0' : ((flags.host as string) ?? cfg.host ?? '127.0.0.1');
  const port = Number(flags.port ?? cfg.port ?? 4319);

  // The one setting with no safe default — see config.ts.
  const defaultCwd =
    typeof flags.cwd === 'string' ? resolve(flags.cwd) : (cfg.defaultCwd ?? process.cwd());

  const server = new RemoteControlServer({
    host,
    port,
    webRoot: WEB_ROOT,
    sessions,
    auth,
    push: flags['no-push'] === true ? undefined : push,
    defaultCwd,
    historyLimit: flags.history !== undefined ? Number(flags.history) : cfg.historyLimit,
  });

  // Say so loudly if the agent will never ask for approval — otherwise the
  // headline feature silently does nothing and tools run unattended.
  const posture = await checkPermissionPosture();
  const warning = posturteWarning(posture);
  if (warning) console.log(warning);

  // No configured project directory means phone-created sessions land wherever
  // the process happens to be — under systemd, the user's home.
  if (!cfg.defaultCwd && typeof flags.cwd !== 'string') console.log(missingCwdNotice());

  const bound = await server.listen();
  const shown = host === '0.0.0.0' ? (lanAddress() ?? '0.0.0.0') : host;

  if (typeof flags.relay === 'string') {
    const room = typeof flags.room === 'string' ? flags.room : randomBytes(6).toString('hex');
    const key =
      typeof flags['relay-key'] === 'string' ? flags['relay-key'] : randomBytes(16).toString('hex');
    // base64url, matching web/crypto.js
    const secret = flags['no-e2e'] === true ? undefined : randomBytes(32).toString('base64url');

    server.connectRelay({ url: flags.relay, room, key, secret });

    const httpUrl = flags.relay.replace(/^ws/, 'http');
    // The secret goes in the FRAGMENT — browsers never send it to the relay.
    const frag = secret ? `#e=${secret}` : '';
    console.log(`\n  relay: ${flags.relay}`);
    console.log(`  phone URL: ${httpUrl}/client?room=${room}&key=${key}${frag}`);
    console.log('  (no inbound port needed — this machine dials out)');
    console.log(
      secret
        ? '  end-to-end encrypted: the secret is in the URL fragment, which the relay never receives'
        : '  ⚠ --no-e2e: the relay can read everything on this connection'
    );
  }

  console.log(`\n  dshrc listening on http://${shown}:${bound.port}`);
  console.log(exposureNotice(host, shown));

  // Print a code when nothing is paired, or whenever --pair is asked for.
  // Without the second case, adding a SECOND device (you paired on the desktop,
  // now you want your phone) was impossible — the code lives in the running
  // daemon's memory and `dshrc pair` cannot reach it.
  if (auth.devices.length === 0 || flags.pair === true) {
    const { code } = auth.beginPairing();
    const lead =
      auth.devices.length === 0
        ? 'No paired devices. Open the URL above on your device and enter:'
        : `${auth.devices.length} device(s) already paired. To add another, enter:`;
    console.log(`\n  ${lead}\n`);
    console.log(`      ${code}\n`);
    console.log('  (valid 5 minutes, single use)');
  } else {
    console.log(
      `  ${auth.devices.length} paired device(s). Restart with \`--pair\` to add another.`
    );
  }
  console.log('');

  // The CLI's way in to this process. Without it `dshrc pair` can only ask you
  // to restart, which drops every live session to hand out six characters.
  const control = new ControlServer({
    pair: () => auth.beginPairing(),
    devices: () => {
      const live = server.connectedDeviceIds();
      return auth.devices.map((d) => ({
        id: d.id,
        name: d.name,
        pairedAt: d.pairedAt,
        lastSeen: d.lastSeen,
        connected: live.has(d.id),
      }));
    },
    revoke: async (id) => {
      const ok = await auth.revoke(id);
      // Revoking in the store alone leaves an already-connected phone driving
      // the agent until it happens to reconnect.
      if (ok) server.disconnectDevice(id);
      return ok;
    },
    revokeAll: async () => {
      const ids = auth.devices.map((d) => d.id);
      await auth.revokeAll();
      for (const id of ids) server.disconnectDevice(id);
      return ids.length;
    },
    /**
     * Re-read the settings file and apply what can be applied.
     *
     * Honest by construction: it returns which keys actually took effect and
     * which still need a restart. host/port/lan cannot change on a bound
     * socket, and reporting them as applied would be a lie that only surfaces
     * later, when the daemon is still on the old port.
     */
    // The logic lives in applyReload so the test can drive THIS code rather than
    // a reimplementation of it. See src/daemon/config.ts.
    reload: async () => applyReload(await loadConfig(), cfg, defaultCwd, { server, sessions }),

    status: () => ({
      pid: process.pid,
      host: shown,
      port: bound.port,
      devices: auth.devices.length,
      connected: server.connectedDeviceIds().size,
      sessions: sessions.list().length,
      push: push.subscriberCount,
      // Delivery counters live in memory and are never written to disk, so a
      // second process reading push-subscriptions.json sees 0 sent forever.
      // `doctor` reported exactly that while this daemon had delivered two.
      pushStats: push.stats,
      pushLastError: push.lastError,
    }),
  });

  try {
    await control.listen();
  } catch (err) {
    // A control channel that will not start must not stop the daemon serving
    // phones — it only costs you `dshrc pair` without a restart.
    console.log(`  ⚠ control socket unavailable: ${(err as Error).message}`);
  }

  const shutdown = async () => {
    console.log('\nshutting down…');
    sessions.closeAll();
    await control.close();
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

async function cmdPair(): Promise<void> {
  try {
    const { code, expiresAt } = await controlRequest<{ code: string; expiresAt: number }>('pair');
    const mins = Math.max(0, Math.round((expiresAt - Date.now()) / 60_000));
    console.log(`\n  Enter this on the device you are pairing:\n`);
    console.log(`      ${code}\n`);
    console.log(`  (valid ${mins} minutes, single use)\n`);
  } catch (err) {
    if (!(err instanceof ControlUnavailableError)) {
      console.log(`\n  could not reach the daemon: ${(err as Error).message}\n`);
      process.exitCode = 1;
      return;
    }
    // No daemon: a code minted here would live in a process that is about to
    // exit, and nothing could redeem it. Say that instead of printing one.
    console.log(
      '\n  No dshrc daemon is running — a code issued here could never be redeemed.\n' +
        '  Start one with `dshrc up`, then run `dshrc pair` again.\n'
    );
    process.exitCode = 1;
  }
}

async function cmdDevices(): Promise<void> {
  interface Row {
    id: string;
    name: string;
    pairedAt: number;
    lastSeen: number;
    connected: boolean;
  }

  let rows: Row[];
  let live = true;
  try {
    ({ devices: rows } = await controlRequest<{ devices: Row[] }>('devices'));
  } catch (err) {
    if (!(err instanceof ControlUnavailableError)) {
      console.log(`\n  could not reach the daemon: ${(err as Error).message}\n`);
      process.exitCode = 1;
      return;
    }
    // No daemon — the store on disk still answers who is paired, just not who
    // is connected. Degrade rather than fail.
    const auth = new AuthStore();
    await auth.load();
    rows = auth.devices.map((d) => ({ ...d, connected: false }));
    live = false;
  }

  if (rows.length === 0) return console.log('\n  no paired devices\n');

  console.log('');
  for (const d of rows) {
    const dot = live ? (d.connected ? '●' : '○') : ' ';
    console.log(
      `  ${dot} ${d.id}  ${d.name.slice(0, 40).padEnd(40)}  paired ${new Date(d.pairedAt).toLocaleString()}  last seen ${new Date(d.lastSeen).toLocaleString()}`
    );
  }
  console.log(
    live
      ? '\n  ● connected now   ○ paired, not connected\n'
      : '\n  (no daemon running — connection state unknown)\n'
  );
}

async function cmdRevoke(rest: string[], flags: Flags): Promise<void> {
  const all = flags.all === true;
  const id = rest[0];
  if (!all && !id) return console.log('  usage: dshrc revoke <deviceId> | --all');

  try {
    const { revoked } = await controlRequest<{ revoked: number }>(
      'revoke',
      all ? { all: true } : { deviceId: id }
    );
    if (all) return console.log(`  revoked ${revoked} device(s); their sockets were closed`);
    console.log(revoked ? `  revoked ${id}; its socket was closed` : `  no such device: ${id}`);
  } catch (err) {
    if (!(err instanceof ControlUnavailableError)) {
      console.log(`\n  could not reach the daemon: ${(err as Error).message}\n`);
      process.exitCode = 1;
      return;
    }
    // No daemon: write to the store directly. Nothing is connected, so there
    // is no socket to close.
    const auth = new AuthStore();
    await auth.load();
    if (all) {
      await auth.revokeAll();
      return console.log('  all devices revoked');
    }
    console.log((await auth.revoke(id!)) ? `  revoked ${id}` : `  no such device: ${id}`);
  }
}

/**
 *   dshrc config                       show current settings
 *   dshrc config set <key> <value>
 *   dshrc config unset <key>
 */
async function cmdConfig(rest: string[]): Promise<void> {
  const cfg = await loadConfig();
  const [action, key, ...valueParts] = rest;

  if (!action || action === 'show' || action === 'list') {
    console.log(`\n  ${configPath()}\n`);
    if (Object.keys(cfg).length === 0) console.log('  (empty — nothing configured yet)');
    for (const k of CONFIG_KEYS) {
      const v = cfg[k];
      if (v !== undefined) console.log(`  ${k.padEnd(14)} ${JSON.stringify(v)}`);
    }
    if (!cfg.defaultCwd) console.log(missingCwdNotice());
    else console.log('');
    return;
  }

  if (action === 'set') {
    if (!key || !isKnownKey(key)) {
      console.log(`\n  unknown key: ${key ?? '(none)'}`);
      console.log(`  valid keys: ${CONFIG_KEYS.join(', ')}\n`);
      process.exitCode = 1;
      return;
    }
    const raw = valueParts.join(' ');
    if (!raw) {
      console.log(`\n  usage: dshrc config set ${key} <value>\n`);
      process.exitCode = 1;
      return;
    }
    // Resolve paths relative to where the user is standing, so `config set
    // defaultCwd .` does the obvious thing.
    const value = key === 'defaultCwd' ? resolve(raw) : coerceValue(key, raw);
    const next = { ...cfg, [key]: value };

    const issues = validateConfig(next);
    const bad = issues.find((i) => i.key === key);
    if (bad) {
      console.log(`\n  ${key} ${bad.message}: ${JSON.stringify(value)}\n`);
      process.exitCode = 1;
      return;
    }

    await saveConfig(next);
    console.log(`\n  ${key} = ${JSON.stringify(value)}`);
    console.log(`  saved to ${configPath()}`);

    // Tell the running daemon, rather than telling the user to restart it.
    // "restart to apply" was printed unconditionally, including for settings
    // that a running daemon reads per-use and could have picked up instantly.
    try {
      const r = await controlRequest<{ applied: string[]; needsRestart: string[] }>('reload');
      if (r.applied.includes(key)) {
        console.log('  applied to the running daemon — no restart needed\n');
      } else if (r.needsRestart.includes(key)) {
        console.log('  the daemon is already bound to its address:');
        console.log('  restart to apply:  systemctl --user restart dshrc\n');
      } else {
        console.log('  the running daemon has re-read its settings\n');
      }
    } catch {
      // No daemon: nothing to apply, and nothing to restart either.
      console.log('  no daemon running — it will be picked up on start\n');
    }
    return;
  }

  if (action === 'unset') {
    if (!key || !isKnownKey(key)) {
      console.log(`\n  unknown key: ${key ?? '(none)'}\n`);
      process.exitCode = 1;
      return;
    }
    const next = { ...cfg };
    delete next[key];
    await saveConfig(next);
    console.log(`\n  ${key} unset\n`);
    return;
  }

  console.log('\n  usage: dshrc config [show | set <key> <value> | unset <key>]\n');
  process.exitCode = 1;
}

/**
 * Delete a session directory this process created.
 *
 * Only ever called with an id we just minted, and the path is re-derived the
 * same way the session manager builds it. Best-effort: a diagnostic failing to
 * tidy up must not fail the diagnostic.
 */
export async function removeSessionDir(sessionId: string, cwd: string): Promise<void> {
  try {
    const { rm } = await import('node:fs/promises');
    const { homedir } = await import('node:os');
    const dshHome = process.env.DSH_HOME ?? resolve(homedir(), '.dsh');
    const dir = resolve(dshHome, 'sessions', encodeDshCwd(cwd), sessionId);
    // Refuse to delete anything that is not inside the session store.
    if (!isStrictlyInside(resolve(dshHome, 'sessions'), dir)) return;
    await rm(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/**
 * Turn an agent error into an instruction, or null when there is nothing to add.
 *
 * Grok said "Authentication required (-32000)". True, and useless to someone
 * who has just installed this: it names no command. `deepseek-acp` says
 * `MISSING_CREDENTIAL` on the first turn when no key is configured (it never
 * returns ACP's own `auth_required` — see its README) — matched alongside the
 * Grok-era phrasing so this still recognises either backend's wording.
 *
 * Exported and pure so it can be tested on a machine with no agent — the guard
 * for this control was UNPROVABLE on CI, because the only test that exercised
 * it needed a real agent binary on PATH and silently skipped itself. A skipped
 * test counts as a pass, so the guard reported "passes without the control".
 */
export function authHint(message: string): string | null {
  if (!/auth|unauthori[sz]ed|not logged in|-32000|missing_credential/i.test(message)) return null;
  return '      no DeepSeek API key configured — run:  deepseek-acp --setup  (or export DEEPSEEK_API_KEY)';
}

interface DaemonStatus {
  pid: number;
  host: string;
  port: number;
  devices: number;
  connected: number;
  sessions: number;
  push: number;
  pushStats?: { sent: number; failed: number; expired: number };
  pushLastError?: { message: string; endpoint?: string } | null;
}

/**
 * Report the RUNNING daemon, when there is one.
 *
 * `doctor` used to answer every question by itself: spawn an agent, load a
 * PushService off disk, read the config. That is right for someone who has not
 * started anything yet, and wrong for everyone else — delivery counters live in
 * the daemon's memory, so a second process reads 0 sent no matter how many
 * pushes went out. It reported "0 sent" while the daemon had delivered two.
 */
async function reportDaemon(): Promise<boolean> {
  let s: DaemonStatus;
  try {
    s = await controlRequest<DaemonStatus>('status');
  } catch {
    return false; // no daemon — the caller falls back to probing directly
  }
  console.log(`  ✓ daemon running (pid ${s.pid}) on ${s.host}:${s.port}`);
  console.log(
    `    ${s.sessions} live session(s) · ${s.connected}/${s.devices} device(s) connected`
  );
  const st = s.pushStats;
  console.log(
    `  · push: ${s.push} subscriber(s)` +
      (st ? `, ${st.sent} sent, ${st.failed} failed, ${st.expired} expired` : '')
  );
  if (s.pushLastError) {
    console.log(`    last failure: ${s.pushLastError.message}`);
    if (s.pushLastError.endpoint) console.log(`    endpoint: ${s.pushLastError.endpoint}`);
  }
  if (s.push === 0) {
    console.log('    no devices subscribed — open the app and tap the notification row');
  }
  return true;
}

async function cmdDoctor(): Promise<void> {
  console.log('');
  // Before anything else, and before the missing-agent early return: a daemon
  // may be running regardless — started when the agent was installed, or on a
  // box where PATH differs — and "is my daemon up?" is a fair question with no
  // agent present. It is also the only part of doctor that can run on a machine
  // without one, which is where this was previously untestable.
  const daemonAnswered = await reportDaemon();

  const agentVersion = await findAgent();
  if (!agentVersion) {
    console.log(AGENT_MISSING('deepseek-acp'));
    console.log('    after installing, run `deepseek-acp --setup` or export DEEPSEEK_API_KEY');
    process.exitCode = 1;
    return;
  }
  console.log(`  ✓ deepseek-acp found: ${agentVersion}`);

  const { StdioTransport } = await import('./acp/transport.ts');
  const { AcpClient } = await import('./acp/client.ts');
  const client = new AcpClient({ transport: new StdioTransport({ cwd: process.cwd() }) });
  try {
    const init = await client.initialize();
    console.log(`  ✓ ACP handshake ok (protocolVersion ${init.protocolVersion})`);
    console.log(`    loadSession: ${init.agentCapabilities?.loadSession ?? false}`);
    console.log(
      `    auth methods: ${(init.authMethods ?? []).map((m) => m.id).join(', ') || 'none'}`
    );
    const s = await client.newSession(process.cwd());
    console.log(`  ✓ session/new ok (${s.sessionId})`);

    // Clean up after ourselves. `session/new` persists a directory under
    // ~/.dsh/sessions, so every `doctor` run was leaving a junk session behind —
    // they accumulate in the phone's session list and push real work out of the
    // history cap. A diagnostic must not mutate the state it inspects.
    await removeSessionDir(s.sessionId, process.cwd());

    // Push is the feature most likely to be quietly broken — it depends on
    // HTTPS, a service worker, and a third-party push service, none of which
    // report back on their own.
    //
    // Only reached when NO daemon is running: with one, reportDaemon() has
    // already printed its live counters. Reading the store here would show
    // 0 sent regardless of what was delivered, because delivery counters are
    // never written to disk.
    if (!daemonAnswered) {
      const pushSvc = new PushService();
      await pushSvc.load();
      console.log(
        `  · push: ${pushSvc.subscriberCount} subscriber(s) on disk ` +
          '(delivery counts live in the daemon — start it and re-run for those)'
      );
    }

    const posture = await checkPermissionPosture();
    if (posture.willPrompt) {
      console.log('  ✓ agent will prompt before running tools');
    } else {
      console.log('  ✗ agent will NOT prompt — remote approval is inoperative');
      for (const r of posture.reasons) console.log(`      · ${r}`);
      console.log(`    fix in ${posture.configPath}: [features] support_permission = true`);
      process.exitCode = 1;
    }
  } catch (err) {
    const message = (err as Error).message;
    console.log(`  ✗ ACP failed: ${message}`);
    const hint = authHint(message);
    if (hint) console.log(hint);
    process.exitCode = 1;
  } finally {
    client.close();
  }
  console.log('');
}

async function main(): Promise<void> {
  const { cmd, rest, flags } = parseArgs(process.argv.slice(2));
  switch (cmd) {
    case 'up':
      return cmdUp(flags);
    case 'pair':
      return cmdPair();
    case 'devices':
      return cmdDevices();
    case 'revoke':
      return cmdRevoke(rest, flags);
    case 'term': {
      // A terminal on the same daemon session the phone drives. Grok's own TUI
      // cannot share a backend, so this talks to dshrc instead of to grok.
      const { TerminalClient } = await import('./term/client.ts');
      return new TerminalClient({
        url: typeof flags.url === 'string' ? flags.url : undefined,
        sessionId: typeof flags.session === 'string' ? flags.session : undefined,
        newSession: flags.new === true,
        cwd: typeof flags.cwd === 'string' ? resolve(flags.cwd) : process.cwd(),
      }).run();
    }
    case 'config':
      return cmdConfig(rest);
    case 'doctor':
      return cmdDoctor();
    case 'relay': {
      const { RelayServer } = await import('./relay/server.ts');
      // A relay that serves the client can replace it. Anyone running a relay
      // for other people should pass --no-client; see docs/SECURITY.
      const serveClient = flags['no-client'] !== true;
      const relay = new RelayServer({ serveClient });
      const p = await relay.listen(Number(flags.port ?? 8080));
      console.log(`\n  dshrc relay listening on :${p}`);
      console.log('  point a daemon at it with: dshrc up --relay ws://<host>:' + p);
      console.log(
        serveClient
          ? '  serving the PWA — anyone trusting this relay is trusting its JavaScript.\n' +
              '  running it for someone else? use --no-client\n'
          : '  transport only — no client served. Install the app from the daemon’s own URL.\n'
      );
      return;
    }
    default:
      console.log(HELP);
  }
}

main().catch((err) => {
  console.error(`dshrc: ${(err as Error).message}`);
  process.exit(1);
});
