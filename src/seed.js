'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');

const SEED_DIR = path.join(__dirname, '..', 'seed');

// On the very first start, load the catalogue (categories, products, discount codes,
// settings and product photos) exported from the original store.
async function seedIfEmpty() {
  const r = await db.pool.query('SELECT count(*)::int AS n FROM docs');
  if (r.rows[0].n > 0) return;
  const file = path.join(SEED_DIR, 'seed.json');
  if (!fs.existsSync(file)) return;
  const seed = JSON.parse(fs.readFileSync(file, 'utf8'));
  await db.tx(async c => {
    for (const [p, data] of Object.entries(seed.docs || {})) await db.putDoc(c, p, data);
    for (const [id, a] of Object.entries(seed.assets || {})) {
      const f = path.join(SEED_DIR, 'assets', a.file);
      if (!fs.existsSync(f)) continue;
      const buf = fs.readFileSync(f);
      await c.query('INSERT INTO assets (id, mime, size, data) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING', [id, a.mime, buf.length, buf]);
    }
  });
  console.log(`Loaded the starting catalogue: ${Object.keys(seed.docs || {}).length} documents, ${Object.keys(seed.assets || {}).length} photos.`);
}

let generatedCode = '';
const setupCode = () => config.setupCode || generatedCode;

// The main admin can be created from OWNER_EMAIL / OWNER_PASSWORD, or once in the browser
// with a setup code (SETUP_CODE, or a random one printed here).
async function ensureOwnerFromEnv() {
  const r = await db.pool.query(`SELECT 1 FROM credentials WHERE role = 'owner' LIMIT 1`);
  if (r.rows.length) return;
  if (config.ownerEmail && config.ownerPassword) {
    const pp = auth.pwProblem(config.ownerPassword);
    if (!auth.emailOk(config.ownerEmail) || pp) { console.error(`OWNER_EMAIL / OWNER_PASSWORD not accepted: ${pp || 'invalid email'}`); }
    else {
      const now = Date.now();
      await db.tx(async c => {
        await c.query(`INSERT INTO credentials (email, role, hash, created_at, pw_changed_at) VALUES ($1,'owner',$2,$3,$3)`, [config.ownerEmail, auth.hashPassword(config.ownerPassword), now]);
        await auth.writeAuthDoc(c, config.ownerEmail, 'owner', { createdAt: now, pwChangedAt: now });
      });
      console.log(`Main admin created for ${config.ownerEmail}. You can remove OWNER_PASSWORD from the environment now.`);
      return;
    }
  }
  if (!config.setupCode) {
    generatedCode = crypto.randomBytes(6).toString('hex').toUpperCase();
    console.log('------------------------------------------------------------');
    console.log(' No main admin yet. Open /#admin and use this setup code:');
    console.log(`   ${generatedCode}`);
    console.log('------------------------------------------------------------');
  }
}

module.exports = { seedIfEmpty, ensureOwnerFromEnv, setupCode };
