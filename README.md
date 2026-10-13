# giftbox377: المتجر الإلكتروني (سيرفر + قاعدة بيانات)

هذا المجلد هو متجر giftbox377 كاملاً، جاهز للرفع على أي سيرفر:

- **الواجهة:** المتجر بالعربية والإنجليزية، والوضع الأسود والأبيض، والسلة، والدفع، وتتبع الطلب، ولوحة التحكم.
- **السيرفر:** Node.js (Express).
- **قاعدة البيانات:** PostgreSQL. تحفظ المنتجات والطلبات والزبائن والصور والإحصائيات.
- **الكتالوج:** يُحمَّل تلقائياً عند أول تشغيل، أي الأقسام والمنتجات وأكواد الخصم والإعدادات وصور منتجاتك.

> English instructions are at the end of this file.

---

## ما الذي تحتاجه

1. **سيرفر:** أسهل خيارين:
   - **VPS** عليه Docker، مثل DigitalOcean أو Hetzner أو Contabo بحوالي 5 دولار شهرياً، **أو**
   - منصة جاهزة مثل **Railway** أو **Render**، ولا تحتاج فيها إلى Docker.
2. **دومين:** مثل gbox377.com، تشتريه من Namecheap أو GoDaddy أو غيرهما.

---

## الطريقة 1: سيرفر VPS مع Docker (الأفضل)

على السيرفر (Ubuntu):

```bash
# 1) ثبّت Docker
curl -fsSL https://get.docker.com | sh

# 2) ارفع هذا المجلد إلى السيرفر (أو انسخه من GitHub) وادخل إليه
cd giftbox377-server

# 3) جهّز الإعدادات
cp .env.example .env
nano .env
```

عبّئ في ملف `.env`:

| الإعداد | ماذا تكتب |
|---|---|
| `POSTGRES_PASSWORD` | كلمة سر طويلة لقاعدة البيانات |
| `SESSION_SECRET` | نص عشوائي طويل. اكتب على السيرفر `openssl rand -hex 32` وانسخ الناتج |
| `OWNER_EMAIL` و `OWNER_PASSWORD` | إيميل وكلمة سر المدير الرئيسي، 10 أحرف على الأقل مع أرقام |
| `DOMAIN` | الدومين بدون https، مثل `gbox377.com` |
| `NOTIFY_EMAIL` و `SMTP_*` | إيميل التنبيه بالطلبات الجديدة (انظر قسم «إيميل عند كل طلب جديد») |

ثم وجّه الدومين إلى السيرفر من لوحة شركة الدومين: سجل **A** يشير إلى عنوان IP السيرفر، للدومين ولـ `www`. بعدها شغّل:

```bash
docker compose --profile https up -d --build
```

هذا الأمر يفعل ثلاثة أشياء:
- يشغّل قاعدة البيانات والمتجر.
- يحمّل الكتالوج تلقائياً عند أول تشغيل.
- يفعّل HTTPS بشهادة مجانية من Let's Encrypt.

افتح `https://gbox377.com` لترى المتجر، و `https://gbox377.com/#admin` لتدخل لوحة التحكم.

> **تجربة بدون دومين:** اكتب في `.env` السطر `SECURE_COOKIES=false`، ثم شغّل `docker compose up -d --build`، وافتح `http://IP-السيرفر:3000`. لا تستعمل هذا الوضع للبيع الفعلي.

---

## الطريقة 2: Railway (بدون إدارة سيرفر)

