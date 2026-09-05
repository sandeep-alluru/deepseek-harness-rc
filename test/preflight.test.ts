/**
 * Preflight: does the agent actually ask before running tools?
 *
 * This project's Grok Build ancestor was grounded in a real finding —
 * end-to-end testing showed Grok Build never sends `session/request_permission`
 * unless `[features] support_permission = true`, and a user config could
 * additionally set `[ui] permission_mode = "auto"`. Both silently disabled
 * remote approval, so this file used to prove that every combination of those
 * two keys was detected correctly.
 *
 * **None of that applies to `deepseek-acp`.** Per its own README, its sandbox
 * (default `workspace-write`) always sends `session/request_permission` for
 * anything outside the session cwd or the system temp dir — there is no
 * config key, flag, or env var that disables it. `checkPermissionPosture()`
 * was rewritten accordingly: it no longer reads any file, and always reports
 * `willPrompt: true`. What this file proves now is exactly that — including
 * against a config.toml deliberately shaped like the old Grok Build bypass,
 * to show it really is inert rather than merely unread by coincidence.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPermissionPosture, posturteWarning } from '../src/daemon/preflight.ts';

async function withConfig(toml: string | null) {
  const dir = await mkdtemp(join(tmpdir(), 'preflight-'));
  if (toml !== null) await writeFile(join(dir, 'config.toml'), toml);
  const posture = await checkPermissionPosture(dir);
  await rm(dir, { recursive: true, force: true });
  return posture;
}

test('no config: always prompts — nothing to read, nothing to bypass', async () => {
  const p = await withConfig(null);
  assert.equal(p.willPrompt, true);
  assert.deepEqual(p.reasons, []);
  assert.equal(posturteWarning(p), null);
});

test("a config shaped like Grok Build's old bypass is inert", async () => {
  // The exact content that used to defeat approval on the Grok backend:
  // support_permission off AND a non-prompting permission_mode. Proves the
  // rewrite really ignores the file rather than merely never having been
  // asked to look at this particular shape.
  const p = await withConfig(
    '[features]\nsupport_permission = false\n\n[ui]\npermission_mode = "auto"\n'
  );
  assert.equal(p.willPrompt, true);
  assert.deepEqual(p.reasons, []);
  assert.equal(posturteWarning(p), null);
});

test('the ignored grokHome parameter does not change the answer either', async () => {
  const a = await checkPermissionPosture();
  const b = await checkPermissionPosture('/some/path/that/does/not/exist');
  assert.deepEqual(a, b);
  assert.equal(a.willPrompt, true);
});
