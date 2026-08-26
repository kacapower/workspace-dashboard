import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword,
  verifyPassword,
  issueToken,
  verifyToken,
  sessionCookie,
  clearSessionCookie,
  parseCookies,
} from '../src/auth.js';

const SECRET = 'test-secret';

test('hashPassword/verifyPassword round-trip', async () => {
  const hash = await hashPassword('hunter2');
  assert.notEqual(hash, 'hunter2');
  assert.ok(await verifyPassword('hunter2', hash));
  assert.equal(await verifyPassword('wrong', hash), false);
});

test('verifyPassword rejects garbage input', async () => {
  assert.equal(await verifyPassword('x', null), false);
  assert.equal(await verifyPassword('x', 'not-a-hash'), false);
});

test('issueToken/verifyToken valid and expired', () => {
  const token = issueToken(SECRET);
  assert.equal(verifyToken(token, SECRET), true);
  assert.equal(verifyToken(token, 'other-secret'), false);
  assert.equal(verifyToken('garbage', SECRET), false);
});

test('sessionCookie round-trips through parseCookies and verifyToken', () => {
  const raw = issueToken(SECRET);
  const cookie = sessionCookie(raw, SECRET);
  const parsed = parseCookies({ headers: { cookie: cookie } });
  assert.equal(verifyToken(parsed.igmon, SECRET), true);
});

test('clearSessionCookie produces empty cookie', () => {
  const cookie = clearSessionCookie();
  assert.match(cookie, /igmon=;/);
  const parsed = parseCookies({ headers: { cookie: cookie } });
  assert.equal(parsed.igmon ?? '', '');
  assert.equal(verifyToken(parsed.igmon, SECRET), false);
});
