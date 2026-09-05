/**
 * Startup preflight.
 *
 * This project's Grok Build ancestor found, end-to-end: **Grok does not ask
 * for permission by default.** `[features] support_permission` defaults to
 * false, and a user config may additionally set `[ui] permission_mode` to
 * `auto` / `dontAsk` / `bypassPermissions`. With either in force,
 * `session/request_permission` is never sent — so the daemon's core feature
 * silently does nothing, and worse, an agent driven from a phone executes
 * every tool unattended. That preflight scraped `~/.grok/config.toml` for
 * those two keys and warned loudly when either was in force.
 *
 * **That whole class of misconfiguration does not exist for `deepseek-acp`.**
 * Per its own README: its sandbox (default `workspace-write`) always emits
 * `session/request_permission` for anything outside the session cwd or the
 * system temp dir — there is no config key, flag, or env var that disables
 * it. `checkPermissionPosture` below is kept only so its two call sites in
 * `cli.ts` keep compiling and reporting something sane; it always resolves
 * `willPrompt: true` with no `configPath` to scrape and nothing to warn
 * about, rather than pointed at `~/.dsh/config.toml` (which would not exist,
 * making it always warn the agent will not prompt — false, and actively
 * misleading for a backend that structurally cannot be put in that state).
 */
export interface PermissionPosture {
  /** Will the agent actually ask before running tools? */
  willPrompt: boolean;
  supportPermission: boolean | null;
  permissionMode: string | null;
  configPath: string;
  reasons: string[];
}

const NON_PROMPTING_MODES = new Set(['auto', 'dontask', 'bypasspermissions', 'acceptedits']);

function readKey(toml: string, section: string, key: string): string | null {
  // Match `key = value` only within the given [section].
  const sectionRe = new RegExp(`\\[${section}\\]([\\s\\S]*?)(?=\\n\\[|$)`);
  const body = sectionRe.exec(toml)?.[1];
  if (!body) return null;
  const keyRe = new RegExp(`^\\s*${key}\\s*=\\s*"?([A-Za-z0-9_-]+)"?`, 'm');
  return keyRe.exec(body)?.[1] ?? null;
}

export async function checkPermissionPosture(_grokHome?: string): Promise<PermissionPosture> {
  // See the module doc comment: `deepseek-acp` has no config surface that
  // disables `session/request_permission`, so there is nothing to scrape and
  // nothing to warn about. `_grokHome` and `readKey` are kept unused rather
  // than removed — a future backend that DOES have a silence-approval config
  // key (a `grok`-compatible one, say) can reuse this shape instead of
  // reinventing it.
  void readKey;
  void NON_PROMPTING_MODES;
  return {
    willPrompt: true,
    supportPermission: true,
    permissionMode: null,
    configPath: '(not applicable — deepseek-acp has no permission-bypass config)',
    reasons: [],
  };
}

/** Human-facing warning. Returns null when the posture is fine. */
export function posturteWarning(p: PermissionPosture): string | null {
  if (p.willPrompt) return null;
  return [
    '',
    '  ⚠ THE AGENT WILL NOT ASK BEFORE RUNNING TOOLS.',
    '',
    ...p.reasons.map((r) => `      · ${r}`),
    '',
    `    Remote approval cannot work in this state — tools execute unattended,`,
    `    including writes and shell commands, with nothing to approve.`,
    '',
    `    Fix in ${p.configPath}:`,
    '',
    '        [features]',
    '        support_permission = true',
    '',
    '        [ui]',
    '        permission_mode = "default"',
    '',
  ].join('\n');
}
