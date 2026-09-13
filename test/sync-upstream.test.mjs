import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBranches, BASE_BRANCH, SYNC_BRANCH } from '../scripts/sync-upstream.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'botmux-sync-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const upstream = join(root, 'upstream.git');
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  const runner = join(root, 'runner');
  git(root, 'init', '--bare', '--initial-branch=master', upstream);
  git(root, 'init', '--bare', '--initial-branch=master', origin);
  git(root, 'init', '--initial-branch=master', work);
  const configure = cwd => {
    git(cwd, 'config', 'user.name', 'Sync Test');
    git(cwd, 'config', 'user.email', 'sync-test@example.invalid');
    git(cwd, 'config', 'core.autocrlf', 'false');
  };
  configure(work);
  const commit = (file, content) => {
    writeFileSync(join(work, file), content);
    git(work, 'add', file);
    git(work, 'commit', '-m', content);
    return git(work, 'rev-parse', 'HEAD');
  };
  commit('base.txt', 'base');
  git(work, 'remote', 'add', 'upstream', upstream);
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', 'upstream', 'master');
  git(work, 'push', 'origin', 'master');
  git(work, 'switch', '-c', BASE_BRANCH);
  const windows = commit('windows.txt', 'Windows adaptation');
  git(work, 'push', 'origin', BASE_BRANCH);
  git(work, 'switch', 'master');
  const updated = commit('upstream.txt', 'upstream change');
  git(work, 'push', 'upstream', 'master');
  git(root, 'clone', origin, runner);
  configure(runner);
  const ref = (repo, name) => git(repo, 'rev-parse', `refs/heads/${name}`);
  const run = (dryRun = false) => syncBranches({ cwd: runner, upstreamUrl: upstream, dryRun });
  return { git, ref, run, commit, work, runner, upstream, origin, windows, updated };
}

test('syncs upstream atomically without changing the Windows branch or checkout', t => {
  const f = fixture(t);
  const before = f.git(f.runner, 'rev-parse', 'HEAD');
  const result = f.run();
  assert.equal(result.needsPr, true);
  assert.equal(f.ref(f.origin, 'master'), f.updated);
  assert.equal(f.ref(f.origin, SYNC_BRANCH), f.updated);
  assert.equal(f.ref(f.origin, BASE_BRANCH), f.windows);
  assert.equal(f.git(f.runner, 'rev-parse', 'HEAD'), before);
  assert.equal(f.git(f.runner, 'status', '--porcelain'), '');
  assert.deepEqual(f.run().refs, []);
});

test('dry run leaves every remote ref unchanged', t => {
  const f = fixture(t);
  const before = f.ref(f.origin, 'master');
  assert.equal(f.run(true).needsPr, true);
  assert.equal(f.ref(f.origin, 'master'), before);
  assert.equal(f.ref(f.origin, BASE_BRANCH), f.windows);
  assert.throws(() => f.ref(f.origin, SYNC_BRANCH));
});

test('does not request a PR after Windows has merged upstream', t => {
  const f = fixture(t);
  f.run();
  f.git(f.work, 'switch', BASE_BRANCH);
  f.git(f.work, 'merge', '--no-edit', 'master');
  f.git(f.work, 'push', 'origin', BASE_BRANCH);
  assert.equal(f.run().needsPr, false);
});

test('refuses to overwrite a divergent mirror', t => {
  const f = fixture(t);
  f.git(f.work, 'switch', '-c', 'divergent', 'master~1');
  const divergent = f.commit('private-change.txt', 'local mirror change');
  f.git(f.work, 'push', 'origin', 'HEAD:refs/heads/master');
  assert.throws(() => f.run(), /master has diverged/);
  assert.equal(f.ref(f.origin, 'master'), divergent);
  assert.equal(f.ref(f.origin, BASE_BRANCH), f.windows);
});

test('refuses to overwrite a modified sync branch before updating the mirror', t => {
  const f = fixture(t);
  f.git(f.work, 'push', 'origin', `${BASE_BRANCH}:refs/heads/${SYNC_BRANCH}`);
  const mirror = f.ref(f.origin, 'master');
  assert.throws(() => f.run(), /sync branch has diverged/);
  assert.equal(f.ref(f.origin, 'master'), mirror);
  assert.equal(f.ref(f.origin, SYNC_BRANCH), f.windows);
});

test('preserves conflicting Windows changes for resolution in the PR', t => {
  const f = fixture(t);
  f.commit('windows.txt', 'upstream also touches this file');
  f.git(f.work, 'push', 'upstream', 'master');
  assert.equal(f.run().needsPr, true);
  assert.equal(f.ref(f.origin, BASE_BRANCH), f.windows);
  assert.throws(() => f.git(f.work, 'merge', '--no-edit', BASE_BRANCH));
  assert.match(f.git(f.work, 'status', '--porcelain'), /AA windows.txt/);
});
