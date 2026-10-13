#!/usr/bin/env node
'use strict';
// Set (or reset) the main admin's email and password from the server.
//   node scripts/reset-owner.js owner@example.com "NewPassword2026"
// With Docker:  docker compose exec app node scripts/reset-owner.js owner@example.com "NewPassword2026"
const db = require('../src/db');
const auth = require('../src/auth');

(async () => {
  const [emailArg, pw] = process.argv.slice(2);
  const email = auth.normEmail(emailArg);
  if (!auth.emailOk(email) || !pw) { console.error('Usage: node scripts/reset-owner.js <email> <new password>'); process.exit(1); }
  const pp = auth.pwProblem(pw); if (pp) { console.error(pp); process.exit(1); }
  await db.migrate();
  const now = Date.now();
  await db.tx(async c => {
    const old = await c.query(`SELECT email FROM credentials WHERE role = 'owner'`);
    for (const row of old.rows) {
      await c.query('DELETE FROM sessions WHERE email = $1', [row.email]);
      await c.query('DELETE FROM credentials WHERE email = $1', [row.email]);
      await db.deleteDoc(c, 'staffAuth/' + auth.authKey(row.email));
    }
    await c.query(`DELETE FROM credentials WHERE email = $1`, [email]);
    await c.query(`INSERT INTO credentials (email, role, hash, created_at, pw_changed_at) VALUES ($1,'owner',$2,$3,$3)`, [email, auth.hashPassword(pw), now]);
    await auth.writeAuthDoc(c, email, 'owner', { createdAt: now, pwChangedAt: now });
  });
  console.log(`Main admin is now ${email}. Every old admin session was signed out.`);
  await db.pool.end();
})().catch(e => { console.error(e); process.exit(1); });
