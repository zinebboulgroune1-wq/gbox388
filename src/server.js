'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const { canRead, canWrite } = require('./rules');
const { validateCustomerWrite, OrderError } = require('./orders');
const { seedIfEmpty, ensureOwnerFromEnv, setupCode } = require('./seed');
const notify = require('./notify');

const app = express();
app.set('trust proxy', config.trustProxy ? 1 : false);
app.disable('x-powered-by');
app.use(compression());
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'script-src': ["'self'", "'unsafe-inline'"],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
      'img-src': ["'self'", 'data:', 'blob:'],
      'media-src': ["'self'", 'blob:'],
      'connect-src': ["'self'"],
      'frame-ancestors': ["'none'"],
      'upgrade-insecure-requests': config.secureCookies ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// ---------- helpers ----------
const fail = (res, status, code, message) => res.status(status).json({ code, message });
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
async function ctxOf(req, res) { if (!req.ctx) req.ctx = await auth.context(req, res); return req.ctx; }

// simple in-memory rate limiter (per key, sliding window)
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(), arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(key, arr);
  return arr.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();

// ---------- live updates (Server-Sent Events) ----------
// Clients are told which top-level collections changed and re-read what they're showing.
const listeners = new Set();
function broadcast(paths) {
  const tops = [...new Set(paths.map(p => p.split('/')[0]))];
  const msg = `data: ${JSON.stringify({ tops })}\n\n`;
  for (const res of listeners) { try { res.write(msg); } catch (_) {} }
}
app.get('/api/events', wrap(async (req, res) => {
  await ctxOf(req, res);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  listeners.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); listeners.delete(res); });
}));

// ---------- who am I ----------
app.get('/api/me', wrap(async (req, res) => {
  const ctx = await ctxOf(req, res);
  const owner = await db.pool.query(`SELECT 1 FROM credentials WHERE role = 'owner' LIMIT 1`);
  res.set('Cache-Control', 'no-store');
  res.json({
    uid: ctx.uid,
    session: ctx.role ? { email: ctx.email, role: ctx.role, authKey: ctx.authKey } : null,
    sessionExpired: !!ctx.sessionExpired,
    ownerExists: owner.rows.length > 0,
  });
}));

// ---------- staff login ----------
app.use('/api/auth', express.json({ limit: '20kb' }));
app.use('/api/auth', (req, res, next) => {
  if (req.method === 'POST' && limited('auth:' + req.ip, 20, 10 * 60e3)) return fail(res, 429, 'rate_limited', 'Too many attempts. Wait a few minutes and try again.');
  next();
});

async function loginFailed(email) {
  const r = await db.pool.query('SELECT fails, lock_until FROM credentials WHERE email = $1', [email]);
  const row = r.rows[0]; if (!row) return 0;
  const fails = (+row.lock_until > Date.now() ? 0 : +row.fails) + 1;
  if (fails >= auth.MAX_FAILS) { await db.pool.query('UPDATE credentials SET fails = 0, lock_until = $2 WHERE email = $1', [email, Date.now() + auth.LOCK_MS]); return 0; }
  await db.pool.query('UPDATE credentials SET fails = $2, lock_until = 0 WHERE email = $1', [email, fails]);
  return auth.MAX_FAILS - fails;
}

app.post('/api/auth/login', wrap(async (req, res) => {
  await ctxOf(req, res);
  const email = auth.normEmail(req.body.email), pw = String(req.body.password || '');
  if (!email || !pw) return fail(res, 400, 'invalid', 'Enter your email and password.');
  const cred = (await db.pool.query('SELECT * FROM credentials WHERE email = $1', [email])).rows[0];
  if (cred && +cred.lock_until > Date.now()) {
    const m = Math.ceil((+cred.lock_until - Date.now()) / 60000);
    return fail(res, 423, 'locked', `Too many failed attempts. Try again in ${m} minute${m === 1 ? '' : 's'}.`);
  }
  const ok = auth.verifyPassword(pw, cred && cred.hash);
  if (!ok) {
    const left = cred ? await loginFailed(email) : 0;
    return fail(res, 401, 'bad_login', cred && !left ? 'Too many failed attempts. Login is locked for 15 minutes.'
      : `Email or password is incorrect.${left ? ` ${left} attempt${left === 1 ? '' : 's'} left before a 15-minute lock.` : ''}`);
  }
  if (cred.role === 'assistant') {
    const st = await db.getDoc('staff/' + email);
    if (!st || st.role !== 'assistant' || st.active === false) return fail(res, 403, 'disabled', 'This admin account is disabled. Contact the main admin.');
  }
  const now = Date.now();
  await db.tx(async c => {
    await c.query('UPDATE credentials SET fails = 0, lock_until = 0, last_login = $2 WHERE email = $1', [email, now]);
    await auth.writeAuthDoc(c, email, cred.role, { lastLogin: now });
  });
  await auth.startSession(res, email);
  broadcast(['staffAuth']);
  res.json({ ok: true });
}));

