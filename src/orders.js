'use strict';
// Server-side checks for what shoppers write to their own customer document.
// The storefront calculates prices in the browser; here every new order is recalculated
// from the database so nobody can change a price, a discount or a delivery fee.
const db = require('./db');

class OrderError extends Error { constructor(msg, code = 'order_rejected') { super(msg); this.code = code; } }

const r2 = n => Math.round((+n || 0) * 100) / 100;
const near = (a, b) => Math.abs(r2(a) - r2(b)) < 0.011;
const priceOf = p => (+p.salePrice > 0 && +p.salePrice < +p.price) ? +p.salePrice : +p.price;
const sizesOf = p => Array.isArray(p.sizes) && p.sizes.length ? p.sizes.map(String) : ['One size'];
const colorsOf = p => Array.isArray(p.colors) && p.colors.length ? p.colors : [{ name: 'Default', hex: '#9A93A6' }];
const stockOf = (p, size) => Math.max(0, Math.floor(+((p.stock || {})[size]) || 0));
// Women and Men exist by default; the admin can hide or remove them and add more (sections collection).
async function activeSections() {
  const m = new Map([['women', { active: true }], ['men', { active: true }]]);
  for (const d of await db.listDocs('sections')) m.set(d.id, { ...(m.get(d.id) || {}), ...d.data });
  return [...m.entries()].filter(([, x]) => !x.deleted && x.active !== false).map(([id]) => id);
}
const JO_CITIES = ['Amman', 'Zarqa', 'Irbid', 'Aqaba', 'Salt', 'Madaba', 'Jerash', 'Ajloun', 'Karak', 'Mafraq', "Ma'an", 'Tafilah'];
const str = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const SETTINGS_DEFAULT = { currency: 'JOD', freeShip: 50, shipFee: 3, wrapFee: 2, codEnabled: true, cardEnabled: false, cliqEnabled: true, cliqAlias: 'GIFTBOX' };

// Fields a shopper may still change on an order after placing it (CliQ receipt re-upload).
const MUTABLE_ORDER_FIELDS = new Set(['receipt', 'resubmittedAt']);
const canon = v => Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
const stable = v => JSON.stringify(canon(v));

async function validateCustomerWrite(uid, prev, next) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) throw new OrderError('Invalid data.');
  const before = Array.isArray(prev && prev.orders) ? prev.orders : [];
  const after = Array.isArray(next.orders) ? next.orders : [];
  if (next.orders !== undefined && !Array.isArray(next.orders)) throw new OrderError('Invalid orders.');
  const byId = new Map(before.map(o => [o.id, o]));
  // existing orders must stay, unchanged apart from the receipt fields
  for (const o of before) {
    const n = after.find(x => x && x.id === o.id);
    if (!n) throw new OrderError('Orders cannot be removed.');
    const strip = x => Object.fromEntries(Object.entries(x).filter(([k]) => !MUTABLE_ORDER_FIELDS.has(k)));
    if (stable(strip(o)) !== stable(strip(n))) throw new OrderError('Placed orders cannot be changed.');
  }
  const fresh = after.filter(o => !byId.has(o && o.id));
  if (!fresh.length) return next;
  if (fresh.length > 1) throw new OrderError('One order at a time.');
  if (after.length > 300) throw new OrderError('Too many orders on this account.');
  const recent = before.filter(o => Date.now() - (+o.at || 0) < 3600e3).length;
  if (recent >= 10) throw new OrderError('Too many orders in the last hour. Please contact us on WhatsApp.', 'rate_limited');
  const order = await validateNewOrder(fresh[0]);
  next.orders = after.map(o => (o === fresh[0] ? order : o));
  return next;
}

