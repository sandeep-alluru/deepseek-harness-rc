# dshrc — open items

**0 of 6 closed.** Generated from `tools/backlog.mjs` —
edit that, then run `npm run backlog -- --write`. `npm run backlog -- --check`
fails if this file has drifted, so status cannot be claimed in one place and
contradicted in another.

Evidence classes: **VERIFIED** (observed, with what showed it) ·
**UNVERIFIED** (believed, with the check that settles it) · **UNKNOWN**.

Status: `open` · `done` · `accepted` (no action intended) · `not-a-limitation`.

---

## B · Never verified  —  0/2 closed

| # | Item | Status | Evidence |
| --- | --- | --- | --- |
| 8 | Android push never tested | `open` | UNKNOWN — no Android device available. Carried forward unchanged from grokrc: the push/PWA layer is backend-agnostic, so this gap is identical on this fork. |
| 4 | Windows path-encoding for dsh session directories is unverified | `open` | UNKNOWN — encodeDshCwd() (src/daemon/session-manager.ts) was reverse-engineered from real POSIX session directories on the fork machine (`/home/user/project` → `--home-user-project--`); the Windows branch falls back to the old encodeURIComponent behaviour, which is almost certainly wrong for dsh's real Windows output. No Windows dsh install was available to check against. |

### 4 · Windows path-encoding for dsh session directories is unverified

**Result.** Not closed. A wrong guess here fails LOUD (resume() reports "no persisted session", never silently returns the wrong one — see the function's doc comment) rather than corrupting anything, but the actual encoding needs measuring on a real Windows dsh install before Windows resume can be relied on.

## C · Product gaps  —  0/3 closed

| # | Item | Status | Evidence |
| --- | --- | --- | --- |
| 1 | `discoverOnDisk()` always returns empty on the deepseek-acp backend | `open` | VERIFIED — dsh's own persistence (@deepseek-ai/dsh-session-persistence-jsonl) writes one compressed session.jsonl.zstd per session; the function reads Grok Build's per-session summary.json, which does not exist in this shape, so every read throws ENOENT and is silently caught. Confirmed against real session files on the fork machine: a `type:"session"` header line carries id/cwd/createdAt, and a later `session/title` event carries the title. |
| 2 | `activeOnDisk()` / Take over have no live-process registry to check on this backend | `open` | VERIFIED — dsh keeps no active_sessions.json-shaped file under $DSH_HOME on the fork machine, so activeOnDisk() always returns []. takeOver()'s `if (!owner) return this.resume(id, cwd, opts)` therefore fires on every call, silently degrading Take over into a plain resume — without the pid-verification / SIGTERM safety path Grok Build's version had. |
| 3 | Observed mode assumes a plain byte-appended log; untested against dsh's compressed one | `open` | UNVERIFIED — SessionObserver polls a file's size and reads new bytes as UTF-8 text, matching Grok Build's plain updates.jsonl. Whether dsh's compressed session.jsonl.zstd stream is even structured to support that kind of incremental tailing (independently readable frames vs. one opaque blob) has not been checked. |

### 1 · `discoverOnDisk()` always returns empty on the deepseek-acp backend

**Reanalyse — attacked.** Considered leaving the Grok-shaped reader in place uncommented, on the theory that a genuinely absent file is a harmless no-op either way. Rejected: an uncommented gap reads as "nobody noticed" rather than "known and scoped", and the very rigor this backlog exists to enforce means a silent empty list is exactly the kind of unverified-by-omission claim to catch, not let pass.

**Result.** Not closed. Documented in code comments in src/daemon/session-manager.ts (discoverOnDisk), README "Known gaps", and CHANGELOG. Closing it needs a zstd-decompressing JSONL reader for dsh's event-sourced session log — the schema is known, the reader is not written. LIVE-TESTED CONSEQUENCE (tools/resume-check.mjs, real browser + real deepseek-acp): closing a session removes it from the session list ENTIRELY until a new one is created — not merely "unresumable after a daemon restart" as originally scoped. The real-stack check fails at that exact step and is left failing on purpose rather than softened (see the comment at the top of that file).

### 2 · `activeOnDisk()` / Take over have no live-process registry to check on this backend

**Result.** Not closed. The degrade path is safe (never resumes alongside an owner it cannot detect BECAUSE it never had one to detect — it simply cannot warn about one either), but it is a real capability loss, documented in session-manager.ts and README "Known gaps". Would need either a registry dshrc maintains itself, or an upstream dsh feature to check against.

### 3 · Observed mode assumes a plain byte-appended log; untested against dsh's compressed one

**Result.** Not closed. Documented in src/daemon/observer.ts. Settling this needs either confirming zstd frame-level append-tailing works, or building a poll-and-decompress-whole-file fallback and measuring its cost on a long session. A second, related finding from live-testing tools/acp-conformance.mjs against a real deepseek-acp: it did not emit a `turn_completed` session/update notification in that run (guard turn-completion-is-understood came back UNPROVEN as a direct result). Owned sessions are unaffected — client.prompt() detects completion from the session/prompt RPC response itself, proven working end-to-end live — but observed mode has no RPC response to read, only the notification stream, so it would need its own completion signal if ever built for this backend.

## D · Housekeeping  —  0/1 closed

| # | Item | Status | Evidence |
| --- | --- | --- | --- |
| 5 | ~15 tools/*.mjs real-stack probe scripts still say `grok`/`GROK_HOME` cosmetically | `open` | VERIFIED — grep across tools/*.mjs (resume-check.mjs, e2e-drive.mjs, leader-probe.mjs, perm-probe*.mjs, and others) still names the Grok Build binary and env var. None of these run as part of `npm test`; they are manual/CI-only real-stack tools, and `isolatedGrokHome`/`GROK_HOME` are kept as live aliases in tools/harness.mjs so they still function correctly — this item is naming accuracy, not breakage. |

### 5 · ~15 tools/*.mjs real-stack probe scripts still say `grok`/`GROK_HOME` cosmetically

**Result.** Not closed. Lower priority than the C-section items above since nothing is broken; tracked so a contributor renaming one of these files does not have to first discover the alias exists.

---

## Still open — 6

- **#1** `discoverOnDisk()` always returns empty on the deepseek-acp backend
- **#2** `activeOnDisk()` / Take over have no live-process registry to check on this backend
- **#3** Observed mode assumes a plain byte-appended log; untested against dsh's compressed one
- **#8** Android push never tested
- **#4** Windows path-encoding for dsh session directories is unverified
- **#5** ~15 tools/*.mjs real-stack probe scripts still say `grok`/`GROK_HOME` cosmetically
