'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CONFIG_NAME = 'agent-guard.json';
const LOCK_NAME = 'agent-lock.json';
const cache = new Map();

/**
 * Git facts for the repo containing `dir`, or null when `dir` is not inside a work tree.
 * `common` is the shared .git directory (the same for every worktree), where config and lock live.
 */
function repoInfo(dir) {
  const key = path.resolve(dir);
  if (cache.has(key)) return cache.get(key);
  let info = null;
  try {
    const out = execFileSync('git', ['-C', key, 'rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    const [top, gitDir, common] = out.split(/\r?\n/);
    if (top) info = { top, gitDir: path.resolve(key, gitDir), common: path.resolve(key, common) };
  } catch { info = null; }
  cache.set(key, info);
  return info;
}

/** The guard config of a repo ({requireLock}), or null when the repo is not guarded. */
function guardConfig(info) {
  if (!info) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(info.common, CONFIG_NAME), 'utf8'));
    return cfg && typeof cfg === 'object' ? cfg : { requireLock: false };
  } catch (e) {
    return e.code === 'ENOENT' ? null : { requireLock: false };
  }
}

/** True while git is finishing a merge, cherry-pick or revert (a commit then takes no pathspec). */
function finishingOperation(info) {
  return ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].some((f) => fs.existsSync(path.join(info.gitDir, f)));
}

module.exports = { repoInfo, guardConfig, finishingOperation, CONFIG_NAME, LOCK_NAME };
