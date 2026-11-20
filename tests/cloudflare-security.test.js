import test from 'node:test';
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  assertAppWriteOrigin,
  authenticate,
  configuredHosts,
  handleKeyManagement,
  securityTestHooks,
} from '../cloudflare/security.js';
import { handleRequest } from '../cloudflare/index.js';

const issuer = 'https://sift-team.cloudflareaccess.com';
const audience = 'sift-access-audience';
const ownerEmail = 'owner@example.com';
const hostEnv = { SIFT_APP_HOST: 'sift.example.com', SIFT_API_HOST: 'api.sift.example.com' };
const accessEnv = {
  ...hostEnv,
  SIFT_ACCESS_ISSUER: issuer,
  SIFT_ACCESS_AUD: audience,
  SIFT_ACCESS_OWNER_EMAIL: ownerEmail,
};

const { publicKey, privateKey } = await generateKeyPair('RS256');
const publicJwk = { ...(await exportJWK(publicKey)), kid: 'temporary-test-key', use: 'sig' };

async function signedAssertion(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: issuer,
    aud: audience,
    iat: now,
    exp: now + 120,
    email: ownerEmail,
    ...overrides,
  };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: publicJwk.kid, typ: 'JWT' })
    .sign(privateKey);
}

const jwksFetch = async () => new Response(JSON.stringify({ keys: [publicJwk] }), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Request(url, { method, headers, body });
}

function responseHeaders() {
  return { origin: 'https://sift.example.com', 'content-type': 'application/json' };
}

class MemoryD1 {
  rows = new Map();

  prepare(sql) {
    let params = [];
    const db = this;
    return {
      bind(...values) { params = values; return this; },
      async first() {
        if (sql.includes('WHERE token_digest = ?')) {
          return [...db.rows.values()].find((row) => row.token_digest === params[0]) || null;
        }
        if (sql.includes('WHERE id = ?')) return db.rows.get(params[0]) || null;
        return null;
      },
      async all() {
        return { results: [...db.rows.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)) };
      },
      async run() {
        if (sql.includes('INSERT INTO api_keys')) {
          const [id, name, scope, token_digest, token_prefix, created_at, expires_at, revoked_at] = params;
          db.rows.set(id, { id, name, scope, token_digest, token_prefix, created_at, expires_at, revoked_at });
        } else if (sql.includes('UPDATE api_keys')) {
          const [revokedAt, id] = params;
          const row = db.rows.get(id);
          if (row && !row.revoked_at) row.revoked_at = revokedAt;
        }
        return { success: true, meta: { changes: 1 } };
      },
    };
  }
}

test('Cloudflare Access validates signed RS256 claims and fails closed', async () => {
  const verify = async (jwt, config = accessEnv) => securityTestHooks.verifyAccessAssertion(
    request('https://sift.example.com/', { headers: { 'Cf-Access-Jwt-Assertion': jwt } }),
    config,
    jwksFetch,
  );

  assert.equal((await verify(await signedAssertion())).principal.email, ownerEmail);
  assert.equal((await verify(await signedAssertion({ aud: [audience] }))).principal.email, ownerEmail);
  assert.equal((await verify(await signedAssertion({ aud: 'wrong' }))).response.status, 401);
  assert.equal((await verify(await signedAssertion({ iss: 'https://other.cloudflareaccess.com' }))).response.status, 401);
  assert.equal((await verify(await signedAssertion({ exp: Math.floor(Date.now() / 1000) - 10 }))).response.status, 401);
  assert.equal((await verify(await signedAssertion({ exp: undefined }))).response.status, 401);
  assert.equal((await verify(await signedAssertion({ nbf: Math.floor(Date.now() / 1000) + 120 }))).response.status, 401);
  assert.equal((await verify(await signedAssertion({ email: 'other@example.com' }))).response.status, 403);
  assert.equal((await verify(await signedAssertion({ email: undefined }))).response.status, 401);
  assert.equal((await verify('not-a-jwt')).response.status, 401);
  const signed = await signedAssertion();
  const parts = signed.split('.');
  parts[2] = `${parts[2][0] === 'A' ? 'B' : 'A'}${parts[2].slice(1)}`;
  assert.equal((await verify(parts.join('.'))).response.status, 401);
  assert.equal((await verify(await signedAssertion(), {})).response.status, 503);
});

