'use strict';
// Emails the store team when a new order comes in.
// Configure with SMTP_* and NOTIFY_EMAIL in .env (see README). Without SMTP settings nothing is sent.
const nodemailer = require('nodemailer');

const env = process.env;
const recipients = String(env.NOTIFY_EMAIL || '').split(',').map(s => s.trim()).filter(Boolean);
const configured = !!(env.SMTP_HOST && recipients.length);
const siteUrl = String(env.SITE_URL || '').replace(/\/+$/, '');

let transport = null;
if (configured) {
  const port = parseInt(env.SMTP_PORT, 10) || 465;
  transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS || '' } : undefined,
  });
} else {
  console.log('Order emails are off: set SMTP_HOST, SMTP_USER, SMTP_PASS and NOTIFY_EMAIL to turn them on.');
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
   <p style="color:#999;font-size:12px;text-align:center">وصلك هذا الإيميل لأن عنوانك مضاف في NOTIFY_EMAIL في إعدادات السيرفر.</p>
  </div></body></html>`;
  const text = [
    `طلب جديد ${o.id} · New order`,
    `${timeAmman(o.at)} · ${money(o.total, cur)}`,
    '',
    `الاسم: ${o.name}`, `الموبايل: ${o.phone}`, `العنوان: ${o.address}، ${o.district}، ${city(o.city)}`,
    o.deliveryNotes ? `ملاحظات: ${o.deliveryNotes}` : '',
    `الدفع: ${PAY[o.payment] || o.payment}`,
    '',
    ...(o.items || []).map(it => `- ${it.qty} × ${it.name} (${it.color}${it.size && it.size !== 'One size' ? ', ' + it.size : ''}) = ${money(it.price * it.qty, cur)}`),
    '',
    `الإجمالي: ${money(o.total, cur)}`,
    siteUrl ? `لوحة التحكم: ${siteUrl}/#admin` : '',
  ].filter(x => x !== '').join('\n');
  return { subject: `🛍️ طلب جديد ${o.id} · ${money(o.total, cur)} · ${o.name}`, html, text };
}

async function newOrder(o) {
  if (!transport) return;
  const m = orderEmail(o);
  try {
    await transport.sendMail({ from: env.MAIL_FROM || env.SMTP_USER, to: recipients.join(', '), subject: m.subject, text: m.text, html: m.html });
  } catch (e) {
    console.error(`Order email for ${o.id} could not be sent:`, e.message);
  }
}

module.exports = { newOrder, orderEmail };