// First run only: create the main admin. Needs the setup code from the server log (or SETUP_CODE).
app.post('/api/auth/setup', wrap(async (req, res) => {
  await ctxOf(req, res);
  const email = auth.normEmail(req.body.email), pw = String(req.body.password || ''), code = String(req.body.code || '').trim();
  const exists = await db.pool.query(`SELECT 1 FROM credentials WHERE role = 'owner' LIMIT 1`);
  if (exists.rows.length) return fail(res, 409, 'exists', 'The main admin already exists. Log in instead.');
  if (!code || !crypto.timingSafeEqual(Buffer.from(code.padEnd(64)), Buffer.from(setupCode().padEnd(64)))) return fail(res, 403, 'bad_code', 'The setup code is not correct. Find it in the server log or in SETUP_CODE.');
  if (!auth.emailOk(email)) return fail(res, 400, 'invalid', 'Enter a valid email address.');
  const pp = auth.pwProblem(pw); if (pp) return fail(res, 400, 'invalid', pp);
  const now = Date.now();
  await db.tx(async c => {
    await c.query(`INSERT INTO credentials (email, role, hash, created_at, pw_changed_at, last_login) VALUES ($1,'owner',$2,$3,$3,$3)`, [email, auth.hashPassword(pw), now]);
    await auth.writeAuthDoc(c, email, 'owner', { createdAt: now, pwChangedAt: now, lastLogin: now });
  });
  await auth.startSession(res, email);
  res.json({ ok: true });
}));

// An assistant sets their password with the invite code the main admin gave them.
app.post('/api/auth/invite', wrap(async (req, res) => {
  await ctxOf(req, res);
  const email = auth.normEmail(req.body.email), pw = String(req.body.password || '');
  const code = String(req.body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!auth.emailOk(email)) return fail(res, 400, 'invalid', 'Enter a valid email address.');
  const pp = auth.pwProblem(pw); if (pp) return fail(res, 400, 'invalid', pp);
  if (code.length < 12) return fail(res, 400, 'invalid', 'Enter the 12-character invite code.');
  if (limited('invite:' + email, 5, 15 * 60e3)) return fail(res, 429, 'rate_limited', 'Too many attempts. Setup is locked for 15 minutes.');
  const st = await db.getDoc('staff/' + email);
  if (!st || st.role !== 'assistant' || st.active === false || !auth.verifyInvite(code, st.invite))
    return fail(res, 403, 'bad_code', "That email and invite code don't match, or the code was already used.");
  const now = Date.now();
  await db.tx(async c => {
    await c.query(`INSERT INTO credentials (email, role, hash, created_at, pw_changed_at, last_login) VALUES ($1,'assistant',$2,$3,$3,$3)
      ON CONFLICT (email) DO UPDATE SET hash = EXCLUDED.hash, role = 'assistant', pw_changed_at = $3, last_login = $3, fails = 0, lock_until = 0`, [email, auth.hashPassword(pw), now]);
    const cur = await db.getDocForUpdate(c, 'staff/' + email);
    await db.putDoc(c, 'staff/' + email, { ...cur, invite: null, claimedAt: now });
    await auth.writeAuthDoc(c, email, 'assistant', { createdAt: now, pwChangedAt: now, lastLogin: now });
  });
  auth.forgetStaff(email);
  await auth.startSession(res, email);
  broadcast(['staff', 'staffAuth']);
  res.json({ ok: true });
}));

