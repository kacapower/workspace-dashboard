import crypto from 'node:crypto';

const KEYLEN = 64;
const SALT_LEN = 16;
const COOKIE_NAME = 'igmon';
const COOKIE_MAX_AGE_DAYS = 30;

function scryptAsync(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEYLEN, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_LEN);
  const key = await scryptAsync(password, salt);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  if (!stored) return false;
  const [saltHex, keyHex] = stored.split(':');
  if (!saltHex || !keyHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const key = await scryptAsync(password, salt);
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

function sign(value) {
  const h = crypto.createHmac('sha256', value);
  return h.digest('hex');
}

export function issueToken(secret) {
  const exp = Date.now() + COOKIE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const payload = `${exp}:${crypto.randomBytes(16).toString('hex')}`;
  return `${payload}.${sign(secret + payload)}`;
}

export function verifyToken(token, secret) {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return false;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(secret + payload);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const exp = Number(payload.split(':')[0]);
  return Number.isFinite(exp) && exp > Date.now();
}

export function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

export function sessionCookie(value, secret) {
  const mac = sign(secret + value);
  const cookieValue = `${value}.${mac}`;
  return `${COOKIE_NAME}=${cookieValue}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_DAYS * 24 * 60 * 60}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
