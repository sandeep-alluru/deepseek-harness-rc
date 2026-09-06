/**
 * The backlog. DATA ONLY — `tools/backlog-report.mjs` renders and checks it.
 *
 * Single source of truth: `docs/BACKLOG.md` is GENERATED from this file, and
 * `test/backlog.test.ts` fails if the two drift. Keeping status in prose meant
 * an item could be called done in one place and open in another, and nothing
 * would notice.
 *
 * Per item:
 *   id        stable number, never reused
 *   section   A..E
 *   title     one line
 *   evidence  VERIFIED / UNVERIFIED / UNKNOWN, with what showed it
 *   status    open | done | accepted | not-a-limitation
 *   effort    S | M | L
 *   loop      the ANALYSE→EVALUATE→REANALYSE→REEVALUATE→DECIDE artifact.
 *             `attacked` is mandatory for anything marked done: a step with no
 *             output cannot be checked, not even by its author.
 *   result    what was actually produced, once closed
 *
 * This list was RESET on 2026-09-05 to reflect dshrc's actual current state
 * against DeepSeek Harness via `deepseek-acp`. Carrying forward items that no
 * longer describe this codebase would be the exact kind of unverified claim
 * this mechanism exists to catch.
 */
export const SECTIONS = {
  A: 'Automated coverage gaps',
  B: 'Never verified',
  C: 'Product gaps',
  D: 'Housekeeping',
  E: 'Reviewed after challenge',
};

