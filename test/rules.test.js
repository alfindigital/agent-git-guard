'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { evaluate } = require('../lib/rules');
const { commands } = require('../lib/shell');
const { makeRepo, git } = require('./helpers');

const repo = makeRepo();
const plain = makeRepo({ guarded: false });
const run = (command, cwd = repo, tool_name = 'Bash') => evaluate({ tool_name, cwd, tool_input: { command } });
const action = (command, cwd) => run(command, cwd).action;

test('blocks commands that sweep up or rewrite other agents\' work', () => {
  const blocked = [
    'git add -A', 'git add --all', 'git add .', 'git add -- .', 'git add :/', 'git add -u', 'git add *',
    'git commit -m "x"', 'git commit -am "x"', 'git commit -a -m x -- a.txt', 'git commit --amend -m x -- a.txt',
    'git commit --amend --no-edit', 'git commit -n -m x -- a.txt', 'git commit -nm x -- a.txt', 'git commit --no-verify -m x -- a.txt',
    'git push --force', 'git push -f origin main', 'git push --force-with-lease', 'git push origin +main', 'git push --no-verify',
    'git reset --hard', 'git reset --hard HEAD~1', 'git reset', 'git reset HEAD~1', 'git reset --soft HEAD^',
    'git clean -fd', 'git clean -xfd', 'git checkout .', 'git checkout -- .', 'git checkout -f main',
    'git restore .', 'git restore --staged .', 'git stash', 'git stash push', 'git stash -u', 'git stash save wip',
    'git stash clear', 'git switch --discard-changes main', 'git rebase --no-verify main',
  ];
  for (const c of blocked) assert.strictEqual(action(c), 'block', c);
});

test('allows the safe forms', () => {
  const allowed = [
    'git status', 'git diff', 'git log --oneline -5', 'git add a.txt', 'git add src/ docs/readme.md', 'git add :/src',
    'git commit -m "fix" -- a.txt', 'git commit -m "fix" a.txt', 'git push', 'git push origin main',
    'git reset -- a.txt', 'git reset HEAD a.txt', 'git restore -- a.txt', 'git restore --staged a.txt',
    'git clean -n', 'git stash list', 'git stash show -p', 'git stash push -- a.txt', 'git stash pop', 'git fetch --all',
    'git checkout -b feature', 'git pull --rebase',
  ];
  for (const c of allowed) assert.strictEqual(action(c), 'allow', c);
});

test('only guarded repos are affected', () => {
  assert.strictEqual(action('git add -A', plain), 'allow');
  assert.strictEqual(action(`git -C "${repo}" add -A`, plain), 'block');
  assert.strictEqual(action(`cd "${repo}" && git add -A`, plain), 'block');
  assert.strictEqual(action(`cd "${plain}" && git add -A`, repo), 'allow');
  assert.strictEqual(action('git add -A', path.dirname(repo)), 'allow'); // not a repo at all
});

test('quoted text and heredocs are data, not commands', () => {
  for (const c of [
    'git commit -m "never use git add -A" -- a.txt',
    'git commit -m "--amend is banned" -- a.txt',
    'echo "git push --force"',
    'grep -n "git reset --hard" notes.md',
    "cat <<'EOF' > notes.md\ngit add -A\ngit push --force\nEOF",
    'python -c "print(\'git add -A\')"',
  ]) assert.strictEqual(action(c), 'allow', c);
});

test('commands hidden behind shells, wrappers and chains are still found', () => {
  for (const c of [
    'bash -c "git add -A"', "sh -lc 'cd sub; git commit -m x'", 'powershell -Command git add -A',
    'pwsh -NoProfile -Command "git push --force"', 'cmd /c git add .', 'FOO=1 git commit -m x',
    'env GIT_TRACE=1 git add -A', 'git status && git add -A', 'git status; git push -f', 'npm test || git reset --hard',
    'git -c core.quotepath=off add -A',
  ]) assert.strictEqual(action(c), 'block', c);
  // Codex sends argv arrays
  assert.strictEqual(evaluate({ tool_name: 'Bash', cwd: repo, tool_input: { command: ['bash', '-lc', 'git add -A'] } }).action, 'block');
  assert.strictEqual(evaluate({ tool_name: 'Bash', cwd: repo, tool_input: { command: ['git', 'status'] } }).action, 'allow');
});

test('PowerShell tool and non-shell tools', () => {
  assert.strictEqual(run('git add -A; git status', repo, 'PowerShell').action, 'block');
  assert.strictEqual(evaluate({ tool_name: 'Write', cwd: repo, tool_input: { file_path: 'x', content: 'git add -A' } }).action, 'allow');
  assert.strictEqual(evaluate({ tool_name: 'Bash', cwd: repo, tool_input: {} }).action, 'allow');
});

test('branch switching only warns', () => {
  const r = run('git switch main');
  assert.strictEqual(r.action, 'warn');
  assert.match(r.message, /worktree/);
  assert.strictEqual(action('git checkout main'), 'warn');
});

test('a merge can be concluded without paths', () => {
  const r = makeRepo();
  fs.writeFileSync(path.join(r, '.git', 'MERGE_HEAD'), git(r, ['rev-parse', 'HEAD']));
  assert.strictEqual(action('git commit --no-edit', r), 'allow');
  assert.strictEqual(action('git commit --amend', r), 'block');
});

test('block messages say how to do it right', () => {
  assert.match(run('git add -A').message, /git add <path>/);
  assert.match(run('git commit -m x').message, /-- <path>/);
  assert.match(run('git reset --hard').message, /git restore/);
});

test('shell parser keeps quoted words whole', () => {
  assert.deepStrictEqual(commands('git commit -m "a; b && c" -- x'), [['git', 'commit', '-m', 'a; b && c', '--', 'x']]);
  assert.deepStrictEqual(commands("a 'x|y' | b"), [['a', 'x|y'], ['b']]);
});