test('Access imports a replacement key when a refreshed JWKS reuses the same key ID', async () => {
  const replacementIssuer = 'https://same-kid-rotation.cloudflareaccess.com';
  const config = { ...accessEnv, SIFT_ACCESS_ISSUER: replacementIssuer };
  const firstPair = await generateKeyPair('RS256');
  const secondPair = await generateKeyPair('RS256');
  const firstJwk = { ...(await exportJWK(firstPair.publicKey)), kid: 'stable-key-id', use: 'sig' };
  const secondJwk = { ...(await exportJWK(secondPair.publicKey)), kid: 'stable-key-id', use: 'sig' };
  const makeToken = async (pair) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ iss: replacementIssuer, aud: audience, email: ownerEmail, iat: now, exp: now + 120 })
      .setProtectedHeader({ alg: 'RS256', kid: 'stable-key-id' })
      .sign(pair.privateKey);
  };
  let fetchCount = 0;
  let clockNow = Date.now();
  const rotatingFetch = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ keys: [fetchCount === 1 ? firstJwk : secondJwk] }));
  };
  const verify = (jwt) => securityTestHooks.verifyAccessAssertion(
    request('https://sift.example.com/', { headers: { 'Cf-Access-Jwt-Assertion': jwt } }),
    config,
    rotatingFetch,
    () => clockNow,
  );

  const firstToken = await makeToken(firstPair);
  const secondToken = await makeToken(secondPair);
  assert.equal((await verify(firstToken)).principal.email, ownerEmail);
  clockNow += 5 * 60 * 1000 + 1;
  assert.equal((await verify(secondToken)).principal.email, ownerEmail);
  assert.equal(fetchCount, 2);
  assert.equal((await verify(firstToken)).response.status, 401);
});

test('Access JWKS rejects redirects without following them', async () => {
  const redirectIssuer = 'https://redirect-test.cloudflareaccess.com';
  const assertion = await signedAssertion({ iss: redirectIssuer });
  let calls = 0;
  const result = await securityTestHooks.verifyAccessAssertion(
    request('https://sift.example.com/', { headers: { 'Cf-Access-Jwt-Assertion': assertion } }),
    { ...accessEnv, SIFT_ACCESS_ISSUER: redirectIssuer },
    async (url, options) => {
      calls += 1;
      assert.equal(url, `${redirectIssuer}/cdn-cgi/access/certs`);
      assert.equal(options.redirect, 'manual');
      return new Response(null, { status: 302, headers: { location: 'https://other.example/certs' } });
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.response.status, 401);
  assert.equal((await result.response.json()).error.code, 'invalid_access_assertion');
});

test('Access JWKS refreshes once when a valid rotating key ID misses the cache', async () => {
  const rotatedIssuer = 'https://rotation-test.cloudflareaccess.com';
  const rotatedConfig = { ...accessEnv, SIFT_ACCESS_ISSUER: rotatedIssuer };
  const rotationKey = await generateKeyPair('RS256');
  const rotationJwk = { ...(await exportJWK(rotationKey.publicKey)), kid: 'rotated-key', use: 'sig' };
  const finalKey = await generateKeyPair('RS256');
  const finalJwk = { ...(await exportJWK(finalKey.publicKey)), kid: 'final-key', use: 'sig' };
  const makeToken = async (key, kid) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ iss: rotatedIssuer, aud: audience, email: ownerEmail, iat: now, exp: now + 120 })
      .setProtectedHeader({ alg: 'RS256', kid })
      .sign(key);
  };
  let fetchCount = 0;
  let clockNow = 1_000_000;
  const rotatingFetch = async () => {
    fetchCount += 1;
    if (fetchCount > 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const keys = fetchCount === 1 ? [publicJwk] : fetchCount === 2 ? [rotationJwk] : [finalJwk];
    return new Response(JSON.stringify({ keys }));
  };
  const oldToken = await makeToken(privateKey, publicJwk.kid);
  const newToken = await makeToken(rotationKey.privateKey, rotationJwk.kid);
  const finalToken = await makeToken(finalKey.privateKey, finalJwk.kid);
  const unknownToken = await makeToken(finalKey.privateKey, 'unknown-key');
  const verify = (jwt) => securityTestHooks.verifyAccessAssertion(
    request('https://sift.example.com/', { headers: { 'Cf-Access-Jwt-Assertion': jwt } }),
    rotatedConfig,
    rotatingFetch,
    () => clockNow,
  );
  assert.equal((await verify(oldToken)).principal.email, ownerEmail);
  clockNow += 30_001;
  const refreshed = await Promise.all(Array.from({ length: 8 }, () => verify(newToken)));
  assert.ok(refreshed.every((result) => result.principal?.email === ownerEmail));
  assert.equal(fetchCount, 2);

  const repeatedUnknown = await Promise.all(Array.from({ length: 8 }, () => verify(unknownToken)));
  assert.ok(repeatedUnknown.every((result) => result.response?.status === 401));
  assert.equal(fetchCount, 2);

  clockNow += 30_001;
  assert.equal((await verify(finalToken)).principal.email, ownerEmail);
  assert.equal(fetchCount, 3);
});

