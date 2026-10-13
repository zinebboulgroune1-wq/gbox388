'use strict';
const crypto = require('crypto');

const env = process.env;
const production = env.NODE_ENV === 'production';

if (!env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}
let sessionSecret = env.SESSION_SECRET || '';
if (sessionSecret.length < 32) {
  if (production) {
    console.error('SESSION_SECRET must be at least 32 characters in production.');
    process.exit(1);
  }
  sessionSecret = crypto.randomBytes(32).toString('hex');
  console.warn('SESSION_SECRET not set: using a random one. Shoppers lose their "My orders" history and admins are signed out whenever the server restarts.');
}

module.exports = {
  production,
  port: parseInt(env.PORT, 10) || 3000,
  databaseUrl: env.DATABASE_URL,
  databaseSsl: env.DATABASE_SSL === 'true',
  sessionSecret,
  // Secure cookies need HTTPS. Turn off only for plain-HTTP testing.
  secureCookies: env.SECURE_COOKIES ? env.SECURE_COOKIES === 'true' : production,
  ownerEmail: (env.OWNER_EMAIL || '').trim().toLowerCase(),
  ownerPassword: env.OWNER_PASSWORD || '',
  setupCode: env.SETUP_CODE || '',
  maxUploadMb: parseInt(env.MAX_UPLOAD_MB, 10) || 25,
  trustProxy: env.TRUST_PROXY ? env.TRUST_PROXY === 'true' : true,
};
