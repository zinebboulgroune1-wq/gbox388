'use strict';
// On every new order:
//   1) the store team gets an email: the main admin, every active assistant who can see orders,
//      and any extra addresses in NOTIFY_EMAIL;
//   2) the customer gets an invoice, if they typed an email at checkout.
// Two ways to send, checked in this order:
//   RESEND_API_KEY  -> Resend's HTTPS API (works on Railway, which blocks SMTP ports)
//   SMTP_HOST ...   -> any SMTP server, e.g. Gmail with an App password (fine on a VPS)
// Without either, nothing is sent and the store works as normal.
const nodemailer = require('nodemailer');
const db = require('./db');

const env = process.env;
const extra = String(env.NOTIFY_EMAIL || '').split(',').map(s => s.trim()).filter(Boolean);
const siteUrl = String(env.SITE_URL || '').replace(/\/+$/, '');
const RESEND_KEY = String(env.RESEND_API_KEY || '').trim();
const RESEND_URL = env.RESEND_API_URL || 'https://api.resend.com/emails';
const FROM = env.MAIL_FROM || (RESEND_KEY ? 'giftbox377 <orders@gbox377.com>' : env.SMTP_USER);
const list = v => [].concat(v || []).flatMap(x => String(x).split(',')).map(x => x.trim()).filter(Boolean);

