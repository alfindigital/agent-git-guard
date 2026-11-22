'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(dir, args, env = {}) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...GIT_ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A fresh repo with one commit; `guarded` writes the guard marker. */
function makeRepo({ guarded = true, requireLock = false } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agg-')));
  git(dir, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, ['add', 'a.txt']);
  git(dir, ['commit', '-q', '-m', 'init', '--', 'a.txt']);
  if (guarded) {
    fs.writeFileSync(path.join(dir, '.git', 'agent-guard.json'), JSON.stringify({ guard: 1, requireLock }));
  }
  return dir;
}

module.exports = { git, makeRepo, GIT_ENV };