app.post('/api/auth/password', wrap(async (req, res) => {
  const ctx = await ctxOf(req, res);
  if (!ctx.role) return fail(res, 401, 'login', 'Log in first.');
  const cur = String(req.body.current || ''), next = String(req.body.next || '');
  const cred = (await db.pool.query('SELECT * FROM credentials WHERE email = $1', [ctx.email])).rows[0];
  if (!cred || !auth.verifyPassword(cur, cred.hash)) {
    const left = await loginFailed(ctx.email);
    return fail(res, 401, 'bad_login', left ? 'Your current password is incorrect.' : 'Too many failed attempts. Try again in 15 minutes.');
  }
  const pp = auth.pwProblem(next); if (pp) return fail(res, 400, 'invalid', pp);
  if (next === cur) return fail(res, 400, 'invalid', "Choose a password you haven't used here before.");
  const now = Date.now();
  await db.tx(async c => {
    await c.query('UPDATE credentials SET hash = $2, pw_changed_at = $3, fails = 0, lock_until = 0 WHERE email = $1', [ctx.email, auth.hashPassword(next), now]);
    await auth.writeAuthDoc(c, ctx.email, cred.role, { pwChangedAt: now });
  });
  broadcast(['staffAuth']);
  res.json({ ok: true });
}));

app.post('/api/auth/logout', wrap(async (req, res) => { await auth.endSession(req, res); res.json({ ok: true }); }));

// ---------- documents ----------
app.use(['/api/doc', '/api/list'], express.json({ limit: '1mb' }));

app.get('/api/doc', wrap(async (req, res) => {
  const ctx = await ctxOf(req, res), p = String(req.query.path || '');
  if (!db.checkPath(p, 'doc')) return fail(res, 400, 'invalid_argument', 'Bad path.');
  res.set('Cache-Control', 'no-store');
  if (!canRead(p, ctx)) return res.json({ data: null });
  res.json({ data: await db.getDoc(p) });
}));

app.get('/api/list', wrap(async (req, res) => {
  const ctx = await ctxOf(req, res), p = String(req.query.path || '');
  if (!db.checkPath(p, 'coll')) return fail(res, 400, 'invalid_argument', 'Bad path.');
  res.set('Cache-Control', 'no-store');
  // a collection is readable if a document in it would be (rules apply per path prefix)
  if (!canRead(p + '/x', ctx)) return res.json({ docs: [] });
  const docs = await db.listDocs(p, { orderBy: req.query.orderBy, dir: req.query.dir, limit: req.query.limit });
  res.json({ docs: docs.filter(d => canRead(p + '/' + d.id, ctx)) });
}));

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function deepMerge(a, b) {
  const out = { ...a };
  for (const k of Object.keys(b)) {
    if (b[k] && b[k].__delete__ === true) delete out[k];
    else out[k] = isObj(b[k]) && isObj(out[k]) ? deepMerge(out[k], b[k]) : b[k];
  }
  return out;
}
const geoHeader = req => {
  const v = String(req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || req.headers['x-country-code'] || '').toUpperCase();
  return /^[A-Z]{2}$/.test(v) && v !== 'XX' && v !== 'T1' ? v : '';
};

// Business rules that sit on top of the access rules.
async function beforeWrite(c, p, prev, next, ctx, req) {
  const segs = p.split('/');
  const top = segs[0];
  // shoppers' own customer document: orders are re-priced and checked
  if (top === 'customers' && segs.length === 2 && segs[1] === ctx.uid) {
    if (next === null) throw new OrderError('Not allowed.');
    const out = await validateCustomerWrite(ctx.uid, prev, next);
    const had = new Set(((prev && prev.orders) || []).map(o => o.id));
    req.newOrder = (out.orders || []).find(o => !had.has(o.id)) || null;
    return out;
  }
  if (top === 'customers' && segs.length === 4 && segs[1] === ctx.uid && segs[2] === 'receipts') {
    if (next === null) throw new OrderError('Not allowed.');
    const n = await c.query(`SELECT count(*)::int AS n FROM docs WHERE parent = $1`, [`customers/${ctx.uid}/receipts`]);
    if (!prev && n.rows[0].n >= 50) throw new OrderError('Too many receipts.');
    return next;
  }
  // shoppers may only write their customer document, its receipts and their visit record
  if (!ctx.role && ((top === 'customers' && segs[1] === ctx.uid && segs.length > 2 && segs[2] !== 'receipts') || (top === 'visits' && segs.length > 2)))
    throw new OrderError('Not allowed.');
  if (top === 'visits' && segs[1] === ctx.uid) {
    const cc = geoHeader(req);
    if (cc && next && Array.isArray(next.sessions)) next.sessions = next.sessions.map(s => s && !s.ccIp ? { ...s, cc, ccIp: true } : s);
    return next;
  }
  if (top === 'audit') {
    if (prev || next === null) throw new OrderError('The activity log cannot be changed.');
    return { at: Date.now(), email: ctx.email, role: ctx.role, text: String((next && next.text) || '').slice(0, 200) };
  }
  if (top === 'staff' && segs.length === 2) {
    const email = segs[1];
    auth.forgetStaff(email);
    // A new invite code, removal or disabling signs the assistant out and (for new codes / removal) clears their password.
    const newInvite = next && next.invite && next.invite.hash && (!prev || !prev.invite || prev.invite.hash !== next.invite.hash);
    if (next === null || newInvite) {
      await c.query(`DELETE FROM credentials WHERE email = $1 AND role = 'assistant'`, [email]);
      await db.deleteDoc(c, 'staffAuth/' + auth.authKey(email));
    }
    if (next === null || newInvite || next.active === false) await auth.endAllSessions(email, c);
    if (next && next.role !== 'assistant') throw new OrderError('Staff accounts must be assistants.');
    return next;
  }
  return next;
}