let transport = null;
if (RESEND_KEY) {
  transport = {
    async sendMail(m) {
      const body = { from: m.from, to: list(m.to), subject: m.subject, html: m.html, text: m.text };
      if (m.bcc) body.bcc = list(m.bcc);
      if (m.replyTo) body.reply_to = m.replyTo;
      const r = await fetch(RESEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 300)}`);
      return r.json();
    },
  };
  console.log(`Order emails: sending through Resend as ${FROM}.`);
} else if (env.SMTP_HOST) {
  const port = parseInt(env.SMTP_PORT, 10) || 465;
  transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS || '' } : undefined,
  });
  console.log(`Order emails: sending through ${env.SMTP_HOST}.`);
} else {
  console.log('Order emails are off: set RESEND_API_KEY (or SMTP_HOST, SMTP_USER and SMTP_PASS) to turn them on.');
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, cur) => `${(+n || 0).toFixed(2)} ${cur || 'JOD'}`;
const CITY_AR = { Amman: 'عمّان', Zarqa: 'الزرقاء', Irbid: 'إربد', Aqaba: 'العقبة', Salt: 'السلط', Madaba: 'مادبا', Jerash: 'جرش', Ajloun: 'عجلون', Karak: 'الكرك', Mafraq: 'المفرق', "Ma'an": 'معان', Tafilah: 'الطفيلة' };
const city = c => CITY_AR[c] || c;
const PAY = { cod: 'الدفع عند الاستلام · Cash on delivery', cliq: 'كليك · CliQ (راجع الإيصال في لوحة التحكم)', card: 'بطاقة · Card' };
const timeAmman = ts => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Amman', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ts));

function orderEmail(o) {
  const cur = o.currency || 'JOD';
  const wa = 'https://wa.me/' + String(o.phone || '').replace(/\D/g, '');
  const rows = (o.items || []).map(it => `
    <tr><td style="padding:8px 0;border-bottom:1px solid #eee">${esc(it.nameAr || it.name)}<div style="color:#777;font-size:13px">${esc(it.name)} · ${esc(it.color)}${it.size && it.size !== 'One size' ? ' · ' + esc(it.size) : ''}</div></td>
    <td style="padding:8px;border-bottom:1px solid #eee;text-align:center">${it.qty}</td>
    <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:left;white-space:nowrap">${money(it.price * it.qty, cur)}</td></tr>`).join('');
  const line = (k, v) => `<tr><td style="padding:3px 0;color:#666">${k}</td><td style="padding:3px 0;text-align:left">${v}</td></tr>`;
  const html = `<!doctype html><html dir="rtl" lang="ar"><body style="margin:0;background:#f4f2f5;font-family:Tahoma,Arial,sans-serif;color:#17141d">
  <div style="max-width:560px;margin:0 auto;padding:20px">
   <div style="background:#0d0b0f;color:#fff;border-radius:14px 14px 0 0;padding:18px 22px">
     <div style="color:#ff8fb5;font-size:13px">giftbox377</div>
     <div style="font-size:22px;font-weight:bold;margin-top:4px">طلب جديد ${esc(o.id)}</div>
     <div style="color:#ccc;font-size:13px;margin-top:4px">${esc(timeAmman(o.at))} · ${money(o.total, cur)}</div>
   </div>
   <div style="background:#fff;border-radius:0 0 14px 14px;padding:22px">
     <h3 style="margin:0 0 8px;font-size:16px">الزبون</h3>
     <table style="width:100%;border-collapse:collapse;font-size:14px">
       ${line('الاسم', esc(o.name))}
       ${line('الموبايل', `<a href="tel:${esc(String(o.phone).replace(/\s/g, ''))}" dir="ltr">${esc(o.phone)}</a> · <a href="${wa}">واتساب</a>`)}
       ${line('العنوان', `${esc(o.address)}<br>${esc(o.district)}، ${esc(city(o.city))}`)}
       ${o.deliveryNotes ? line('ملاحظات التوصيل', esc(o.deliveryNotes)) : ''}
       ${o.email ? line('الإيميل', `<a href="mailto:${esc(o.email)}" dir="ltr">${esc(o.email)}</a> · أُرسلت له الفاتورة`) : ''}
       ${line('الدفع', esc(PAY[o.payment] || o.payment))}
     </table>
     <h3 style="margin:18px 0 6px;font-size:16px">المنتجات</h3>
     <table style="width:100%;border-collapse:collapse;font-size:14px">
       <tr style="color:#777;font-size:12px"><td>المنتج</td><td style="text-align:center">الكمية</td><td style="text-align:left">المبلغ</td></tr>${rows}
     </table>
     <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:10px">
       ${line('المجموع', money(o.subtotal, cur))}
       ${o.discount ? line(`خصم ${esc(o.promo)}`, '−' + money(o.discount, cur)) : ''}
       ${line('التوصيل', o.ship ? money(o.ship, cur) : 'مجاني')}
       ${o.wrap ? line('تغليف هدية', money(o.wrap, cur)) : ''}
       <tr><td style="padding:8px 0;font-weight:bold;font-size:16px">الإجمالي</td><td style="padding:8px 0;text-align:left;font-weight:bold;font-size:16px">${money(o.total, cur)}</td></tr>
     </table>
     ${o.wrap && o.note ? `<p style="background:#fbeef3;border-radius:10px;padding:10px 12px;font-size:14px;margin:10px 0 0">بطاقة الهدية: ${esc(o.note)}</p>` : ''}
     ${siteUrl ? `<p style="margin:20px 0 0"><a href="${esc(siteUrl)}/#admin" style="display:inline-block;background:#ae2a4f;color:#fff;text-decoration:none;padding:12px 20px;border-radius:999px;font-weight:bold">افتح لوحة التحكم</a></p>` : ''}
   </div>
   <p style="color:#999;font-size:12px;text-align:center">وصلك هذا الإيميل لأنك من فريق giftbox377 (المدير، أو مساعد له صلاحية الطلبات).</p>
  </div></body></html>`;
  const text = [
    `طلب جديد ${o.id} · New order`,
    `${timeAmman(o.at)} · ${money(o.total, cur)}`,
    '',
    `الاسم: ${o.name}`, `الموبايل: ${o.phone}`, `العنوان: ${o.address}، ${o.district}، ${city(o.city)}`,
    o.deliveryNotes ? `ملاحظات: ${o.deliveryNotes}` : '',
    o.email ? `الإيميل: ${o.email}` : '',
    `الدفع: ${PAY[o.payment] || o.payment}`,
    '',
    ...(o.items || []).map(it => `- ${it.qty} × ${it.name} (${it.color}${it.size && it.size !== 'One size' ? ', ' + it.size : ''}) = ${money(it.price * it.qty, cur)}`),
    '',
    `الإجمالي: ${money(o.total, cur)}`,
    siteUrl ? `لوحة التحكم: ${siteUrl}/#admin` : '',
  ].filter(x => x !== '').join('\n');
  return { subject: `🛍️ طلب جديد ${o.id} · ${money(o.total, cur)} · ${o.name}`, html, text };
}

// ---------- customer invoice ----------
const SHOP = { wa: '962790179582', waShow: '079 017 9582', mail: 'gbox41409@gmail.com', web: 'gbox377.com' };
const T = {
  ar: {
    dir: 'rtl', subject: (o, m) => `فاتورة طلبك ${o.id} · giftbox377`, inv: 'فاتورة', hi: n => `شكراً لك ${n}!`,
    got: 'وصلنا طلبك وبدأنا تجهيزه. هذه فاتورتك وتفاصيل الطلب.', no: 'رقم الطلب', date: 'التاريخ', item: 'المنتج', qty: 'الكمية', amt: 'المبلغ',
    sub: 'المجموع', disc: c => `خصم ${c}`, ship: 'التوصيل', free: 'مجاني', wrap: 'كرت الهدايا', total: 'الإجمالي', pay: 'طريقة الدفع',
    payN: { cod: 'الدفع عند الاستلام', cliq: 'كليك (CliQ)', card: 'بطاقة' }, cliqNote: 'سنؤكد طلبك بعد مراجعة إيصال كليك.',
    to: 'التوصيل إلى', when: 'موعد التوصيل', whenV: 'من 1 إلى 5 أيام عمل', inspect: 'يوجد معاينة عند الاستلام.', card: 'نص كرت الهدايا',
    track: 'تتبع طلبي عبر واتساب', help: 'للاستفسار تواصل معنا على مدار الساعة، 7 أيام في الأسبوع:', size: 'المقاس', color: 'اللون',
    waMsg: id => `مرحباً، أريد متابعة طلبي رقم ${id}`, city: c => CITY_AR[c] || c, name: it => it.nameAr || it.name, col: it => it.colorAr || it.color,
  },
  en: {
    dir: 'ltr', subject: o => `Your giftbox377 invoice ${o.id}`, inv: 'Invoice', hi: n => `Thank you, ${n}!`,
    got: "We've received your order and started preparing it. Here is your invoice and order summary.", no: 'Order number', date: 'Date', item: 'Item', qty: 'Qty', amt: 'Amount',
    sub: 'Subtotal', disc: c => `Discount ${c}`, ship: 'Delivery', free: 'Free', wrap: 'Gift card', total: 'Total', pay: 'Payment',
    payN: { cod: 'Cash on delivery', cliq: 'CliQ', card: 'Card' }, cliqNote: "We'll confirm your order once we've checked your CliQ receipt.",
    to: 'Delivering to', when: 'Delivery', whenV: '1 to 5 business days', inspect: 'You can inspect your order on delivery.', card: 'Gift card message',
    track: 'Track my order on WhatsApp', help: 'Questions? We are here 24/7:', size: 'Size', color: 'Colour',
    waMsg: id => `Hello, I'd like to follow up on my order ${id}`, city: c => c, name: it => it.name, col: it => it.color,
  },
};

function invoiceEmail(o) {
  const L = T[o.lang === 'ar' ? 'ar' : 'en'], cur = o.currency || 'JOD', rtl = L.dir === 'rtl';
  const end = rtl ? 'left' : 'right';
  const first = String(o.name || '').split(' ')[0];
  const waTrack = `https://wa.me/${SHOP.wa}?text=${encodeURIComponent(L.waMsg(o.id))}`;
  const detail = it => [it.color && it.color !== 'Default' ? `${L.color}: ${L.col(it)}` : '', it.size && it.size !== 'One size' ? `${L.size}: ${it.size}` : ''].filter(Boolean).join(' · ');
  const rows = (o.items || []).map(it => `
    <tr><td style="padding:10px 0;border-bottom:1px solid #eee">${esc(L.name(it))}${detail(it) ? `<div style="color:#777;font-size:13px">${esc(detail(it))}</div>` : ''}</td>
    <td style="padding:10px 8px;border-bottom:1px solid #eee;text-align:center">${it.qty}</td>
    <td style="padding:10px 0;border-bottom:1px solid #eee;text-align:${end};white-space:nowrap" dir="ltr">${money(it.price * it.qty, cur)}</td></tr>`).join('');
  const line = (k, v, b) => `<tr><td style="padding:4px 0;color:${b ? '#17141d' : '#666'};${b ? 'font-weight:bold;font-size:17px;padding-top:10px' : ''}">${k}</td><td style="padding:4px 0;text-align:${end};${b ? 'font-weight:bold;font-size:17px;padding-top:10px' : ''}" dir="ltr">${v}</td></tr>`;
  const html = `<!doctype html><html dir="${L.dir}" lang="${rtl ? 'ar' : 'en'}"><body style="margin:0;background:#f4f2f5;font-family:Tahoma,Arial,sans-serif;color:#17141d">
  <div style="max-width:560px;margin:0 auto;padding:20px">
   <div style="background:#0d0b0f;color:#fff;border-radius:14px 14px 0 0;padding:20px 22px">
     <div style="color:#ff8fb5;font-size:14px;font-weight:bold;letter-spacing:.5px">giftbox377</div>
     <div style="font-size:22px;font-weight:bold;margin-top:6px">${L.inv} ${esc(o.id)}</div>
     <div style="color:#ccc;font-size:13px;margin-top:4px">${L.date}: <span dir="ltr">${esc(timeAmman(o.at))}</span></div>
   </div>
   <div style="background:#fff;border-radius:0 0 14px 14px;padding:22px">
     <h2 style="margin:0 0 6px;font-size:18px">${esc(L.hi(first))}</h2>
     <p style="margin:0 0 16px;color:#555;font-size:14px;line-height:1.6">${L.got}</p>
     <table style="width:100%;border-collapse:collapse;font-size:14px">
       <tr style="color:#777;font-size:12px"><td>${L.item}</td><td style="text-align:center">${L.qty}</td><td style="text-align:${end}">${L.amt}</td></tr>${rows}
     </table>
     <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:10px">
       ${line(L.sub, money(o.subtotal, cur))}
       ${o.discount ? line(esc(L.disc(o.promo)), '−' + money(o.discount, cur)) : ''}
       ${line(L.ship, o.ship ? money(o.ship, cur) : L.free)}
       ${o.wrap ? line(L.wrap, money(o.wrap, cur)) : ''}
       ${line(L.total, money(o.total, cur), true)}
     </table>
     <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:16px;background:#faf8fb;border-radius:10px">
       <tr><td style="padding:12px 14px;vertical-align:top;width:50%">
         <div style="color:#777;font-size:12px">${L.pay}</div><div style="margin-top:2px">${esc(L.payN[o.payment] || o.payment)}</div>
         ${o.payment === 'cliq' ? `<div style="color:#8a6d1a;font-size:12px;margin-top:4px">${L.cliqNote}</div>` : ''}
         <div style="color:#777;font-size:12px;margin-top:10px">${L.when}</div><div style="margin-top:2px">${L.whenV}</div>
         <div style="color:#2f7d4f;font-size:12px;margin-top:4px">${L.inspect}</div>
       </td><td style="padding:12px 14px;vertical-align:top">
         <div style="color:#777;font-size:12px">${L.to}</div>
         <div style="margin-top:2px;line-height:1.55">${esc(o.name)}<br><span dir="ltr" style="unicode-bidi:isolate;direction:ltr">&#8206;${esc(o.phone)}&#8206;</span><br>${esc(o.address)}<br>${esc(o.district)}، ${esc(L.city(o.city))}</div>
       </td></tr>
     </table>
     ${o.wrap && o.note ? `<p style="background:#fbeef3;border-radius:10px;padding:10px 12px;font-size:14px;margin:12px 0 0">${L.card}: ${esc(o.note)}</p>` : ''}
     <p style="margin:20px 0 0;text-align:center"><a href="${waTrack}" style="display:inline-block;background:#1fa855;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:bold">${L.track}</a></p>
     <p style="margin:20px 0 0;color:#666;font-size:13px;text-align:center;line-height:1.7">${L.help}<br>
       <a href="https://wa.me/${SHOP.wa}" style="color:#ae2a4f" dir="ltr">${SHOP.waShow}</a> · <a href="mailto:${SHOP.mail}" style="color:#ae2a4f">${SHOP.mail}</a> · <a href="https://${SHOP.web}" style="color:#ae2a4f">${SHOP.web}</a></p>
   </div>
  </div></body></html>`;
  const text = [
    `giftbox377 · ${L.inv} ${o.id}`, `${L.date}: ${timeAmman(o.at)}`, '', L.hi(first), L.got, '',
    ...(o.items || []).map(it => `- ${it.qty} × ${L.name(it)}${detail(it) ? ` (${detail(it)})` : ''} = ${money(it.price * it.qty, cur)}`), '',
    `${L.sub}: ${money(o.subtotal, cur)}`, o.discount ? `${L.disc(o.promo)}: -${money(o.discount, cur)}` : '',
    `${L.ship}: ${o.ship ? money(o.ship, cur) : L.free}`, o.wrap ? `${L.wrap}: ${money(o.wrap, cur)}` : '',
    `${L.total}: ${money(o.total, cur)}`, '',
    `${L.pay}: ${L.payN[o.payment] || o.payment}`, `${L.when}: ${L.whenV}`, L.inspect,
    `${L.to}: ${o.name}, ${o.phone}, ${o.address}, ${o.district}, ${L.city(o.city)}`, '',
    `${L.track}: ${waTrack}`, `${L.help} ${SHOP.waShow} · ${SHOP.mail} · ${SHOP.web}`,
  ].filter(x => x !== '').join('\n');
  return { subject: L.subject(o), html, text };
}

// Main admin + active assistants with access to orders + NOTIFY_EMAIL, without duplicates.
async function teamRecipients() {
  const out = new Map();
  const add = e => { e = String(e || '').trim(); if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) out.set(e.toLowerCase(), e); };
  extra.forEach(add);
  try {
    (await db.pool.query("SELECT email FROM credentials WHERE role = 'owner'")).rows.forEach(r => add(r.email));
    for (const d of await db.listDocs('staff')) {
      const s = d.data || {};
      if (s.active !== false && s.role !== 'owner' && ['view', 'edit'].includes((s.perms || {}).orders)) add(s.email || d.id);
    }
  } catch (e) { console.error('Could not read the team list for order emails:', e.message); }
  return [...out.values()];
}

