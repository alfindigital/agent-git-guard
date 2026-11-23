'use strict';
// End to end: the real hook process and the real pre-commit hook, as an agent would hit them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeRepo, git, GIT_ENV } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const node = (script, args, opts = {}) => spawnSync(process.execPath, [path.join(ROOT, script), ...args], { encoding: 'utf8', ...opts });

test('guard.js speaks the PreToolUse hook protocol', () => {
  const repo = makeRepo();
  const hook = (command) => node('guard.js', [], { input: JSON.stringify({ tool_name: 'Bash', cwd: repo, tool_input: { command } }) });

  const blocked = hook('git add -A');
  assert.strictEqual(blocked.status, 2);
  assert.match(blocked.stderr, /agent-git-guard/);

  const warned = hook('git switch main');
  assert.strictEqual(warned.status, 0);
  assert.strictEqual(JSON.parse(warned.stdout).hookSpecificOutput.hookEventName, 'PreToolUse');

  const ok = hook('git status');
  assert.strictEqual(ok.status, 0);
  assert.strictEqual(ok.stdout, '');

  const garbage = node('guard.js', [], { input: 'not json' });
  assert.strictEqual(garbage.status, 0, 'fails open on bad input');
});

test('install --require-lock: commits need the lock token', () => {
  const repo = makeRepo({ guarded: false });
  // a pre-existing hook must survive and still run
  const hooks = path.join(repo, '.git', 'hooks');
  fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\necho local-hook-ran >> "$(git rev-parse --git-dir)/local.log"\n', { mode: 0o755 });

  const inst = node('install.js', [repo, '--require-lock']);
  assert.strictEqual(inst.status, 0, inst.stderr);
  assert.ok(fs.existsSync(path.join(repo, '.git', 'agent-guard.json')));
  assert.ok(fs.existsSync(path.join(hooks, 'pre-commit.local')));

  fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  git(repo, ['add', 'b.txt']);
  const commit = (env) => spawnSync('git', ['-C', repo, 'commit', '-q', '-m', 'b', '--', 'b.txt'], { encoding: 'utf8', env: { ...GIT_ENV, AGENT_LOCK_TOKEN: '', AGENT_LOCK_BYPASS: '', ...env } });

  const refused = commit({});
  assert.notStrictEqual(refused.status, 0);
  assert.match(refused.stderr, /not holding it/);

  const acq = node('agent-lock.js', ['acquire', '-C', repo, '--name', 'e2e']);
  assert.strictEqual(acq.status, 0, acq.stderr);
  const token = /token=(\S+)/.exec(acq.stdout)[1];
  // the release hint must work from any directory, so it names agent-lock.js by absolute path
  assert.ok(acq.stdout.includes(path.join(ROOT, 'agent-lock.js').replace(/\\/g, '/')), acq.stdout);

  const other = node('agent-lock.js', ['acquire', '-C', repo, '--name', 'other']);
  assert.strictEqual(other.status, 3);
  assert.match(other.stdout, /BLOCKED by e2e/);

  assert.notStrictEqual(commit({ AGENT_LOCK_TOKEN: 'wrong' }).status, 0);
  const done = commit({ AGENT_LOCK_TOKEN: token });
  assert.strictEqual(done.status, 0, done.stderr);
  assert.match(fs.readFileSync(path.join(repo, '.git', 'local.log'), 'utf8'), /local-hook-ran/);

  assert.strictEqual(node('agent-lock.js', ['release', '-C', repo, '--token', token]).status, 0);
  assert.match(node('agent-lock.js', ['status', '-C', repo]).stdout, /FREE/);

  // human escape hatch is logged
  fs.writeFileSync(path.join(repo, 'c.txt'), 'c\n');
  git(repo, ['add', 'c.txt']);
  const bypass = spawnSync('git', ['-C', repo, 'commit', '-q', '-m', 'c', '--', 'c.txt'], { encoding: 'utf8', env: { ...GIT_ENV, AGENT_LOCK_BYPASS: 'hotfix by human' } });
  assert.strictEqual(bypass.status, 0, bypass.stderr);
  assert.match(fs.readFileSync(path.join(repo, '.git', 'agent-lock-bypass.log'), 'utf8'), /hotfix by human/);

  // uninstall restores the original hook
  assert.strictEqual(node('install.js', [repo, '--uninstall']).status, 0);
  assert.match(fs.readFileSync(path.join(hooks, 'pre-commit'), 'utf8'), /local-hook-ran/);
  assert.ok(!fs.existsSync(path.join(repo, '.git', 'agent-guard.json')));
});

test('the lock is shared across worktrees of one repo', () => {
  const repo = makeRepo();
  const wt = `${repo}-wt`;
  git(repo, ['worktree', 'add', '-q', '-b', 'side', wt]);
  const acq = node('agent-lock.js', ['acquire', '-C', repo, '--name', 'main-tree']);
  assert.strictEqual(acq.status, 0);
  const fromWt = node('agent-lock.js', ['check', '-C', wt]);
  assert.strictEqual(fromWt.status, 3);
  assert.match(fromWt.stdout, /main-tree/);
});