export const ITEMS = [
  {
    id: 1,
    section: 'C',
    effort: 'L',
    status: 'open',
    title: '`discoverOnDisk()` always returns empty on the deepseek-acp backend',
    evidence:
      'VERIFIED — dsh\'s own persistence (@deepseek-ai/dsh-session-persistence-jsonl) writes one compressed session.jsonl.zstd per session; the function needs a per-session summary.json to read, which does not exist in this shape, so every read throws ENOENT and is silently caught. Confirmed against real session files: a `type:"session"` header line carries id/cwd/createdAt, and a later `session/title` event carries the title.',
    loop: {
      attacked:
        'Considered leaving the old, wrong-shaped reader in place uncommented, on the theory that a genuinely absent file is a harmless no-op either way. Rejected: an uncommented gap reads as "nobody noticed" rather than "known and scoped", and the very rigor this backlog exists to enforce means a silent empty list is exactly the kind of unverified-by-omission claim to catch, not let pass.',
    },
    result:
      'Not closed. Documented in code comments in src/daemon/session-manager.ts (discoverOnDisk), README "Known gaps", and CHANGELOG. Closing it needs a zstd-decompressing JSONL reader for dsh\'s event-sourced session log — the schema is known, the reader is not written. LIVE-TESTED CONSEQUENCE (tools/resume-check.mjs, real browser + real deepseek-acp): closing a session removes it from the session list ENTIRELY until a new one is created — not merely "unresumable after a daemon restart" as originally scoped. The real-stack check fails at that exact step and is left failing on purpose rather than softened (see the comment at the top of that file).',
  },
  {
    id: 2,
    section: 'C',
    effort: 'M',
    status: 'open',
    title: '`activeOnDisk()` / Take over have no live-process registry to check on this backend',
    evidence:
      "VERIFIED — dsh keeps no active_sessions.json-shaped file under $DSH_HOME on the fork machine, so activeOnDisk() always returns []. takeOver()'s `if (!owner) return this.resume(id, cwd, opts)` therefore fires on every call, silently degrading Take over into a plain resume — without a pid-verification / SIGTERM safety path to fall back on.",
    result:
      'Not closed. The degrade path is safe (never resumes alongside an owner it cannot detect BECAUSE it never had one to detect — it simply cannot warn about one either), but it is a real capability loss, documented in session-manager.ts and README "Known gaps". Would need either a registry dshrc maintains itself, or an upstream dsh feature to check against.',
  },
  {
    id: 3,
    section: 'C',
    effort: 'M',
    status: 'open',
    title: "Observed mode assumes a plain byte-appended log; untested against dsh's compressed one",
    evidence:
      "UNVERIFIED — SessionObserver polls a file's size and reads new bytes as UTF-8 text, which assumes a plain, byte-appended log. Whether dsh's compressed session.jsonl.zstd stream is even structured to support that kind of incremental tailing (independently readable frames vs. one opaque blob) has not been checked.",
    result:
      'Not closed. Documented in src/daemon/observer.ts. Settling this needs either confirming zstd frame-level append-tailing works, or building a poll-and-decompress-whole-file fallback and measuring its cost on a long session. A second, related finding from live-testing tools/acp-conformance.mjs against a real deepseek-acp: it did not emit a `turn_completed` session/update notification in that run (guard turn-completion-is-understood came back UNPROVEN as a direct result). Owned sessions are unaffected — client.prompt() detects completion from the session/prompt RPC response itself, proven working end-to-end live — but observed mode has no RPC response to read, only the notification stream, so it would need its own completion signal if ever built for this backend.',
  },
  {
    id: 8,
    section: 'B',
    effort: 'M',
    status: 'open',
    title: 'Android push never tested',
    evidence: 'UNKNOWN — no Android device available.',
  },
  {
    id: 4,
    section: 'B',
    effort: 'M',
    status: 'open',
    title: 'Windows path-encoding for dsh session directories is unverified',
    evidence:
      "UNKNOWN — encodeDshCwd() (src/daemon/session-manager.ts) was reverse-engineered from real POSIX session directories on the fork machine (`/home/user/project` → `--home-user-project--`); the Windows branch falls back to the old encodeURIComponent behaviour, which is almost certainly wrong for dsh's real Windows output. No Windows dsh install was available to check against.",
    result:
      'Not closed. A wrong guess here fails LOUD (resume() reports "no persisted session", never silently returns the wrong one — see the function\'s doc comment) rather than corrupting anything, but the actual encoding needs measuring on a real Windows dsh install before Windows resume can be relied on.',
  },
  {
    id: 5,
    section: 'D',
    effort: 'S',
    status: 'done',
    title:
      'tools/*.mjs real-stack probe scripts still said the old agent binary name/env var cosmetically',
    evidence:
      "VERIFIED — grep across tools/*.mjs. Two classes turned out to be different problems: (1) generic tools (acp-probe.mjs, settings-dump.mjs → renamed; stranger-check.mjs/.sh → adapted) had no reason to stay shaped around a different agent CLI. (2) five tools (perm-probe*.mjs, leader-probe.mjs, relay-probe.mjs, settings-dump.mjs) probe mechanisms deepseek-acp doesn't have — a vendor settings-push notification, a permission-bypass flag, a shared-backend leader mode, a headless relay mode; renaming their spawns would have made them silently test something fictional. Those five are left as-is with a clear header instead, naming what they actually probe.",
    loop: {
      attacked:
        "Considered a blanket sed rename across all ~15 files as the fast close. Rejected after reading perm-probe.mjs and leader-probe.mjs: `deepseek-acp` genuinely has no `--permission-mode` flag and no leader mode, so `spawn('deepseek-acp', ['--permission-mode', mode, 'agent', 'stdio'])` would not probe anything real — it would just fail differently, and a green 'probe' that tests nothing is the exact defect this whole backlog mechanism exists to catch. Read each file individually instead.",
    },
    result:
      'Fixed the generic ones (tools/acp-probe.mjs now defaults to spawning deepseek-acp with a --command override for testing other agents; tools/stranger-check.mjs/.sh fully adapted and syntax-checked). Annotated the ones specific to a different agent CLI rather than breaking them. Found one real bug in the process, not merely cosmetic: tools/isolated-test.mjs — the wrapper `npm test`/`npm run test:suite` actually run through — injected the old env var name (nothing reads it any more) and snapshotted the old sessions path (the wrong one) for its leak DETECT/PREVENT mechanism, silently inert for this backend. Fixed to DSH_HOME/~/.dsh. Checked for actual harm: no leaked scratch-cwd sessions found under the real ~/.dsh — individual test files that spawn real agents already self-isolate via the already-fixed isolatedDshHome(), so the bug was latent, not exploited.',
  },
];
