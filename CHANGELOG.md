# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-1.0: the minor version may change behaviour. Read the notes before upgrading.

## [Unreleased]

## [0.1.0] — 2026-09-05

First release. Remote control for DeepSeek Harness — drive a `dsh` coding agent from your
phone over ACP. dshrc spawns [`deepseek-acp`](https://www.npmjs.com/package/deepseek-acp)
(an unofficial, editor-facing ACP server over the dsh core) directly over stdio and speaks
a typed protocol to it — no subcommand or mode flags needed, since `deepseek-acp` runs as
an ACP service the moment it sees no `--setup`/`--version`/`--help`.

### Core

- Pairing: short-lived code → long-lived device token, multiple codes outstanding at once
- Owned sessions: create, prompt, cancel, and one-tap approve — full control from the phone
- One-tap approval works out of the box: `deepseek-acp`'s sandbox always sends
  `session/request_permission` before a tool leaves the session's working directory; there
  is no config key, flag, or environment variable that disables it, so there is no state a
  phone-controlled session can end up in where tools run unattended. See SECURITY.md.
- Model selection via the `DEEPSEEK_ACP_MODEL` environment variable
  (`deepseek-acp` has no CLI model flag); `--agent-command <path>` to point at a specific
  binary
- Session resume: `deepseek-acp` advertises ACP's `loadSession` capability, and the on-disk
  existence check matches dsh's real session-directory naming scheme
  (`encodeDshCwd` in `src/daemon/session-manager.ts`)
- Self-hosted Web Push (VAPID) — no third-party push cloud
- Outbound relay mode — the daemon dials out, nothing listens on your machine; AES-GCM
  end-to-end, the key lives in the URL fragment
- Terminal client (`dshrc term`) driving the same session as the phone
- PWA client (iOS + Android) and an Even Realities G2 glasses client
- systemd user unit (Linux) and Scheduled Task scripts (Windows)

### Known gaps (tracked as issues, not silently claimed)

Some capabilities depend on reading dsh's own on-disk session format directly, and that
reader doesn't exist yet:

- **`discoverOnDisk()`** (list every persisted session, including ones started outside
  dshrc) always returns `[]`: dsh persists sessions as one compressed `session.jsonl.zstd`
  per session under `$DSH_HOME/sessions/`, and there is no reader for that shape yet. Fails
  closed (empty list), not a crash.
- **`activeOnDisk()` / `takeOver()`**: dsh keeps no live-process registry, so this daemon
  cannot tell whether another dsh client already has a given session open. `takeOver()`
  degrades to a plain `resume()`, without a "refuse to join a standalone owner" guard.
- **Observed mode** (mirror a session started by hand elsewhere, `SessionObserver`) assumes
  a plain, byte-appended JSONL log; whether dsh's compressed `.zstd` stream even supports
  that kind of tailing is unverified.
