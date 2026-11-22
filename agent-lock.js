#!/usr/bin/env node
/**
 * agent-lock: one writer at a time per git repository.
 *
 *   node agent-lock.js acquire [--name build] [--agent claude] [--ttl 30]   prints "ACQUIRED token=<token>"; exit 3 if held
 *   node agent-lock.js renew   --token <token>                              extend the TTL (work longer than 30 min)
 *   node agent-lock.js release --token <token> [--force]                    --force only with the human's OK
 *   node agent-lock.js check   [--token <token>]                            exit 0 free or yours, exit 3 held by someone else
 *   node agent-lock.js status
 *   node agent-lock.js hook-check                                           used by the pre-commit hook
 *
 * Options: -C <dir> picks the repository (default: current directory). The token can also come from
 * the AGENT_LOCK_TOKEN environment variable.
 *
 * Exit codes: 0 ok, 1 error / commit refused, 2 usage, 3 held by another writer.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const lock = require('./lib/lock');
const { repoInfo } = require('./lib/repo');

function parse(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-C') opts.C = argv[++i];
    else if (a === '--force') opts.force = true;
    else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      opts[k] = v !== undefined ? v : argv[++i];
    } else opts._.push(a);
  }
  return opts;
}

function howTo() {
  const me = `node "${__filename.replace(/\\/g, '/')}"`;
  return [
    'How to commit while other agents share this repo:',
    `  1. ${me} acquire --name <task>        -> note token=<token>`,
    '  2. AGENT_LOCK_TOKEN=<token> git commit -m "..." -- <your paths>',
    '     (PowerShell: $env:AGENT_LOCK_TOKEN="<token>"; git commit -m "..." -- <your paths>)',
    `  3. ${me} release --token <token>`,
  ].join('\n');
}

function run(argv, env = process.env, out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`)) {
  const opts = parse(argv);
  const cmd = opts._[0];
  const token = opts.token || env.AGENT_LOCK_TOKEN || '';
  const info = repoInfo(path.resolve(opts.C || process.cwd()));
  if (!info) { err('agent-lock: not inside a git repository'); return 1; }
  const common = info.common;
  const ttl = opts.ttl !== undefined ? Number(opts.ttl) : lock.DEFAULT_TTL;
  if (!(ttl > 0)) { err('agent-lock: --ttl must be a positive number of minutes'); return 2; }

  switch (cmd) {
    case 'acquire': {
      const r = lock.acquire(common, { name: opts.name || 'agent', agent: opts.agent || '', ttlMinutes: ttl, token });
      if (!r.ok) { out(`BLOCKED by ${lock.describe(r.holder)}`); return 3; }
      out(`ACQUIRED token=${r.token} ttl=${ttl}min${r.renewed ? ' (renewed)' : ''}`);
      out(`release with: node agent-lock.js release --token ${r.token}`);
      return 0;
    }
    case 'renew': {
      const r = lock.renew(common, token);
      if (!r.ok) { out(r.holder ? `CANNOT RENEW: held by ${lock.describe(r.holder)}` : 'CANNOT RENEW: no lock (acquire again)'); return 3; }
      out(`RENEWED token=${token}`);
      return 0;
    }
    case 'release': {
      const r = lock.release(common, token, { force: !!opts.force });
      if (!r.ok) { out(`HELD by ${lock.describe(r.holder)}; only its holder can release it`); return 3; }
      out(r.released ? `RELEASED${r.forced ? ' (forced)' : ''}` : 'NOTHING TO RELEASE');
      return 0;
    }
    case 'check': {
      const r = lock.check(common, token);
      out(r.state === 'held' ? `HELD by ${lock.describe(r.holder)}` : r.state.toUpperCase());
      return r.state === 'held' ? 3 : 0;
    }
    case 'status': {
      const l = lock.read(common);
      out(!l ? 'FREE (no lock)' : `${l.expired ? 'EXPIRED' : 'HELD'} ${lock.describe(l)}`);
      return 0;
    }
    case 'hook-check': {
      const reason = env.AGENT_LOCK_BYPASS;
      if (reason) {
        // Human escape hatch: needs a reason, and every use is logged next to the lock.
        fs.appendFileSync(path.join(common, 'agent-lock-bypass.log'),
          `${new Date().toISOString()} user=${env.USER || env.USERNAME || '?'} reason=${reason}\n`);
        err(`agent-lock: bypass logged (${reason})`);
        return 0;
      }
      const r = lock.check(common, token);
      if (r.state === 'mine') return 0;
      if (r.state === 'held') err(`pre-commit refused: the commit lock is held by ${lock.describe(r.holder)}. Wait for it, or ask its holder.`);
      else if (token) err('pre-commit refused: your lock token does not match an active lock (it may have expired). Acquire it again.');
      else err('pre-commit refused: commits in this repository need the commit lock, and you are not holding it.');
      err(howTo());
      return 1;
    }
    default:
      err('usage: node agent-lock.js acquire|renew|release|check|status|hook-check [--name x] [--ttl min] [--token t] [-C dir]');
      return 2;
  }
}

if (require.main === module) process.exitCode = run(process.argv.slice(2));

module.exports = { run };