test('Access JWKS requests have a bounded timeout and failed fetches cool down', async () => {
  const timeoutIssuer = 'https://timeout-test.cloudflareaccess.com';
  const timeoutConfig = { ...accessEnv, SIFT_ACCESS_ISSUER: timeoutIssuer };
  const assertion = await signedAssertion({ iss: timeoutIssuer });
  let fetchCount = 0;
  let aborted = false;
  const hungFetch = async (_url, options) => {
    fetchCount += 1;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      }, { once: true });
    });
  };
  const verify = () => securityTestHooks.verifyAccessAssertion(
    request('https://sift.example.com/', { headers: { 'Cf-Access-Jwt-Assertion': assertion } }),
    timeoutConfig,
    hungFetch,
    () => 5_000,
  );
  const first = await verify();
  assert.equal(first.response.status, 401);
  assert.equal(aborted, true);
  const second = await verify();
  assert.equal(second.response.status, 401);
  assert.equal(fetchCount, 1);
});

test('app auth ignores forwarded email headers and host routing is exact', async () => {
  const appResponse = await authenticate(request('https://sift.example.com/api/collections', {
    headers: { 'Cf-Access-Authenticated-User-Email': ownerEmail, 'X-Forwarded-Email': ownerEmail },
  }), accessEnv);
  assert.ok(appResponse instanceof Response);
  assert.equal(appResponse.status, 401);

  const otherHost = await authenticate(request('https://evil.example/api/collections'), accessEnv);
  assert.ok(otherHost instanceof Response);
  assert.equal(otherHost.status, 404);
  const siblingHost = await authenticate(request('https://not-sift.example.com/'), accessEnv);
  assert.equal(siblingHost.status, 404);
});

test('hostnames come only from configuration and fail closed when missing or invalid', async () => {
  assert.deepEqual(
    configuredHosts({ SIFT_APP_HOST: ' Sift.Example.com ', SIFT_API_HOST: 'api.sift.example.com' }),
    { app: 'sift.example.com', api: 'api.sift.example.com' },
  );
  for (const [app, api] of [
    [undefined, undefined],
    ['sift.example.com', undefined],
    ['', 'api.sift.example.com'],
    ['https://sift.example.com', 'api.sift.example.com'],
    ['sift.example.com:443', 'api.sift.example.com'],
    ['sift.example.com/app', 'api.sift.example.com'],
    ['sift.example.com.', 'api.sift.example.com'],
    ['sift.example.com', 'SIFT.example.com'],
    ['127.0.0.1', 'api.sift.example.com'],
    ['sift.example.com', '999.999.999.999'],
    ['sift.example.123', 'api.sift.example.com'],
  ]) {
    assert.equal(configuredHosts({ SIFT_APP_HOST: app, SIFT_API_HOST: api }), null, `${app} / ${api}`);
  }

  const { SIFT_APP_HOST, SIFT_API_HOST, ...unconfigured } = accessEnv;
  const denied = await authenticate(request('https://sift.example.com/api/collections'), unconfigured);
  assert.equal(denied.status, 503);
  assert.equal((await denied.json()).error.code, 'host_configuration_unavailable');
  const write = request('https://sift.example.com/api/collections', { method: 'POST', headers: { origin: 'https://sift.example.com' } });
  assert.equal(assertAppWriteOrigin(write, unconfigured).status, 403);
  assert.equal(assertAppWriteOrigin(write, accessEnv), null);
  const worker = await handleRequest(request('https://sift.example.com/'), unconfigured);
  assert.equal(worker.status, 503);
  assert.equal((await worker.json()).error.code, 'host_configuration_unavailable');
});

test('API key lookup database failures return a no-store JSON service error', async () => {
  const brokenDb = { prepare() { throw new Error('private database failure'); } };
  const result = await authenticate(request('https://api.sift.example.com/api/collections', {
    headers: { authorization: 'Bearer sift_live_0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz0123456789abcdefghijk' },
  }), { ...hostEnv, DB: brokenDb });
  assert.ok(result instanceof Response);
  assert.equal(result.status, 503);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await result.json(), {
    error: { code: 'api_key_storage_unavailable', message: 'API key authentication is temporarily unavailable' },
  });
});

