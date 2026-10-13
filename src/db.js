'use strict';
// PostgreSQL access: a small document store (one row per document), uploaded files,
// staff passwords and admin sessions.
const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  path       TEXT PRIMARY KEY,
  parent     TEXT NOT NULL,
  data       JSONB NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS docs_parent_idx ON docs (parent);

CREATE TABLE IF NOT EXISTS assets (
  id         TEXT PRIMARY KEY,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  data       BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credentials (
  email         TEXT PRIMARY KEY,
  role          TEXT NOT NULL CHECK (role IN ('owner','assistant')),
  hash          TEXT NOT NULL,
  created_at    BIGINT NOT NULL,
  pw_changed_at BIGINT NOT NULL,
  last_login    BIGINT,
  fails         INTEGER NOT NULL DEFAULT 0,
  lock_until    BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  last_seen  BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_email_idx ON sessions (email);
`;

async function migrate() { await pool.query(SCHEMA); }

const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
function checkPath(path, kind) {
  if (typeof path !== 'string' || !path || path.length > 1000) return false;
  const segs = path.split('/');
  if (segs.length > 16 || segs.some(s => !SEG.test(s) || s === '.' || s === '..')) return false;
  return kind === 'doc' ? segs.length % 2 === 0 : segs.length % 2 === 1;
}
const parentOf = path => path.split('/').slice(0, -1).join('/');

async function getDoc(path, client = pool) {
  const r = await client.query('SELECT data FROM docs WHERE path = $1', [path]);
  return r.rows[0] ? r.rows[0].data : null;
}
async function getDocForUpdate(client, path) {
  const r = await client.query('SELECT data FROM docs WHERE path = $1 FOR UPDATE', [path]);
  return r.rows[0] ? r.rows[0].data : null;
}
async function putDoc(client, path, data) {
  await client.query(
    `INSERT INTO docs (path, parent, data) VALUES ($1, $2, $3)
     ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, version = docs.version + 1, updated_at = now()`,
    [path, parentOf(path), JSON.stringify(data)]);
}
async function deleteDoc(client, path) { await client.query('DELETE FROM docs WHERE path = $1', [path]); }

async function listDocs(parent, { orderBy, dir, limit } = {}) {
  const params = [parent];
  let sql = 'SELECT path, data FROM docs WHERE parent = $1';
  if (orderBy && /^[A-Za-z0-9_]{1,40}$/.test(orderBy)) {
    params.push(orderBy);
    sql += ` ORDER BY data -> $2 ${dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, path`;
  } else sql += ' ORDER BY path';
  const n = Math.min(Math.max(parseInt(limit, 10) || 1000, 1), 5000);
  params.push(n); sql += ` LIMIT $${params.length}`;
  const r = await pool.query(sql, params);
  return r.rows.map(row => ({ id: row.path.split('/').pop(), data: row.data }));
}

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally { client.release(); }
}

module.exports = { pool, migrate, checkPath, parentOf, getDoc, getDocForUpdate, putDoc, deleteDoc, listDocs, tx };
