# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-1.0: the minor version may change behaviour. Read the notes before upgrading.

## [Unreleased]

## [0.1.0] — 2026-09-05

First release. **dshrc is a fork of [grokrc](https://github.com/sandeep-alluru/grokrc)**,
re-pointed from xAI's Grok Build CLI to **DeepSeek Harness**, driven through
[`deepseek-acp`](https://www.npmjs.com/package/deepseek-acp) (an unofficial,
editor-facing ACP server over the dsh core). Everything protocol-generic —
the daemon, the ACP client, pairing, Web Push, the relay, the PWA and glasses
clients — is unchanged from grokrc; only the pieces that named Grok Build
specifically were re-targeted. See grokrc's own changelog for everything
before this fork.

### Changed (backend swap)

- `StdioTransport` spawns `deepseek-acp` with no subcommand/mode flags instead
  of `grok agent stdio [...]` — deepseek-acp needs none. Model selection moved
  from a `--model` argv flag to the `DEEPSEEK_ACP_MODEL` env var, since
  deepseek-acp has no CLI model flag.
- New `--agent-command <path>` flag / `agentCommand` config key (was
  `grokCommand`), default `deepseek-acp`.
- `GROK_HOME` → `DSH_HOME` (default `~/.dsh`); the cwd-to-directory encoding
  used to locate a persisted session was corrected to match dsh's real
  on-disk scheme (verified against real session files — see
  `encodeDshCwd` in `src/daemon/session-manager.ts`), not carried over from
  Grok's `encodeURIComponent`.
- `checkPermissionPosture()` no longer scrapes a Grok-shaped `config.toml`:
  `deepseek-acp` has no config surface that disables
  `session/request_permission` (its sandbox always asks), so this now always
  reports `willPrompt: true`. See SECURITY.md.
- `release()`'s auto-relaunch-into-a-new-terminal defaults OFF (was ON) on
  this backend — it used to open a terminal running `grok -r <id>`, which has
  no `deepseek-acp` equivalent. `resumeCommands()` now suggests `dshrc term`
  instead for all three shells.
- `--leader` / `--permission-mode` are still accepted (config-file
  compatibility) but are no-ops against `deepseek-acp` — see
  `src/acp/transport.ts` and `src/daemon/config.ts`.

### Known gaps (tracked as issues, not silently claimed)

- **`discoverOnDisk()`** (list every persisted session, including ones
  started outside dshrc) always returns `[]` on this backend: dsh persists
  sessions as one compressed `session.jsonl.zstd` per session, not Grok's
  `summary.json`. Fails closed (empty list), not a crash.
- **`activeOnDisk()` / `takeOver()`**: dsh keeps no `active_sessions.json`-style
  live-process registry, so this daemon cannot tell whether another dsh
  client already has a given session open. `takeOver()` degrades to a plain
  `resume()`, silently losing the "refuse to join a standalone owner" guard
  the Grok backend had.
- **Observed mode** (mirror a session started by hand elsewhere,
  `SessionObserver`) assumes a plain, byte-appended JSONL log; whether dsh's
  compressed `.zstd` stream even supports that kind of tailing is unverified.
