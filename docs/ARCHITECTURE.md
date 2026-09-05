# Architecture

How dshrc is put together. For install and daily use see [GUIDE.md](GUIDE.md).

---

## Topology

```
  Phone PWA  ── LAN / Tailscale ──►  dshrc daemon  ── ACP ──►  deepseek-acp
       │                                  │
       └──── WSS relay (optional) ────────┘  (daemon dials OUT)

  G2 glasses ── BT ──► phone ── wss ──────┘  (same protocol, direct mode)
```

`deepseek-acp` is an unofficial, editor-facing ACP server over
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). dshrc spawns
it directly over stdio — no subcommand or mode flags, since any argv it does not
recognize as `--setup` / `--version` / `--help` falls through to ACP service mode.

| Mode        | Path                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------- |
| **Direct**  | Phone → daemon over LAN or Tailnet                                                            |
| **Relay**   | Phone → relay ← daemon (outbound). Relay does not parse ACP or hold session state             |
| **Glasses** | Even Realities G2 → phone → daemon. Direct mode only — see [GLASSES-G2.md](GLASSES-G2.md)     |

---

## Why ACP

| Need                  | PTY approach    | ACP                                 |
| ----------------------- | ----------------- | -------------------------------------- |
| Waiting for approval? | Regex ANSI      | `session/request_permission`         |
| Approve tool          | Keystrokes      | Reply with `optionId`                |
| Diffs / tools / plan  | Scrape terminal | Structured `session/update` events   |

The phone renders a real UI over a stable event model. When the agent's wire format
drifts, one normalizer layer changes — not the entire client. This project's Grok
Build ancestor measured this drift firsthand between Grok versions `0.2.118` and
`1.0.0` (see `src/acp/protocol.ts`); the same normalizer now sits in front of
`deepseek-acp` unchanged.

---

## Session modes

| Mode         | Source                                              | Control                                                        |
| -------------- | ------------------------------------------------------ | ------------------------------------------------------------------- |
| **Owned**    | Daemon spawns `deepseek-acp`                        | Full                                                           |
| **Shared**   | Leader / multi-client backend                       | **Not supported** — `deepseek-acp` has no shared-backend concept |
| **Observed** | Tail `$DSH_HOME/sessions/…/session.jsonl.zstd`      | **Not yet supported** — see below                              |

Session list titles come from the title given at creation, or the project directory
name — there is no cross-process title source like Grok's `generated_title` to read,
since [`discoverOnDisk()`](#known-capability-gaps) always returns nothing on this
backend.

**Take over** — on the Grok Build backend, stopped the registered TUI owner (verified
safe via `active_sessions.json` and a pid check) and resumed as owned. On this backend
it degrades to a plain resume, because there is no registry to check an owner against.
**Hand back** — closes the daemon-owned agent and returns resume commands; it no
longer attempts to open a desktop terminal automatically (there is no `deepseek-acp`
equivalent of `grok -r <id>`) — the returned commands now run `dshrc term --session <id>`
on every platform instead.

---

## Known capability gaps

Three features were written against Grok Build's on-disk shape and were not ported,
rather than adapted incorrectly. Each fails **closed** (empty results), never a crash:

- **`discoverOnDisk()`** (list sessions dshrc did not itself start) read one
  `summary.json` file per session directory. `dsh`'s own persistence
  (`@deepseek-ai/dsh-session-persistence-jsonl`) instead writes one compressed
  `session.jsonl.zstd` per session — verified against real files on the machine this
  fork was built on: a `type:"session"` header line carries `id`/`cwd`/`createdAt`,
  and a later `session/title` event carries the title. The reader for that shape does
  not exist yet.
- **`activeOnDisk()` / Take over** read `active_sessions.json`, a live-process registry
  Grok Build maintained. `dsh` keeps no equivalent, so this daemon has no way to tell
  whether another `dsh` client currently has a session open.
- **Observed mode** (`SessionObserver`) polls a file's size and reads new bytes as
  plain UTF-8 text, matching Grok's byte-appended `updates.jsonl`. Whether `dsh`'s
  compressed `.zstd` stream is even structured to support that kind of tailing is
  unverified.

The schema needed to close each gap is documented in code comments in
`src/daemon/session-manager.ts` and `src/daemon/observer.ts`.

---

## Event model

ACP frames (and observed logs) normalize to a small union the client renders:

| Kind       | Role                                                     |
| ------------ | ----------------------------------------------------------- |
| `text`     | User / agent message                                     |
| `thinking` | Model reasoning (client may show only finalized blocks)  |
| `tool`     | Tool call lifecycle + optional diff                      |
| `plan`     | Plan items                                                |
| `approval` | Permission request + options                             |
| `status`   | idle / working / awaiting-approval / …                   |
| `session`  | Metadata (cwd, title, model, mode)                        |
| `error`    | Failures                                                  |

Live traffic is filtered and size-capped so large tool payloads do not crash mobile browsers. Stored history on the machine can retain more detail for recovery.

---

## Components

```
src/
  acp/          JSON-RPC client, stdio transport, protocol types
  daemon/       HTTP + WebSocket server, sessions, auth, push, observer, control socket
  relay/        Optional forwarder
  term/         Terminal client
  cli.ts        dshrc entrypoint
web/            PWA (no framework build step)
glasses/        Even Realities G2 client (separate Vite build — see GLASSES-G2.md)
packaging/      systemd (Linux), Scheduled Task (Windows)
```

---

## Security properties

1. **Pairing** — short-lived code → long-lived device token (hash stored)
2. **Auth on every socket** — bad token closes the connection
3. **Relay content-blind** — AES-GCM; key in URL fragment (not sent to relay)
4. **Credentials stay local** — `$DSH_HOME/.credentials.yaml` (or `DEEPSEEK_API_KEY`) used only by the locally spawned `deepseek-acp`
5. **No silent auto-approve, structurally** — unlike this project's Grok Build ancestor, `deepseek-acp` has no config key, flag, or env var that disables `session/request_permission`; there is no bypass state to accidentally ship in
6. **Loopback by default** — exposure is opt-in (`--lan`, relay)

Details and reporting: [SECURITY.md](../SECURITY.md).

---

## Build order (historical)

1. ACP client over stdio
2. Event normalizer
3. Session manager (owned / shared / observed)
4. WS server + pairing
5. PWA
6. Relay
7. Web Push

*(This is grokrc's original build order, kept as-is: the backend swap to DeepSeek Harness came later and touched the transport and session-persistence layers, not this sequence.)*
