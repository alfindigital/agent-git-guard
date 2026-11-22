#!/usr/bin/env node
/**
 * Turn the guard on (or off) for one git repository.
 *
 *   node install.js [repo-dir]                  guard git commands in this repo
 *   node install.js [repo-dir] --require-lock   also make every commit hold the commit lock (pre-commit hook)
 *   node install.js [repo-dir] --uninstall      turn both off again
 *
 * Nothing is committed: the marker (agent-guard.json) and the lock live in the repo's .git directory.
 * The hook itself is registered once per agent (see README): the script prints the snippet to paste.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { repoInfo, CONFIG_NAME } = require('./lib/repo');

const MARK = '# agent-git-guard pre-commit';
const slash = (p) => p.replace(/\\/g, '/');

function hooksDir(info) {
  try {
    const custom = execFileSync('git', ['-C', info.top, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (custom) return { dir: path.resolve(info.top, custom), custom: true };
  } catch { /* not set */ }
  return { dir: path.join(info.common, 'hooks'), custom: false };
}

function hookScript() {
  const lockJs = slash(path.join(__dirname, 'agent-lock.js'));
  return `#!/bin/sh
${MARK} (installed by install.js; uninstall: node install.js --uninstall)
node "${lockJs}" hook-check || exit 1
local_hook="$(dirname "$0")/pre-commit.local"
if [ -x "$local_hook" ]; then exec "$local_hook" "$@"; fi
`;
}

function installHook(info, log) {
  const { dir, custom } = hooksDir(info);
  const hook = path.join(dir, 'pre-commit');
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(hook)) {
    const cur = fs.readFileSync(hook, 'utf8');
    if (!cur.includes(MARK)) {
      const keep = path.join(dir, 'pre-commit.local');
      if (fs.existsSync(keep)) throw new Error(`${hook} and ${keep} both exist; merge them by hand first`);
      fs.renameSync(hook, keep);
      log(`kept your existing pre-commit hook as ${keep}; it still runs after the lock check`);
    }
  }
  fs.writeFileSync(hook, hookScript(), { mode: 0o755 });
  try { fs.chmodSync(hook, 0o755); } catch { /* Windows */ }
  log(`pre-commit hook installed: ${hook}${custom ? ' (core.hooksPath)' : ''}`);
}

function uninstallHook(info, log) {
  const { dir } = hooksDir(info);
  const hook = path.join(dir, 'pre-commit');
  if (fs.existsSync(hook) && fs.readFileSync(hook, 'utf8').includes(MARK)) {
    fs.unlinkSync(hook);
    const keep = path.join(dir, 'pre-commit.local');
    if (fs.existsSync(keep)) { fs.renameSync(keep, hook); log('restored your original pre-commit hook'); }
    log('pre-commit hook removed');
  }
}

function agentSnippets() {
  const guard = slash(path.join(__dirname, 'guard.js'));
  const entry = (matcher) => JSON.stringify({ hooks: { PreToolUse: [{ matcher, hooks: [{ type: 'command', command: `node "${guard}"` }] }] } }, null, 2);
  return `Register the hook once per agent (merge into the existing "hooks" if the file has one):

Claude Code: ~/.claude/settings.json (all projects) or <repo>/.claude/settings.json
${entry('Bash|PowerShell')}

Codex CLI: ~/.codex/hooks.json, then approve (trust) the hook once when Codex asks
${entry('^Bash$')}
`;
}

function run(argv, log = (s) => process.stdout.write(`${s}\n`)) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const target = argv.find((a) => !a.startsWith('--')) || process.cwd();
  const info = repoInfo(path.resolve(target));
  if (!info) { log(`not a git repository: ${target}`); return 1; }
  const config = path.join(info.common, CONFIG_NAME);
  if (flags.has('--uninstall')) {
    if (fs.existsSync(config)) fs.unlinkSync(config);
    uninstallHook(info, log);
    log(`agent-git-guard is off for ${info.top}`);
    return 0;
  }
  const requireLock = flags.has('--require-lock');
  fs.writeFileSync(config, `${JSON.stringify({ guard: 1, requireLock }, null, 2)}\n`);
  log(`guard on for ${info.top} (marker: ${config})`);
  if (requireLock) installHook(info, log);
  else uninstallHook(info, () => {});
  log('');
  log(agentSnippets());
  return 0;
}

if (require.main === module) {
  try { process.exitCode = run(process.argv.slice(2)); } catch (e) { process.stderr.write(`install: ${e.message}\n`); process.exitCode = 1; }
}

module.exports = { run, hookScript };
