// Connects the storefront to this server. It provides the same small API the page was
// written against (window.claude.use("db" | "user" | "assets")), backed by /api/*.
(() => {
  'use strict';
  const enc = encodeURIComponent;
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');

  async function api(method, url, body) {
    const opt = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    let r;
    try { r = await fetch(url, opt); } catch (e) { throw { code: 'unavailable', message: 'Network error' }; }
    if (!r.ok) {
      let e = {}; try { e = await r.json(); } catch (_) {}
      throw { code: e.code || (r.status === 403 ? 'invalid_argument' : r.status === 413 ? 'quota_exceeded' : 'unavailable'), message: e.message || r.statusText, status: r.status };
    }
    return r.status === 204 ? null : r.json();
  }

  // ---- live updates ----
  const subs = new Set();
  const pending = new Set();
  let timer = null;
  function refresh(tops) {
    tops.forEach(t => pending.add(t));
    clearTimeout(timer);
    timer = setTimeout(() => { const ts = new Set(pending); pending.clear(); subs.forEach(s => { if (ts.has(s.top)) s.run(); }); }, 120);
  }
  function connect() {
    if (!window.EventSource) return;
    const es = new EventSource('/api/events');
    es.onmessage = e => { try { refresh(JSON.parse(e.data).tops || []); } catch (_) {} };
    // the browser reconnects on its own; after a reconnect re-read everything once
    es.onopen = () => { if (connect.seen) refresh([...new Set([...subs].map(s => s.top))]); connect.seen = true; };
  }
  connect();
  addEventListener('online', () => refresh([...new Set([...subs].map(s => s.top))]));

  const meta = { fromCache: false, hasPendingWrites: false };
  const snapDoc = (path, data) => ({ id: path.split('/').pop(), exists: data != null, data: () => clone(data == null ? undefined : data), metadata: meta });

  function subscribe(path, fetcher, next, error) {
    let last = null, alive = true;
    const s = {
      top: path.split('/')[0],
      run: async () => {
        try {
          const r = await fetcher();
          const key = JSON.stringify(r.raw);
          if (!alive || key === last) return;
          last = key; next(r.snap);
        } catch (e) { if (alive && error) error(e); }
      },
    };
    subs.add(s); s.run();
    return () => { alive = false; subs.delete(s); };
  }

  function doc(path) {
    const fetchDoc = async () => { const r = await api('GET', '/api/doc?path=' + enc(path)); return { raw: r.data, snap: snapDoc(path, r.data) }; };
    const write = async (method, data) => { await api(method, '/api/doc?path=' + enc(path), data === undefined ? undefined : { data }); refresh([path.split('/')[0]]); };
    return {
      path, id: path.split('/').pop(),
      collection: sub => coll(path + '/' + sub),
      get: async () => (await fetchDoc()).snap,
      set: data => write('PUT', data),
      update: data => write('PATCH', data),
      delete: () => write('DELETE'),
      onSnapshot: (next, error) => subscribe(path, fetchDoc, next, error),
    };
  }
  function query(path, orderBy, limit) {
    const fetchList = async () => {
      let url = '/api/list?path=' + enc(path);
      if (orderBy) url += '&orderBy=' + enc(orderBy[0]) + '&dir=' + enc(orderBy[1]);
      if (limit) url += '&limit=' + enc(limit);
      const r = await api('GET', url);
      const docs = r.docs.map(d => snapDoc(path + '/' + d.id, d.data));
      return { raw: r.docs, snap: { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: meta } };
    };
    return {
      orderBy: (f, dir) => query(path, [f, dir || 'asc'], limit),
      limit: n => query(path, orderBy, n),
      get: async () => (await fetchList()).snap,
      onSnapshot: (next, error) => subscribe(path, fetchList, next, error),
    };
  }
  function coll(path) {
    return Object.assign(query(path), {
      path,
      doc: id => doc(path + '/' + (id || rid())),
      add: async data => { const d = doc(path + '/' + rid()); await d.set(data); return d; },
    });
  }
  const db = { doc, collection: coll };

  // ---- who is this ----
  let mePromise = api('GET', '/api/me').catch(() => ({ uid: null, session: null, ownerExists: true }));
  const user = {
    id: async () => (await mePromise).uid,
    canEdit: async () => !!(await mePromise).session,
    isOwner: async () => ((await mePromise).session || {}).role === 'owner',
    me: async () => ({ id: (await mePromise).uid }),
  };

  // ---- uploads (store team only) ----
  const assets = {
    upload: async (blob, options = {}) => {
      const type = options.type || blob.type || 'application/octet-stream';
      let r;
      try { r = await fetch('/api/assets', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': type }, body: blob }); }
      catch (e) { throw { code: 'store_unavailable', message: 'Network error' }; }
      if (!r.ok) { let e = {}; try { e = await r.json(); } catch (_) {} throw { code: e.code || (r.status === 413 ? 'too_large' : 'upstream_error'), message: e.message || '' }; }
      return r.json();
    },
    delete: async ref => api('DELETE', '/api/assets/' + enc(String(ref).split('/').pop())),
    list: async () => ({ assets: [], usage: { files: 0, bytes: 0, maxFiles: 0, maxBytes: 0 } }),
  };

  window.GB_SERVER = { api, me: () => mePromise, refreshMe: () => (mePromise = api('GET', '/api/me')) };
  window.claude = {
    use: async name => {
      if (name === 'db') return db;
      if (name === 'user') return user;
      if (name === 'assets') return (await mePromise).session ? assets : null;
      return null;
    },
  };
})();