async function writeDoc(req, res, mode) {
  const ctx = await ctxOf(req, res), p = String(req.query.path || '');
  if (!db.checkPath(p, 'doc')) return fail(res, 400, 'invalid_argument', 'Bad path.');
  if (!canWrite(p, ctx)) return fail(res, 403, 'invalid_argument', "You don't have permission to change this.");
  if (limited('w:' + ctx.uid, ctx.role ? 600 : 120, 60e3)) return fail(res, 429, 'rate_limited', 'Too many changes. Slow down a little.');
  const body = req.body && req.body.data;
  if (mode !== 'delete' && !isObj(body)) return fail(res, 400, 'invalid_argument', 'Send an object.');
  try {
    await db.tx(async c => {
      const prev = await db.getDocForUpdate(c, p);
      if (mode === 'update' && !prev) throw Object.assign(new Error('Not found'), { http: 404, code: 'invalid_argument' });
      let next = mode === 'delete' ? null : mode === 'update' ? deepMerge(prev, body) : body;
      next = await beforeWrite(c, p, prev, next, ctx, req);
      if (next === null) await db.deleteDoc(c, p); else await db.putDoc(c, p, next);
    });
  } catch (e) {
    if (e instanceof OrderError) return fail(res, 422, e.code, e.message);
    if (e.http) return fail(res, e.http, e.code, e.message);
    throw e;
  }
  broadcast([p]);
  res.json({ ok: true });
  if (req.newOrder) notify.newOrder(req.newOrder); // email the store team (doesn't delay the shopper)
}
// A shopper adds an email after ordering (on the confirmation page) and gets the invoice.
// Only for their own order, at most 3 times per order.
app.post('/api/invoice', express.json({ limit: '4kb' }), wrap(async (req, res) => {
  const ctx = await ctxOf(req, res);
  const id = String((req.body && req.body.id) || ''), email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!/^GB-[A-Z0-9]{4,16}$/.test(id)) return fail(res, 400, 'invalid_argument', 'Bad order number.');
  if (email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail(res, 422, 'invalid_argument', 'Enter a valid email address.');
  if (limited('inv:' + ctx.uid, 5, 3600e3)) return fail(res, 429, 'rate_limited', 'Too many tries. Please wait a little.');
  const p = 'customers/' + ctx.uid;
  let order = null;
  try {
    await db.tx(async c => {
      const doc = await db.getDocForUpdate(c, p);
      const list = doc && Array.isArray(doc.orders) ? doc.orders : [];
      const o = list.find(x => x && x.id === id);
      if (!o) throw Object.assign(new Error('Order not found.'), { http: 404, code: 'invalid_argument' });
      if ((+o.invoiceSends || 0) >= 3) throw Object.assign(new Error('The invoice was already sent several times. Contact us on WhatsApp.'), { http: 429, code: 'rate_limited' });
      o.email = email; o.invoiceSends = (+o.invoiceSends || 0) + 1;
      await db.putDoc(c, p, doc);
      order = o;
    });
  } catch (e) { if (e.http) return fail(res, e.http, e.code, e.message); throw e; }
  broadcast([p]);
  const sent = await notify.sendInvoice(order);
  if (!sent) return fail(res, 503, 'unavailable', 'Email is not available right now.');
  res.json({ ok: true });
}));
app.put('/api/doc', wrap((req, res) => writeDoc(req, res, 'set')));
app.patch('/api/doc', wrap((req, res) => writeDoc(req, res, 'update')));
app.delete('/api/doc', wrap((req, res) => writeDoc(req, res, 'delete')));