1. ارفع المجلد إلى مستودع على GitHub.
2. في [railway.app](https://railway.app): **New Project → Deploy from GitHub** واختر المستودع. سيكتشف ملف Dockerfile تلقائياً.
3. أضف قاعدة بيانات: **New → Database → PostgreSQL**.
4. في خدمة المتجر، افتح **Variables** وأضف:
   - `DATABASE_URL` واختر قيمة **Reference** من قاعدة البيانات.
   - `SESSION_SECRET` و `OWNER_EMAIL` و `OWNER_PASSWORD`.
   - `NODE_ENV=production`.
5. من **Settings → Networking** اضغط **Generate Domain**، أو أضف دومينك الخاص.

**Render** مشابه: أنشئ **PostgreSQL** ثم **Web Service** من نفس المستودع، وأضف نفس المتغيرات، ومعها `DATABASE_SSL=true` إذا طلبت قاعدة البيانات SSL.

---

## أول دخول للوحة التحكم

- **إذا وضعت `OWNER_EMAIL` و `OWNER_PASSWORD`:** ادخل بهما من `/#admin`. بعد أول تشغيل يمكنك حذف `OWNER_PASSWORD` من الإعدادات.
- **إذا تركتهما فارغين:**
  1. افتح `/#admin`، فيطلب منك **رمز الإعداد (Setup code)**.
  2. ستجد الرمز في سجل السيرفر:
     ```bash
     docker compose logs app | grep -A2 "setup code"
     ```
     أو ضع رمزاً من عندك في `SETUP_CODE`.
  3. أنشئ إيميلك وكلمة السر.

**إضافة المساعدين:** من **Staff & access** تضيف مساعداً وتختار صلاحياته. يعطيك الموقع رمز دعوة لمرة واحدة، فيفتح المساعد `/#admin` ويختار «Set up your login with an invite code».

**نسيت كلمة سر المدير الرئيسي؟** نفّذ على السيرفر:

```bash
docker compose exec app node scripts/reset-owner.js your@email.com "NewPassword2026"
```

---

## إيميل عند كل طلب جديد

عند كل طلب جديد يصل للإدارة إيميل فيه رقم الطلب، واسم الزبون ورقمه مع زر واتساب، والعنوان، وطريقة الدفع، والمنتجات والمبلغ، وزر لفتح لوحة التحكم.

لتفعيله مع Gmail:
1. فعّل **التحقق بخطوتين** على حساب Gmail الذي سيُرسل منه الإيميل.
2. افتح [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) وأنشئ **App password** باسم giftbox377. ستحصل على كلمة سر من 16 حرفاً.
3. في `.env` اكتب:
   ```
   NOTIFY_EMAIL=gbox41409@gmail.com
   SITE_URL=https://gbox377.com
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_USER=gbox41409@gmail.com
   SMTP_PASS=كلمة السر المكونة من 16 حرفاً
   MAIL_FROM=giftbox377 <gbox41409@gmail.com>
   ```
4. أعد التشغيل: `docker compose up -d`

لإرسال الإيميل لأكثر من شخص، افصل بينهم بفاصلة في `NOTIFY_EMAIL`. إذا لم تُعبّأ هذه الإعدادات، يعمل المتجر عادي ولا تُرسل إيميلات.

---

## النسخ الاحتياطي (مهم)

كل البيانات في قاعدة البيانات، بما فيها الصور. خذ نسخة يومياً:

```bash
docker compose exec db pg_dump -U giftbox giftbox | gzip > backup-$(date +%F).sql.gz
```

للاسترجاع:

```bash
gunzip -c backup-2026-10-10.sql.gz | docker compose exec -T db psql -U giftbox giftbox
```

---

## الدفع

- **الدفع عند الاستلام وكليك (CliQ):** يعملان مباشرة. يرفع الزبون صورة إيصال كليك، وتوافق عليه أو ترفضه من لوحة التحكم.
- **الدفع بالبطاقة:** **متوقف**، لأنه يحتاج بوابة دفع حقيقية. في الأردن مثلاً: HyperPay أو PayTabs أو Amazon Payment Services، أو Stripe إذا توفر لنشاطك. ربط البوابة يحتاج حساب تاجر منها، ثم إضافة الربط في الكود: صفحة دفع من البوابة، وتأكيد من السيرفر عبر Webhook.

---

## الأمان: ما المحمي

- **أسعار الطلبات:** كل طلب يُعاد حساب سعره على السيرفر من قاعدة البيانات: الأسعار والخصومات والتوصيل والمخزون. لا يستطيع أحد تعديل السعر من المتصفح.
- **كلمات السر:** مشفّرة بـ scrypt. بعد 5 محاولات خاطئة يُقفل الدخول 15 دقيقة. وتنتهي جلسة الإدارة بعد 30 دقيقة دون نشاط.
- **صلاحيات المساعدين:** مطبّقة على السيرفر نفسه، وليس على الواجهة فقط.
- **بيانات الزبون:** كل زبون يرى طلباته فقط، ويُعرف من متصفحه بكوكي موقّعة. «طلباتي» تُظهر الطلبات التي تمت من نفس الجهاز.
- **الإحصائيات:** إذا وضعت الموقع خلف **Cloudflare**، تُعرف دولة الزائر بدقة من عنوان IP.

---

## محتويات المجلد

```
src/server.js     السيرفر وواجهات API
src/rules.js      من يقرأ ويكتب ماذا (الصلاحيات)
src/orders.js     التحقق من الطلبات وإعادة حساب الأسعار
src/auth.js       كلمات السر والجلسات
src/db.js         قاعدة البيانات (تُنشأ الجداول تلقائياً)
src/seed.js       تحميل الكتالوج عند أول تشغيل
src/notify.js     إيميل للإدارة عند كل طلب جديد
public/index.html المتجر ولوحة التحكم
public/shim.js    ربط الواجهة بالسيرفر
seed/             الكتالوج وصور المنتجات
scripts/          أداة إعادة تعيين كلمة سر المدير
```

الطلبات والزبائن التجريبيون من النسخة القديمة **لم تُنقل**، فيبدأ المتجر بلا طلبات.

---

## English

**Stack:** Node.js 20+ (Express) and PostgreSQL 13+. Docker is optional.

**Quick start with Docker:**
1. `cp .env.example .env`, then set `POSTGRES_PASSWORD`, `SESSION_SECRET` (`openssl rand -hex 32`), `OWNER_EMAIL`, `OWNER_PASSWORD` and `DOMAIN`.
2. Point your domain's A record at the server.
3. Run `docker compose --profile https up -d --build`. Caddy gets the TLS certificates automatically.

**Without Docker:** `npm ci --omit=dev`, set `DATABASE_URL` and the variables above, then `npm start`. The tables are created on start, and the catalogue in `seed/` is loaded the first time the database is empty.

**Admin:** open `/#admin`.
- The main admin comes from `OWNER_EMAIL`/`OWNER_PASSWORD`, or from the setup code (`SETUP_CODE`, or printed in the log).
- Reset the main admin with `node scripts/reset-owner.js <email> <password>`.

**API overview:** the storefront talks to a small document API.
- `GET /api/doc`, `GET /api/list`, `PUT|PATCH|DELETE /api/doc`.
- Live updates over Server-Sent Events at `/api/events`.
- Staff login under `/api/auth/*`.
- Uploads at `POST /api/assets`, served from `/_blob/:id`.

Access rules are in `src/rules.js`, and new orders are re-priced and validated in `src/orders.js`.

**Order emails:** set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` and `NOTIFY_EMAIL` (comma-separated) to email the team on every new order. With Gmail, use smtp.gmail.com:465 and an App password.

**Card payments** are disabled and refused by the server until a real payment gateway is integrated.

**Backups:** `pg_dump` the database. Uploaded photos and videos are stored in it too.
