'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { commands, parseGit, cdTarget } = require('./shell');
const { repoInfo, guardConfig, finishingOperation } = require('./repo');

// Tools that run shell commands, per agent: Claude Code (Bash, PowerShell), Codex (Bash, shell, exec).
const EXEC_TOOLS = new Set(['Bash', 'PowerShell', 'shell', 'exec', 'run_command', 'run_shell_command']);

// Options that take a value, per git subcommand, so a message like `-m "--amend"` is not read as an option.
const VALUE_OPTS = {
  commit: { short: 'mFCct', long: ['message', 'file', 'reuse-message', 'reedit-message', 'author', 'date', 'fixup',
    'squash', 'template', 'trailer', 'cleanup', 'pathspec-from-file', 'untracked-files'] },
  add: { short: '', long: ['chmod', 'pathspec-from-file'] },
  push: { short: 'o', long: ['repo', 'push-option', 'receive-pack', 'exec', 'force-with-lease'] },
  reset: { short: '', long: ['pathspec-from-file'] },
  checkout: { short: 'bB', long: ['orphan', 'conflict', 'pathspec-from-file'] },
  restore: { short: 's', long: ['source', 'pathspec-from-file', 'conflict'] },
  stash: { short: 'm', long: ['message', 'pathspec-from-file'] },
  clean: { short: 'e', long: ['exclude'] },
  switch: { short: 'cC', long: ['create', 'force-create', 'orphan', 'conflict'] },
};

/** Split args into short flags (letters), long flags (names), positionals and paths after `--`. */
function parseArgs(sub, args) {
  const spec = VALUE_OPTS[sub] || { short: '', long: [] };
  const short = new Set(), long = new Set(), positional = [], afterDash = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { afterDash.push(...args.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const [name, val] = a.slice(2).split(/=(.*)/s);
      long.add(name);
      if (val === undefined && spec.long.includes(name) && name !== 'force-with-lease') i++;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        short.add(a[k]);
        if (spec.short.includes(a[k])) { if (k === a.length - 1) i++; break; }
      }
      continue;
    }
    positional.push(a);
  }
  return { short, long, positional, afterDash, paths: [...positional, ...afterDash] };
}

// Pathspecs that mean "the whole repo" (`:/src` is just `src` from the top, so it is not one of them).
const WHOLE_REPO = new Set(['.', './', '.\\', '*', ':', ':/', ':/.', ':(top)', ':(top).', ':/*']);
const EVERYTHING = { test: (x) => WHOLE_REPO.has(x) };
const COMMITISH = /^(?:HEAD|@|ORIG_HEAD|FETCH_HEAD|[0-9a-f]{7,40})(?:[~^]\d*)*$/i;

const FIX_ADD = 'Stage only the files you changed: git add <path> [<path>...]';
const FIX_COMMIT = 'Commit only your own files: git commit -m "..." -- <path> [<path>...]';

