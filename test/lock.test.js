'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const lock = require('../lib/lock');
const { makeRepo } = require('./helpers');

const common = () => path.join(makeRepo(), '.git');

test('one holder at a time, by token', () => {
  const c = common();
  const a = lock.acquire(c, { name: 'agent-a' });
  assert.ok(a.ok);
  assert.match(a.token, /^agent-a-[0-9a-f]{8}$/);
  const b = lock.acquire(c, { name: 'agent-b' });
  assert.strictEqual(b.ok, false);
  assert.strictEqual(b.holder.token, a.token);
  assert.strictEqual(lock.check(c, a.token).state, 'mine');
  assert.strictEqual(lock.check(c, 'other').state, 'held');
  assert.strictEqual(lock.release(c, 'other').ok, false);
  assert.ok(lock.release(c, a.token).released);
  assert.strictEqual(lock.check(c, '').state, 'free');
  assert.ok(lock.acquire(c, { name: 'agent-b' }).ok);
});

test('acquire with your own token renews instead of failing', () => {
  const c = common();
  const a = lock.acquire(c, { name: 'a' });
  const again = lock.acquire(c, { name: 'a', token: a.token });
  assert.ok(again.ok && again.renewed);
});

test('a lock expires only by TTL, and then anyone can take it', () => {
  const c = common();
  const t0 = Date.parse('2026-11-22T00:00:00Z');
  const a = lock.acquire(c, { name: 'a', ttlMinutes: 30 }, t0);
  assert.strictEqual(lock.acquire(c, { name: 'b' }, t0 + 29 * 60000).ok, false);
  const b = lock.acquire(c, { name: 'b' }, t0 + 31 * 60000);
  assert.ok(b.ok);
  assert.notStrictEqual(b.token, a.token);
  assert.strictEqual(lock.renew(c, a.token, t0 + 31 * 60000).ok, false);
});

test('renew pushes the expiry forward', () => {
  const c = common();
  const t0 = Date.parse('2026-11-22T00:00:00Z');
  const a = lock.acquire(c, { name: 'a', ttlMinutes: 30 }, t0);
  assert.ok(lock.renew(c, a.token, t0 + 25 * 60000).ok);
  assert.strictEqual(lock.check(c, '', t0 + 50 * 60000).state, 'held');
  assert.strictEqual(lock.check(c, '', t0 + 56 * 60000).state, 'free');
});

test('an unreadable lock counts as held until its TTL runs out', () => {
  const c = common();
  fs.writeFileSync(lock.lockPath(c), 'not json');
  assert.strictEqual(lock.acquire(c, { name: 'a' }).ok, false);
  assert.ok(lock.release(c, '', { force: true }).released);
});

test('concurrent acquires: exactly one wins', async () => {
  const c = common();
  const { spawn } = require('child_process');
  const script = `const l=require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'lock.js'))});` +
    `process.stdout.write(String(l.acquire(${JSON.stringify(c)},{name:'p'+process.pid}).ok))`;
  const results = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['-e', script]);
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', reject);
    p.on('close', () => resolve(out.trim()));
  })));
  assert.strictEqual(results.length, 8);
  assert.strictEqual(results.filter((r) => r === 'true').length, 1, results.join(','));
  assert.strictEqual(results.filter((r) => r === 'false').length, 7, results.join(','));
});
