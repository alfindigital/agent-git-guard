'use strict';
/**
 * Just enough shell parsing to find the git commands a command line will actually run.
 *
 * - Quoted text stays one word, so `git commit -m "never git add -A"` or `echo "git add -A"` is not
 *   mistaken for `git add -A`.
 * - Commands are split at ; && || | & newlines and parentheses.
 * - Heredoc bodies are dropped (they are data, not commands).
 * - `bash -c '...'`, `sh -c`, `zsh -c`, `pwsh -Command`, `powershell -Command` and `cmd /c` are unwrapped
 *   and parsed recursively, because their argument is what runs.
 * - Leading `VAR=value`, `env`, `sudo`, `command`, `nohup`, `time`, `xargs` are skipped.
 *
 * It is a guard against honest mistakes by coding agents, not a sandbox: aliases, scripts and
 * deliberately obfuscated commands are out of scope.
 */

const OPERATORS = ['&&', '||', ';', '|', '&', '\n', '(', ')'];
const WRAPPERS = new Set(['env', 'sudo', 'doas', 'command', 'builtin', 'nohup', 'time', 'xargs', 'exec', 'nice',
  'then', 'do', 'else', '!', '{']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'pwsh', 'powershell', 'cmd']);

/** Drop heredoc bodies: `cat <<'EOF' ... EOF` keeps the `cat <<'EOF'` line only. */
function stripHeredocs(text) {
  return text.replace(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g,
    (m) => m.slice(0, m.indexOf('\n')));
}

/** Split into tokens: {w: word} or {op: operator}. Quotes are honoured (one level). */
function tokenize(text) {
  const out = [];
  let cur = '', has = false;
  const push = () => { if (has) out.push({ w: cur }); cur = ''; has = false; };
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === "'") {
      const j = text.indexOf("'", i + 1), e = j < 0 ? text.length : j;
      cur += text.slice(i + 1, e); has = true; i = e + 1; continue;
    }
    if (c === '"') {
      let j = i + 1, s = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < text.length && '"\\$`'.includes(text[j + 1])) { s += text[j + 1]; j += 2; continue; }
        if (text[j] === '`' && j + 1 < text.length && text[j + 1] === '"') { s += '"'; j += 2; continue; } // PowerShell escape
        s += text[j]; j++;
      }
      cur += s; has = true; i = j + 1; continue;
    }
    if (c === '\\' && i + 1 < text.length && text[i + 1] !== '\n') { cur += text[i + 1]; has = true; i += 2; continue; }
    if (c === '\\' && text[i + 1] === '\n') { i += 2; continue; } // line continuation
    if (c === '`' && text[i + 1] === '\n') { i += 2; continue; }  // PowerShell line continuation
    const op = OPERATORS.find((o) => text.startsWith(o, i));
    if (op) { push(); out.push({ op }); i += op.length; continue; }
    if (/\s/.test(c)) { push(); i++; continue; }
    cur += c; has = true; i++;
  }
  push();
  return out;
}

const base = (w) => String(w || '').replace(/^.*[/\\]/, '').replace(/\.exe$/i, '').toLowerCase();

/** Split a command line into simple commands (arrays of words), unwrapping shells recursively. */
function commands(input, depth = 0) {
  if (depth > 4) return [];
  const words = Array.isArray(input) ? [input.map(String)] : splitWords(tokenize(stripHeredocs(String(input || ''))));
  const out = [];
  for (let argv of words) {
    // skip VAR=value prefixes and wrapper commands
    let i = 0;
    while (i < argv.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]) || WRAPPERS.has(argv[i]))) {
      i++;
      if (argv[i - 1] === 'env') while (i < argv.length && /^-/.test(argv[i])) i++;
    }
    argv = argv.slice(i);
    if (!argv.length) continue;
    const cmd = base(argv[0]);
    if (SHELLS.has(cmd)) {
      const k = argv.findIndex((a, n) => n > 0 && /^(?:-[a-z]*c|-Command|-c|\/c)$/i.test(a));
      if (k > 0 && k + 1 < argv.length) {
        // bash -c takes one script argument; PowerShell and cmd run the rest of the line
        const script = ['cmd', 'pwsh', 'powershell'].includes(cmd) ? argv.slice(k + 1).join(' ') : argv[k + 1];
        out.push(...commands(script, depth + 1));
        continue;
      }
    }
    out.push(argv);
  }
  return out;
}

function splitWords(tokens) {
  const out = [];
  let cur = [];
  for (const t of tokens) {
    if (t.op) { if (cur.length) out.push(cur); cur = []; } else cur.push(t.w);
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Parse `git [-C dir] [-c k=v] [--git-dir=..] <sub> args...`.
 * @returns {{dir: string|null, sub: string, args: string[]}|null}
 */
function parseGit(argv) {
  if (base(argv[0]) !== 'git') return null;
  let dir = null, i = 1;
  while (i < argv.length && argv[i].startsWith('-')) {
    const a = argv[i];
    if (a === '-C') { dir = argv[i + 1] ?? null; i += 2; continue; }
    if (a === '-c' || a === '--git-dir' || a === '--work-tree' || a === '--namespace') { i += 2; continue; }
    i++;
  }
  if (i >= argv.length) return null;
  return { dir, sub: argv[i], args: argv.slice(i + 1) };
}

/** The directory argv changes into (`cd x`, `Set-Location x`, `pushd x`), or null. */
function cdTarget(argv) {
  const c = base(argv[0]);
  return (c === 'cd' || c === 'set-location' || c === 'sl' || c === 'pushd') && argv.length > 1 ? argv[argv.length - 1] : null;
}

module.exports = { tokenize, commands, parseGit, cdTarget, stripHeredocs };