/** @returns {{action:'block'|'warn', message:string}|null} */
function checkGit(sub, args, info) {
  const p = parseArgs(sub, args);
  const block = (message) => ({ action: 'block', message });
  const warn = (message) => ({ action: 'warn', message });
  switch (sub) {
    case 'add':
      if (p.short.has('A') || p.long.has('all') || p.short.has('u') || p.long.has('update') || p.long.has('no-ignore-removal'))
        return block(`git add ${p.short.has('u') || p.long.has('update') ? '-u' : '-A'} stages every change in the repo, including other agents' work. ${FIX_ADD}`);
      if (p.paths.some((x) => EVERYTHING.test(x)))
        return block(`git add with "${p.paths.find((x) => EVERYTHING.test(x))}" stages every change in the repo, including other agents' work. ${FIX_ADD}`);
      return null;
    case 'commit':
      if (p.long.has('amend'))
        return block('git commit --amend can fold another agent\'s commit into yours. Make a new commit instead.');
      if (p.long.has('no-verify') || p.short.has('n'))
        return block('git commit --no-verify/-n skips the hooks that keep agents from colliding. Commit without it.');
      if (p.short.has('a') || p.long.has('all'))
        return block(`git commit -a commits every tracked change, including other agents' work. ${FIX_COMMIT}`);
      if (!p.paths.length && !p.long.has('pathspec-from-file') && !finishingOperation(info))
        return block(`git commit without paths commits everything staged, and another agent may have staged files too. ${FIX_COMMIT}`);
      return null;
    case 'push': {
      if (p.long.has('no-verify')) return block('git push --no-verify skips the pre-push hook. Push without it.');
      const force = p.long.has('force') || p.short.has('f') || p.long.has('force-with-lease') || p.long.has('force-if-includes')
        || p.long.has('mirror') || p.positional.some((x) => x.startsWith('+'));
      if (force) return block('Force push rewrites history other agents may have built on. Ask the human to do it if it is really needed.');
      return null;
    }
    case 'reset':
      if (p.long.has('hard') || p.long.has('merge'))
        return block('git reset --hard throws away uncommitted work, including other agents\' changes. Restore your own files: git restore -- <path>');
      if (!p.afterDash.length && (p.positional.length === 0 || p.positional.every((x) => COMMITISH.test(x))))
        return block('git reset without paths unstages (or moves the branch for) everyone. Unstage your own files: git restore --staged -- <path>');
      return null;
    case 'clean':
      if (p.short.has('f') || p.long.has('force'))
        return block('git clean -f deletes untracked files, which may be another agent\'s new work. Delete your own files by name.');
      return null;
    case 'checkout':
      if (p.short.has('f') || p.long.has('force'))
        return block('git checkout -f discards uncommitted changes, including other agents\' work.');
      if (p.paths.some((x) => EVERYTHING.test(x)))
        return block('git checkout . discards every uncommitted change in the repo, including other agents\' work. Restore your own files: git restore -- <path>');
      if (!p.afterDash.length && p.positional.length === 1 && !p.short.has('b') && !p.short.has('B'))
        return warn('Switching branches in a shared working tree changes files under every agent working in it. Make sure nobody else is mid-change, or use git worktree.');
      return null;
    case 'switch':
      if (p.long.has('discard-changes') || p.short.has('f') || p.long.has('force'))
        return block('git switch --discard-changes throws away other agents\' uncommitted work.');
      return warn('Switching branches in a shared working tree changes files under every agent working in it. Make sure nobody else is mid-change, or use git worktree.');
    case 'restore':
      if (p.paths.some((x) => EVERYTHING.test(x)))
        return block('git restore . touches every file in the repo, including other agents\' work. Restore your own files: git restore -- <path>');
      return null;
    case 'stash': {
      const action = p.positional[0];
      if (action === 'clear') return block('git stash clear deletes every stash, including other agents\'. Drop your own: git stash drop <stash>');
      if ((!action || action === 'push' || action === 'save') && !p.afterDash.length && !(action === 'push' && p.positional.length > 1))
        return block('git stash without paths stashes every agent\'s uncommitted changes. Stash your own files: git stash push -- <path>');
      return null;
    }
    case 'merge': case 'rebase': case 'cherry-pick': case 'am':
      if (p.long.has('no-verify')) return block(`git ${sub} --no-verify skips the hooks that keep agents from colliding.`);
      return null;
    default:
      return null;
  }
}

const expand = (p) => (p === '~' ? os.homedir() : p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(2)) : p);

/**
 * Decide on one PreToolUse event. Only repos marked with install.js are guarded.
 * @returns {{action:'allow'}|{action:'block'|'warn', message:string}}
 */
function evaluate(event) {
  const input = (event && event.tool_input) || {};
  const raw = input.command ?? input.cmd ?? input.CommandLine;
  if (!EXEC_TOOLS.has(event && event.tool_name) || raw === undefined) return { action: 'allow' };
  let cwd = path.resolve(expand(String(event.cwd || process.cwd())));
  const warnings = [];
  for (const argv of commands(raw)) {
    const cd = cdTarget(argv);
    if (cd) {
      // A cd into a missing directory fails and the shell stays put (and `;` runs the next command there).
      const next = path.resolve(cwd, expand(cd));
      if (fs.existsSync(next)) cwd = next;
      continue;
    }
    const g = parseGit(argv);
    if (!g) continue;
    const info = repoInfo(g.dir ? path.resolve(cwd, expand(g.dir)) : cwd);
    if (!guardConfig(info)) continue;
    const verdict = checkGit(g.sub, g.args, info);
    if (verdict && verdict.action === 'block') return { action: 'block', message: `agent-git-guard: ${verdict.message}` };
    if (verdict) warnings.push(verdict.message);
  }
  return warnings.length ? { action: 'warn', message: `agent-git-guard: ${warnings.join(' ')}` } : { action: 'allow' };
}

module.exports = { evaluate, checkGit, parseArgs };
