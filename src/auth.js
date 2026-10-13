'use strict';
// Visitor ids, staff passwords and admin sessions.
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const { LV } = require('./rules');

const IDLE_MS = 30 * 60 * 1000;          // admin sessions end after 30 minutes without activity
const MAX_SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000;
const UID_COOKIE = 'gb_uid', SESSION_COOKIE = 'gb_sess';

// ---------- cookies ----------
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('='); if (i < 0) return;
    const k = p.slice(0, i).trim(); if (!k) return;
    try { out[k] = decodeURIComponent(p.slice(i + 1).trim()); } catch (_) {}
  });
  return out;
}
function setCookie(res, name, value, maxAgeMs) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (config.secureCookies) parts.push('Secure');
  if (maxAgeMs !== undefined) parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(Array.isArray(prev) ? prev : prev ? [prev] : []), parts.join('; ')]);
}
const sign = v => crypto.createHmac('sha256', config.sessionSecret).update(v).digest('base64url').slice(0, 32);
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// Every browser gets a signed, random visitor id. It identifies the shopper's bag-to-order
// history (customers/{id}) and their visit record (visits/{id}).
function visitorId(req, res) {
  const raw = parseCookies(req)[UID_COOKIE];
  if (raw) {
    const [id, sig] = raw.split('.');
    if (id && sig && /^v_[A-Za-z0-9_-]{16,40}$/.test(id) && safeEq(sig, sign(id))) return id;
  }
  const id = 'v_' + crypto.randomBytes(15).toString('base64url');
  setCookie(res, UID_COOKIE, `${id}.${sign(id)}`, 2 * 365 * 864e5);
  return id;
}

// ---------- passwords ----------
const normEmail = e => String(e || '').trim().toLowerCase();
const emailOk = e => e.length <= 120 && /^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(e);
const pwProblem = pw => typeof pw !== 'string' || pw.length < 10 ? 'Use at least 10 characters.'
  : pw.length > 200 ? 'That password is too long.'
  : (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) ? 'Use letters and at least one number.' : '';
const authKey = email => 'a_' + crypto.createHash('sha256').update(normEmail(email)).digest('hex').slice(0, 24);

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  const dummy = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');
  const [kind, N, r, p, salt, hash] = String(stored || dummy).split('$');
  if (kind !== 'scrypt') return false;
  const want = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(String(pw || ''), Buffer.from(salt, 'base64'), want.length, { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
  return stored ? crypto.timingSafeEqual(want, got) : false;
}
// Invite codes are created in the browser as PBKDF2-SHA256 hashes and stored on the staff document.
function verifyInvite(code, inv) {
  if (!inv || !inv.salt || !inv.hash) return false;
  const got = crypto.pbkdf2Sync(code, Buffer.from(inv.salt, 'base64'), Math.min(+inv.iter || 210000, 1000000), 32, 'sha256').toString('base64');
  return safeEq(got, inv.hash);
}

// ---------- sessions ----------
const tokenHash = t => crypto.createHash('sha256').update(t).digest('hex');
async function startSession(res, email) {
  const token = crypto.randomBytes(32).toString('base64url'), now = Date.now();
  await db.pool.query('INSERT INTO sessions (token_hash, email, created_at, last_seen, expires_at) VALUES ($1,$2,$3,$3,$4)',
    [tokenHash(token), email, now, now + MAX_SESSION_MS]);
  setCookie(res, SESSION_COOKIE, token, MAX_SESSION_MS);
}
async function endSession(req, res) {
  const t = parseCookies(req)[SESSION_COOKIE];
  if (t) await db.pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(t)]);
  setCookie(res, SESSION_COOKIE, '', 0);
}
async function endAllSessions(email, client = db.pool) { await client.query('DELETE FROM sessions WHERE email = $1', [email]); }

// staff documents are read on most admin requests; keep them for a few seconds
const staffCache = new Map();
async function staffDoc(email) {
  const hit = staffCache.get(email);
  if (hit && Date.now() - hit.at < 5000) return hit.doc;
  const doc = await db.getDoc('staff/' + email);
  staffCache.set(email, { at: Date.now(), doc });
  return doc;
}
const forgetStaff = email => staffCache.delete(email);

// Build the request context: who is asking and what level they hold.
async function context(req, res) {
  const ctx = { uid: visitorId(req, res), level: LV.interact, role: null, email: null, authKey: null, perms: {} };
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return ctx;
  const now = Date.now();
  const r = await db.pool.query('SELECT * FROM sessions WHERE token_hash = $1', [tokenHash(token)]);
  const s = r.rows[0];
  if (!s || +s.expires_at < now || now - +s.last_seen > IDLE_MS) {
    if (s) await db.pool.query('DELETE FROM sessions WHERE token_hash = $1', [s.token_hash]);
    setCookie(res, SESSION_COOKIE, '', 0);
    ctx.sessionExpired = !!s;
    return ctx;
  }
  const cred = (await db.pool.query('SELECT email, role FROM credentials WHERE email = $1', [s.email])).rows[0];
  if (!cred) { await endAllSessions(s.email); return ctx; }
  if (cred.role === 'assistant') {
    const st = await staffDoc(cred.email);
    if (!st || st.role !== 'assistant' || st.active === false) { await endAllSessions(cred.email); setCookie(res, SESSION_COOKIE, '', 0); return ctx; }
    Object.assign(ctx, { level: LV.admin, role: 'assistant', perms: st.perms || {} });
  } else Object.assign(ctx, { level: LV.owner, role: 'owner' });
  ctx.email = cred.email; ctx.authKey = authKey(cred.email);
  if (now - +s.last_seen > 60000) await db.pool.query('UPDATE sessions SET last_seen = $2 WHERE token_hash = $1', [s.token_hash, now]);
  return ctx;
}

// Mirror of each login for the admin screens (no password data).
async function writeAuthDoc(client, email, role, fields) {
  const path = 'staffAuth/' + authKey(email);
  const prev = (await db.getDoc(path, client)) || {};
  await db.putDoc(client, path, { ...prev, email, role, hash: true, ...fields });
}

module.exports = {
  IDLE_MS, MAX_FAILS, LOCK_MS, parseCookies, visitorId, normEmail, emailOk, pwProblem, authKey,
  hashPassword, verifyPassword, verifyInvite, startSession, endSession, endAllSessions,
  context, writeAuthDoc, forgetStaff,
};
