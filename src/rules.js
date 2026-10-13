'use strict';
// Who may read and write which documents. Levels, lowest to highest:
//   view     anyone
//   interact any visitor (every browser gets its own visitor id)
//   admin    a logged-in assistant
//   owner    the logged-in main admin
//   none     nobody (only the server itself writes there)
// {self} matches the visitor's own id; {me} matches the logged-in staff member's auth key.
// The most specific matching rule wins.
const LV = { view: 0, interact: 1, admin: 2, owner: 3, none: 9 };

const RULES = [
  { path: '', read: 'view', write: 'admin' },
  { path: 'customers', read: 'admin', write: 'admin' },
  { path: 'customers/{self}', read: 'interact', write: 'interact' },
  { path: 'customerAdmin', read: 'admin', write: 'admin' },
  { path: 'staff', read: 'admin', write: 'owner' },
  { path: 'staffAuth', read: 'owner', write: 'none' },
  { path: 'staffAuth/{me}', read: 'admin', write: 'none' },
  { path: 'audit', read: 'owner', write: 'admin' },
  { path: 'visits', read: 'admin', write: 'none' },
  { path: 'visits/{self}', read: 'interact', write: 'interact' },
];

// Assistants are limited further by the sections the main admin gave them.
// Reading these collections needs at least "view" on one of the listed sections;
// writing a collection needs "edit" on one of its listed sections.
const READ_SECTIONS = {
  customers: ['orders', 'customers', 'overview', 'visitors'],
  customerAdmin: ['customers', 'orders'],
  visits: ['visitors'],
};
const WRITE_SECTIONS = {
  products: ['products', 'discounts', 'orders'], // sales change prices, confirmed orders change stock
  categories: ['categories'],
  sections: ['categories'],
  promos: ['discounts'],
  status: ['orders'],
  customers: ['orders', 'customers'],
  customerAdmin: ['customers'],
  shop: ['settings'],
  audit: '*',
};

function matchRule(path, ctx) {
  const segs = path ? path.split('/') : [];
  let best = RULES[0], bestLen = 0;
  for (const r of RULES) {
    const rs = r.path ? r.path.split('/') : [];
    if (rs.length > segs.length) continue;
    let ok = true;
    for (let i = 0; i < rs.length; i++) {
      const s = rs[i];
      if (s === '{self}') { if (!ctx.uid || segs[i] !== ctx.uid) { ok = false; break; } }
      else if (s === '{me}') { if (!ctx.authKey || segs[i] !== ctx.authKey) { ok = false; break; } }
      else if (s !== segs[i]) { ok = false; break; }
    }
    if (ok && rs.length >= bestLen) { best = r; bestLen = rs.length; }
  }
  return best;
}

const hasPerm = (ctx, sections, min) => sections === '*' ||
  (sections || []).some(s => (min === 'edit' ? ['edit'] : ['view', 'edit']).includes((ctx.perms || {})[s]));

function canRead(path, ctx) {
  const rule = matchRule(path, ctx);
  if (LV[rule.read] > ctx.level) return false;
  if (ctx.role === 'assistant' && !/\{(self|me)\}/.test(rule.path)) {
    const top = path.split('/')[0];
    if (READ_SECTIONS[top] && !hasPerm(ctx, READ_SECTIONS[top], 'view')) return false;
  }
  return true;
}

function canWrite(path, ctx) {
  const rule = matchRule(path, ctx);
  if (LV[rule.write] > ctx.level) return false;
  if (ctx.role === 'assistant' && !/\{(self|me)\}/.test(rule.path)) {
    const top = path.split('/')[0];
    if (!WRITE_SECTIONS[top] || !hasPerm(ctx, WRITE_SECTIONS[top], 'edit')) return false;
  }
  return true;
}

module.exports = { LV, RULES, matchRule, canRead, canWrite };