test('key management returns plaintext once, metadata only thereafter, and revokes immediately', async () => {
  const DB = new MemoryD1();
  const env = { ...hostEnv, DB };
  const appAuth = { channel: 'app', principal: { type: 'owner', email: ownerEmail } };
  const create = await handleKeyManagement(request('https://sift.example.com/api/keys', {
    method: 'POST', headers: responseHeaders(),
    body: JSON.stringify({ name: 'Automation', scope: 'read_write', expiresInDays: null }),
  }), env, appAuth);
  assert.equal(create.status, 201);
  assert.equal(create.headers.get('cache-control'), 'no-store');
  const created = await create.json();
  assert.equal(created.key.scope, 'read_write');
  assert.equal(created.key.expiresAt, null);
  assert.match(created.token, /^sift_live_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/u);
  const stored = DB.rows.get(created.key.id);
  assert.ok(stored.token_digest);
  assert.ok(!JSON.stringify(stored).includes(created.token));

  const listedResponse = await handleKeyManagement(request('https://sift.example.com/api/keys'), env, appAuth);
  const listed = await listedResponse.json();
  assert.equal(listed.keys[0].id, created.key.id);
  assert.equal('token' in listed.keys[0], false);
  assert.equal('token_digest' in listed.keys[0], false);

  const apiRequest = (token) => request('https://api.sift.example.com/api/collections', {
    headers: { authorization: `Bearer ${token}` },
  });
  const valid = await authenticate(apiRequest(created.token), env);
  assert.equal(valid.channel, 'api');
  assert.equal(valid.permission, 'read_write');
  const wrongHost = await handleKeyManagement(request('https://api.sift.example.com/api/keys'), env, valid);
  assert.equal(wrongHost.status, 404);

  const revokedResponse = await handleKeyManagement(request(`https://sift.example.com/api/keys/${created.key.id}/revoke`, {
    method: 'POST', headers: responseHeaders(),
  }), env, appAuth);
  assert.ok((await revokedResponse.json()).key.revokedAt);
  const revoked = await authenticate(apiRequest(created.token), env);
  assert.ok(revoked instanceof Response);
  assert.equal(revoked.status, 401);
});

test('key scope, expiry, origin, and API host admin boundaries are enforced', async () => {
  const DB = new MemoryD1();
  const env = { ...hostEnv, DB };
  const appAuth = { channel: 'app', principal: { type: 'owner', email: ownerEmail } };
  const make = async (value) => {
    const response = await handleKeyManagement(request('https://sift.example.com/api/keys', {
      method: 'POST', headers: responseHeaders(), body: JSON.stringify(value),
    }), env, appAuth);
    return response;
  };
  const defaultKeyResponse = await make({ name: 'Read only' });
  const defaultKey = await defaultKeyResponse.json();
  assert.equal(defaultKey.key.scope, 'read');
  assert.ok(defaultKey.key.expiresAt);

  const expired = await authenticate(request('https://api.sift.example.com/api/x', {
    headers: { authorization: `Bearer ${defaultKey.token}` },
  }), env);
  assert.equal(expired.permission, 'read');
  DB.rows.get(defaultKey.key.id).expires_at = new Date(Date.now() - 1000).toISOString();
  const nowExpired = await authenticate(request('https://api.sift.example.com/api/x', {
    headers: { authorization: `Bearer ${defaultKey.token}` },
  }), env);
  assert.ok(nowExpired instanceof Response);
  assert.equal(nowExpired.status, 401);

  const queryToken = await authenticate(request(`https://api.sift.example.com/api/x?token=${encodeURIComponent(defaultKey.token)}`), env);
  assert.equal(queryToken.status, 401);
  const apiAdmin = await handleKeyManagement(request('https://api.sift.example.com/api/keys'), env, appAuth);
  assert.equal(apiAdmin.status, 404);
  const badOrigin = await handleKeyManagement(request('https://sift.example.com/api/keys', {
    method: 'POST', headers: { origin: 'https://attacker.example', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Bad origin' }),
  }), env, appAuth);
  assert.equal(badOrigin.status, 403);
  const originWithPath = await handleKeyManagement(request('https://sift.example.com/api/keys', {
    method: 'POST', headers: { origin: 'https://sift.example.com/path', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Bad origin' }),
  }), env, appAuth);
  assert.equal(originWithPath.status, 403);
  const originWithCredentials = await handleKeyManagement(request('https://sift.example.com/api/keys', {
    method: 'POST', headers: { origin: 'https://user@sift.example.com', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Bad origin' }),
  }), env, appAuth);
  assert.equal(originWithCredentials.status, 403);
  const badScope = await make({ name: 'Invalid scope', scope: 'admin' });
  assert.equal(badScope.status, 400);
  assert.equal((await badScope.json()).error.code, 'invalid_key_scope');
  const oversized = await handleKeyManagement(request('https://sift.example.com/api/keys', {
    method: 'POST', headers: responseHeaders(),
    body: `{"name":"${'x'.repeat(2 * 1024 * 1024)}"}`,
  }), env, appAuth);
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, 'body_too_large');
});