// ---------- uploaded files (product photos, homepage video) ----------
const UPLOAD_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm']);
app.post('/api/assets', express.raw({ type: () => true, limit: config.maxUploadMb + 'mb' }), wrap(async (req, res) => {
  const ctx = await ctxOf(req, res);
  const editor = ctx.role === 'owner' || ['products', 'settings'].some(s => (ctx.perms || {})[s] === 'edit');
  if (!editor) return fail(res, 403, 'not_granted', 'Only the store team can upload files.');
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!UPLOAD_TYPES.has(type)) return fail(res, 415, 'unsupported_type', 'Upload a JPG, PNG, WebP, GIF, MP4 or WebM file.');
  if (!Buffer.isBuffer(req.body) || !req.body.length) return fail(res, 400, 'invalid_request', 'The file is empty.');
  const id = crypto.randomBytes(16).toString('hex');
  await db.pool.query('INSERT INTO assets (id, mime, size, data) VALUES ($1,$2,$3,$4)', [id, type, req.body.length, req.body]);
  res.json({ id, url: '/_blob/' + id, sizeBytes: req.body.length, contentType: type });
}));
app.delete('/api/assets/:id', wrap(async (req, res) => {
  const ctx = await ctxOf(req, res);
  if (!ctx.role) return fail(res, 403, 'not_granted', 'Not allowed.');
  const r = await db.pool.query('DELETE FROM assets WHERE id = $1', [req.params.id]);
  res.json({ deleted: r.rowCount > 0 });
}));
app.get('/_blob/:id', wrap(async (req, res) => {
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(req.params.id)) return res.sendStatus(404);
  const r = await db.pool.query('SELECT mime, size, data FROM assets WHERE id = $1', [req.params.id]);
  const a = r.rows[0]; if (!a) return res.sendStatus(404);
  res.set({ 'Content-Type': a.mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'Accept-Ranges': 'bytes' });
  // videos need byte ranges for Safari
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    const size = a.data.length, start = range[1] ? +range[1] : size - +range[2], end = range[1] && range[2] ? Math.min(+range[2], size - 1) : size - 1;
    if (start >= size || start < 0) return res.status(416).set('Content-Range', `bytes */${size}`).end();
    res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return res.end(a.data.subarray(start, end + 1));
  }
  res.end(a.data);
}));

// ---------- the storefront ----------
const PUBLIC = path.join(__dirname, '..', 'public');
app.get('/healthz', wrap(async (req, res) => { await db.pool.query('SELECT 1'); res.json({ ok: true }); }));
app.use(express.static(PUBLIC, { index: false, maxAge: '1h' }));
const indexHtml = () => fs.readFileSync(path.join(PUBLIC, 'index.html'));
app.get(['/', '/index.html'], wrap(async (req, res) => {
  await ctxOf(req, res); // make sure the visitor id cookie exists before the page loads
  res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(indexHtml());
}));
app.use('/api', (req, res) => fail(res, 404, 'not_found', 'Not found.'));
app.use((req, res) => res.redirect('/'));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return fail(res, 413, err.status === 413 && req.path.startsWith('/api/assets') ? 'too_large' : 'quota_exceeded', 'That is too large.');
  console.error(err);
  fail(res, 500, 'unavailable', 'Something went wrong on the server. Try again.');
});

(async () => {
  await db.migrate();
  await seedIfEmpty();
  await ensureOwnerFromEnv();
  setInterval(() => db.pool.query('DELETE FROM sessions WHERE expires_at < $1 OR last_seen < $2', [Date.now(), Date.now() - auth.IDLE_MS]).catch(() => {}), 600e3).unref();
  app.listen(config.port, () => console.log(`giftbox377 is running on port ${config.port}`));
})().catch(e => { console.error(e); process.exit(1); });
