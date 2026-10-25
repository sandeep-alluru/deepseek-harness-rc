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
drifts across versions, one normalizer layer changes — not the entire client (see
`src/acp/protocol.ts`).

---

## Session modes

| Mode         | Source                                              | Control                                                        |
| -------------- | ------------------------------------------------------ | ------------------------------------------------------------------- |
| **Owned**    | Daemon spawns `deepseek-acp`                        | Full                                                           |
| **Shared**   | Leader / multi-client backend                       | One process per session on this backend |
| **Observed** | Tail `$DSH_HOME/sessions/…/session.jsonl.zstd`      | On the roadmap — see below                              |

Session list titles come from the title given at creation, or the project directory
name. Reading titles from dsh's own session store is the
[discovery work on the roadmap](#on-the-roadmap-reading-dshs-session-store).

**Take over** — reclaims a session another process has open. The full version verifies
the owning process first, using a live-process registry; dsh keeps no such registry, so
on this backend Take over resumes the session directly, and the registry-checked guard
is on the roadmap. **Hand back** — closes the daemon-owned agent and returns resume
commands; the returned commands run `dshrc term --session <id>` on every platform.

---

## On the roadmap: reading dsh's session store

Three features build on one piece of work: a reader for dsh's own on-disk session
format. Each returns an empty result until the reader lands:

- **`discoverOnDisk()`** (list sessions dshrc did not itself start) reads a per-session
  summary from the store. `dsh`'s own persistence (`@deepseek-ai/dsh-session-persistence-jsonl`)
  writes one compressed `session.jsonl.zstd` per session — verified against real
  files: a `type:"session"` header line carries `id`/`cwd`/`createdAt`, and a later
  `session/title` event carries the title. The reader parses exactly that shape.
- **`activeOnDisk()` / Take over** verify against a live-process registry. `dsh` keeps
  no such registry; building the check is the second half of this work.
- **Observed mode** (`SessionObserver`) tails the session's log as it grows — with the
  zstd reader, it tails the compressed stream the same way.

The schema is documented in code comments in
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
5. **No silent auto-approve, structurally** — `deepseek-acp` has no config key, flag, or env var that disables `session/request_permission`; there is no bypass state to accidentally ship in
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

