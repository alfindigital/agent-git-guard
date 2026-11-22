#!/usr/bin/env node
/**
 * agent-git-guard: PreToolUse hook for Claude Code and Codex CLI.
 *
 * Reads the hook event (JSON) on stdin. In repos marked with `node install.js`, it blocks git commands
 * that let one agent sweep up, rewrite or throw away another agent's work.
 *
 *   exit 0                 allow
 *   exit 0 + JSON stdout   allow, with a warning added to the agent's context
 *   exit 2 + stderr        block; the agent sees the reason and how to fix it
 *
 * Fails open: if the event cannot be read, the command is allowed and the reason goes to stderr.
 */
'use strict';
const { evaluate } = require('./lib/rules');

function main(text) {
  let event;
  try { event = JSON.parse(text || '{}'); } catch {
    process.stderr.write('agent-git-guard: hook input is not JSON; allowing.\n');
    return 0;
  }
  let verdict;
  try { verdict = evaluate(event); } catch (e) {
    process.stderr.write(`agent-git-guard: internal error (${e && e.message}); allowing.\n`);
    return 0;
  }
  if (verdict.action === 'block') {
    process.stderr.write(`${verdict.message}\n`);
    return 2;
  }
  if (verdict.action === 'warn') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: verdict.message },
    }));
  }
  return 0;
}

if (require.main === module) {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { text += c; });
  process.stdin.on('end', () => { process.exitCode = main(text); });
}

module.exports = { main };