async function send(to, m, extraOpts = {}) {
  await transport.sendMail({ from: FROM, to, subject: m.subject, text: m.text, html: m.html, ...extraOpts });
}

async function newOrder(o) {
  if (!transport) return;
  const team = await teamRecipients();
  const jobs = [];
  if (team.length) {
    // bcc so assistants don't see each other's addresses; reply goes to the customer when they gave an email
    jobs.push(send(FROM, orderEmail(o), { bcc: team.join(', '), ...(o.email ? { replyTo: o.email } : {}) })
      .catch(e => console.error(`Team email for ${o.id} could not be sent:`, e.message)));
  }
  if (o.email) {
    jobs.push(send(o.email, invoiceEmail(o), { replyTo: env.REPLY_TO || SHOP.mail })
      .catch(e => console.error(`Invoice for ${o.id} could not be sent:`, e.message)));
  }
  await Promise.all(jobs);
}

async function sendInvoice(o) {
  if (!transport || !o || !o.email) return false;
  try { await send(o.email, invoiceEmail(o), { replyTo: env.REPLY_TO || SHOP.mail }); return true; }
  catch (e) { console.error(`Invoice for ${o.id} could not be sent:`, e.message); return false; }
}

module.exports = { newOrder, sendInvoice, orderEmail, invoiceEmail, teamRecipients };