async function validateNewOrder(o) {
  if (!o || typeof o !== 'object') throw new OrderError('Invalid order.');
  if (typeof o.id !== 'string' || !/^GB-[A-Z0-9]{4,16}$/.test(o.id)) throw new OrderError('Invalid order number.');
  const dupe = await db.pool.query(`SELECT 1 FROM docs WHERE parent = 'customers' AND data->'orders' @> $1::jsonb LIMIT 1`, [JSON.stringify([{ id: o.id }])]);
  if (dupe.rows.length) throw new OrderError('Duplicate order number. Please try again.', 'unavailable');

  const settings = { ...SETTINGS_DEFAULT, ...((await db.getDoc('shop/settings')) || {}) };
  const enabled = { cod: settings.codEnabled !== false, cliq: !!settings.cliqEnabled, card: false };
  // Card payments need a real payment gateway; the storefront only simulates one, so the server refuses them.
  if (!enabled[o.payment]) throw new OrderError('This payment method is not available.');

  if (!Array.isArray(o.items) || !o.items.length || o.items.length > 50) throw new OrderError('Your bag is empty.');
  const products = new Map((await db.listDocs('products')).map(d => [d.id, d.data]));
  const cats = new Map((await db.listDocs('categories')).map(d => [d.id, d.data]));
  const SECTIONS = await activeSections();
  let sub = 0;
  const items = o.items.map(it => {
    const p = it && products.get(it.pid);
    const c = p && cats.get(p.cat);
    if (!p || p.active === false || !c || c.active === false || !SECTIONS.includes(c.section)) throw new OrderError('A product in your bag is no longer available.');
    const qty = Math.floor(+it.qty);
    if (!(qty >= 1 && qty <= 20)) throw new OrderError('Invalid quantity.');
    const size = String(it.size);
    if (!sizesOf(p).includes(size)) throw new OrderError('Invalid size.');
    if (qty > stockOf(p, size)) throw new OrderError(`Only ${stockOf(p, size)} left of ${p.name} in size ${size}.`, 'out_of_stock');
    const color = colorsOf(p).find(x => x.name === it.color);
    if (!color) throw new OrderError('Invalid colour.');
    const price = priceOf(p);
    if (!near(+it.price, price)) throw new OrderError('Prices have changed. Please reload the page.', 'price_changed');
    sub += price * qty;
    return {
      pid: it.pid, name: p.name, nameAr: p.nameAr || '', color: color.name, colorAr: color.nameAr || '', size, qty, price,
      image: Array.isArray(p.images) && p.images[0] ? p.images[0] : '', art: p.art || 'giftbox', hex: color.hex || '#9A93A6',
    };
  });
  sub = r2(sub);
  let discount = 0, promo = '';
  if (o.promo) {
    const code = String(o.promo).toUpperCase();
    const pr = (await db.listDocs('promos')).map(d => d.data).find(x => String(x.code).toUpperCase() === code && x.active !== false);
    if (!pr || (+pr.minSubtotal && sub < +pr.minSubtotal)) throw new OrderError('That discount code is not valid.', 'price_changed');
    discount = r2(pr.type === 'amount' ? Math.min(sub, +pr.value) : sub * Math.min(100, +pr.value) / 100);
    promo = code;
  }
  const afterDisc = sub - discount;
  const ship = afterDisc >= +settings.freeShip ? 0 : +settings.shipFee || 0;
  const wrap = +o.wrap > 0 ? +settings.wrapFee || 0 : 0;
  const total = r2(afterDisc + ship + wrap);
  if (!near(o.subtotal, sub) || !near(o.discount || 0, discount) || !near(o.ship, ship) || !near(o.wrap || 0, wrap) || !near(o.total, total))
    throw new OrderError('Prices have changed. Please reload the page.', 'price_changed');

  if (!str(o.name, 80) || o.name.trim().length < 2) throw new OrderError('Enter your full name.');
  if (typeof o.phone !== 'string' || !/^\+962 7[789] \d{3} \d{4}$/.test(o.phone)) throw new OrderError('Enter a valid Jordanian mobile number.');
  if (!JO_CITIES.includes(o.city)) throw new OrderError('Choose your city.');
  if (!str(o.district, 80) || !str(o.address, 300)) throw new OrderError('Enter your full address.');

  return {
    id: o.id, at: Date.now(), currency: settings.currency || 'JOD', receipt: o.payment === 'cliq' && !!o.receipt, lang: o.lang === 'ar' ? 'ar' : 'en',
    items, subtotal: sub, discount, promo, ship, wrap, note: wrap ? String(o.note || '').slice(0, 200) : '', total,
    payment: o.payment, card: null, cliqAlias: o.payment === 'cliq' ? (settings.cliqAlias || 'GIFTBOX') : '',
    name: o.name.trim().replace(/\s+/g, ' '), phone: o.phone, city: o.city, district: o.district.trim(), address: o.address.trim(),
    deliveryNotes: String(o.deliveryNotes || '').slice(0, 300),
  };
}

module.exports = { validateCustomerWrite, OrderError };
