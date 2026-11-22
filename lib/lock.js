'use strict';
/**
 * One-writer-at-a-time lock per repository, held by a TOKEN rather than a PID: coding agents run every
 * command in a fresh shell that exits immediately, so a PID says nothing about whether the holder is
 * still working. A lock expires only by TTL (default 30 minutes since acquire/renew).
 *
 * The lock file lives in the shared .git directory (never committed, shared by all worktrees).
 * Creation uses an exclusive open ('wx'), and an expired lock is moved aside with an atomic rename
 * first, so two agents can never both win.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_TTL = 30;

function lockPath(common) { return path.join(common, 'agent-lock.json'); }

function read(common, now = Date.now()) {
  const file = lockPath(common);
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  let data = null;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = null; }
  if (!data || typeof data !== 'object') {
    // Unreadable lock: treat it as held for the default TTL since it was last written.
    data = { token: '', name: '(unreadable lock)', ttlMinutes: DEFAULT_TTL, renewedAt: stat.mtime.toISOString() };
  }
  const since = Date.parse(data.renewedAt || data.createdAt) || stat.mtimeMs;
  const ttl = Number(data.ttlMinutes) > 0 ? Number(data.ttlMinutes) : DEFAULT_TTL;
  const remaining = (since + ttl * 60000 - now) / 60000;
  return { ...data, ttlMinutes: ttl, remainingMinutes: Math.round(remaining * 10) / 10, expired: remaining <= 0 };
}

function describe(l) {
  // Never print the holder's token: other agents would be tempted to reuse it.
  return `${l.name || '?'} (agent=${l.agent || '?'}, ${l.remainingMinutes} min left)`;
}

function newToken(name) {
  const slug = String(name || 'lock').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) || 'lock';
  return `${slug}-${crypto.randomBytes(4).toString('hex')}`;
}

function writeExclusive(common, data) {
  const fd = fs.openSync(lockPath(common), 'wx');
  try { fs.writeSync(fd, JSON.stringify(data)); } finally { fs.closeSync(fd); }
}

function writeReplace(common, data) {
  const tmp = `${lockPath(common)}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, lockPath(common));
}

/** @returns {{ok:true, token, renewed?:boolean}|{ok:false, holder}} */
function acquire(common, { name = 'agent', agent = '', ttlMinutes = DEFAULT_TTL, token = '' } = {}, now = Date.now()) {
  const cur = read(common, now);
  if (cur && !cur.expired && !(token && cur.token === token)) return { ok: false, holder: cur };
  const stamp = new Date(now).toISOString();
  if (cur && !cur.expired && token && cur.token === token) {
    writeReplace(common, { ...cur, renewedAt: stamp, ttlMinutes, name, remainingMinutes: undefined, expired: undefined });
    return { ok: true, token, renewed: true };
  }
  if (cur) {
    // Expired: move it aside atomically; only one agent's rename can succeed.
    const aside = `${lockPath(common)}.expired-${crypto.randomBytes(4).toString('hex')}`;
    try { fs.renameSync(lockPath(common), aside); } catch { return { ok: false, holder: read(common, now) || cur }; }
    try { fs.unlinkSync(aside); } catch { /* already gone */ }
  }
  const mine = token || newToken(name);
  try {
    writeExclusive(common, { token: mine, name, agent, createdAt: stamp, renewedAt: stamp, ttlMinutes,
      host: os.hostname(), pid: process.pid });
  } catch (e) {
    if (e.code === 'EEXIST') return { ok: false, holder: read(common, now) };
    throw e;
  }
  return { ok: true, token: mine };
}

function renew(common, token, now = Date.now()) {
  const cur = read(common, now);
  if (!cur || cur.expired || !token || cur.token !== token) return { ok: false, holder: cur };
  const { remainingMinutes, expired, ...data } = cur;
  writeReplace(common, { ...data, renewedAt: new Date(now).toISOString() });
  return { ok: true, token };
}

function release(common, token, { force = false } = {}, now = Date.now()) {
  const cur = read(common, now);
  if (!cur) return { ok: true, released: false };
  if ((token && cur.token === token) || cur.expired || force) {
    try { fs.unlinkSync(lockPath(common)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return { ok: true, released: true, forced: force && cur.token !== token && !cur.expired };
  }
  return { ok: false, holder: cur };
}

/** 'free' | 'mine' | 'held' */
function check(common, token, now = Date.now()) {
  const cur = read(common, now);
  if (!cur || cur.expired) return { state: 'free', holder: cur };
  return { state: token && cur.token === token ? 'mine' : 'held', holder: cur };
}

module.exports = { acquire, renew, release, check, read, describe, lockPath, DEFAULT_TTL };
