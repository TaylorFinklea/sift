import { decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import { HttpError, readBoundedJson } from './http.js';

const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
// The final label must contain a letter, which rules out IP literals and numeric top-level labels.
const HOSTNAME = new RegExp(`^(?:${HOST_LABEL}\\.)+(?=[a-z0-9-]*[a-z])${HOST_LABEL}$`, 'u');
const KEY_PREFIX = 'sift_live_';
const MAX_BEARER_LENGTH = 256;
const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;
const JWKS_REFRESH_COOLDOWN_MS = 30 * 1000;
const JWKS_FETCH_TIMEOUT_MS = 3 * 1000;
const MAX_JWKS_ISSUERS = 8;
const encoder = new TextEncoder();
const jwksCache = new Map();
const jwksFetches = new Map();
const jwksRetryAt = new Map();
const importedJwkKeys = new WeakMap();

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  },
});

const ERROR_CODES = { 400: 'invalid_input', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 405: 'method_not_allowed', 503: 'service_unavailable' };
const error = (status, message, code = ERROR_CODES[status] || 'request_error') => json({ error: { code, message } }, status);
const nowIso = () => new Date().toISOString();

function encodeBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

async function digest(value) {
  const result = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The two exact hostnames this deployment serves, read from `SIFT_APP_HOST` (Access-protected
 * app) and `SIFT_API_HOST` (bearer-key API). Returns null, so callers fail closed, when either
 * is missing, is not a bare hostname (no scheme, port or path), or both are the same.
 */
export function configuredHosts(env) {
  const app = typeof env?.SIFT_APP_HOST === 'string' ? env.SIFT_APP_HOST.trim().toLowerCase() : '';
  const api = typeof env?.SIFT_API_HOST === 'string' ? env.SIFT_API_HOST.trim().toLowerCase() : '';
  if (app.length > 253 || api.length > 253 || !HOSTNAME.test(app) || !HOSTNAME.test(api) || app === api) return null;
  return { app, api };
}

function configuredAccess(env) {
  const issuer = env.SIFT_ACCESS_ISSUER;
  const audience = typeof env.SIFT_ACCESS_AUD === 'string' ? env.SIFT_ACCESS_AUD.trim() : '';
  const ownerEmail = env.SIFT_ACCESS_OWNER_EMAIL;
  if (typeof issuer !== 'string' || !issuer || !audience || typeof ownerEmail !== 'string' || !ownerEmail.trim()) return null;
  try {
    const issuerUrl = new URL(issuer);
    if (issuerUrl.protocol !== 'https:' || issuerUrl.pathname !== '/' || issuerUrl.search || issuerUrl.hash) return null;
  } catch {
    return null;
  }
  return { issuer: issuer.replace(/\/$/u, ''), audience, ownerEmail: ownerEmail.trim().toLowerCase() };
}

async function fetchAndCacheJwks(issuer, fetchImpl, clock) {
  const pending = jwksFetches.get(issuer);
  if (pending) return pending;
  const now = clock();
  const retryAt = jwksRetryAt.get(issuer) || 0;
  const cachedBeforeFetch = jwksCache.get(issuer);
  if (retryAt > now) {
    if (cachedBeforeFetch) return cachedBeforeFetch.keys;
    throw new Error('Access JWKS refresh is cooling down');
  }
  if (cachedBeforeFetch) cachedBeforeFetch.lastRefreshAt = now;

  const fetchPromise = (async () => {
    const controller = new AbortController();
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error('Access JWKS request timed out'));
      }, JWKS_FETCH_TIMEOUT_MS);
    });
    try {
      const fetchAndParse = async () => {
        const response = await fetchImpl(`${issuer}/cdn-cgi/access/certs`, {
          headers: { accept: 'application/json' },
          // Workers supports manual/follow; reject 3xx below without following it.
          redirect: 'manual',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Unable to load Access signing keys');
        const body = await response.json();
        if (!Array.isArray(body.keys) || body.keys.length === 0 || body.keys.length > 32) {
          throw new Error('Invalid Access signing keys');
        }
        return body.keys;
      };
      const keys = await Promise.race([fetchAndParse(), timeoutPromise]);
      const cachedAt = clock();
      if (!jwksCache.has(issuer) && jwksCache.size >= MAX_JWKS_ISSUERS) {
        const oldestIssuer = jwksCache.keys().next().value;
        jwksCache.delete(oldestIssuer);
      }
      jwksCache.set(issuer, {
        keys,
        expiresAt: cachedAt + JWKS_CACHE_TTL_MS,
        lastRefreshAt: cachedAt,
      });
      jwksRetryAt.delete(issuer);
      return keys;
    } catch (cause) {
      jwksRetryAt.set(issuer, clock() + JWKS_REFRESH_COOLDOWN_MS);
      if (jwksRetryAt.size > MAX_JWKS_ISSUERS) {
        const oldestIssuer = jwksRetryAt.keys().next().value;
        jwksRetryAt.delete(oldestIssuer);
      }
      throw cause;
    } finally {
      clearTimeout(timeoutId);
    }
  })();
  jwksFetches.set(issuer, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    if (jwksFetches.get(issuer) === fetchPromise) jwksFetches.delete(issuer);
  }
}

async function getJwks(issuer, fetchImpl, clock) {
  const cached = jwksCache.get(issuer);
  if (cached && cached.expiresAt > clock()) return cached.keys;
  return fetchAndCacheJwks(issuer, fetchImpl, clock);
}

async function refreshJwksForUnknownKey(issuer, fetchImpl, clock) {
  const pending = jwksFetches.get(issuer);
  if (pending) return pending;
  const cached = jwksCache.get(issuer);
  if (cached && clock() - cached.lastRefreshAt < JWKS_REFRESH_COOLDOWN_MS) return cached.keys;
  return fetchAndCacheJwks(issuer, fetchImpl, clock);
}

function matchingKey(keys, kid) {
  return keys.find((candidate) => candidate.kid === kid
    && candidate.kty === 'RSA'
    && candidate.use !== 'enc'
    && (candidate.alg === undefined || candidate.alg === 'RS256'));
}

function importedAccessKey(jwk) {
  let imported = importedJwkKeys.get(jwk);
  if (!imported) {
    imported = importJWK(jwk, 'RS256').catch((cause) => {
      importedJwkKeys.delete(jwk);
      throw cause;
    });
    importedJwkKeys.set(jwk, imported);
  }
  return imported;
}

async function verifyAccessAssertion(request, env, fetchImpl = fetch, clock = Date.now) {
  const config = configuredAccess(env);
  if (!config) return { response: error(503, 'Access authentication is not configured', 'access_not_configured') };

  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!assertion || assertion.length > 16_384) return { response: error(401, 'Access authentication required', 'access_required') };

  try {
    const header = decodeProtectedHeader(assertion);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') {
      return { response: error(401, 'Invalid Access assertion', 'invalid_access_assertion') };
    }
    let keys = await getJwks(config.issuer, fetchImpl, clock);
    let jwk = matchingKey(keys, header.kid);
    if (!jwk) {
      keys = await refreshJwksForUnknownKey(config.issuer, fetchImpl, clock);
      jwk = matchingKey(keys, header.kid);
    }
    if (!jwk) return { response: error(401, 'Invalid Access assertion', 'invalid_access_assertion') };
    const key = await importedAccessKey(jwk);
    const { payload } = await jwtVerify(assertion, key, {
      algorithms: ['RS256'],
      issuer: config.issuer,
      audience: config.audience,
      clockTolerance: 0,
    });
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
      return { response: error(401, 'Invalid Access assertion', 'invalid_access_assertion') };
    }
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    if (!email) return { response: error(401, 'Access assertion has no owner identity', 'access_identity_missing') };
    if (email !== config.ownerEmail) return { response: error(403, 'Access identity is not authorized', 'owner_not_authorized') };
    return { principal: { type: 'owner', email } };
  } catch {
    return { response: error(401, 'Invalid Access assertion', 'invalid_access_assertion') };
  }
}

function readBearer(request) {
  const header = request.headers.get('authorization') || '';
  if (header.length > MAX_BEARER_LENGTH + 16 || !/^Bearer [A-Za-z0-9_-]+$/u.test(header)) return null;
  const token = header.slice(7);
  if (!token.startsWith(KEY_PREFIX) || token.length > MAX_BEARER_LENGTH) return null;
  return token;
}

async function authenticateApiKey(request, env) {
  const token = readBearer(request);
  if (!token) return { response: error(401, 'Valid bearer API key required', 'api_key_invalid') };
  if (!env.DB) return { response: error(503, 'API key storage is not configured', 'api_key_storage_unavailable') };
  const tokenDigest = await digest(token);
  let row;
  try {
    row = await env.DB.prepare(
      `SELECT id, scope, expires_at, revoked_at FROM api_keys WHERE token_digest = ? LIMIT 1`,
    ).bind(tokenDigest).first();
  } catch {
    return { response: error(503, 'API key authentication is temporarily unavailable', 'api_key_storage_unavailable') };
  }
  if (!row || row.revoked_at || (row.expires_at && Date.parse(row.expires_at) <= Date.now())) {
    return { response: error(401, 'Valid bearer API key required', 'api_key_invalid') };
  }
  return {
    principal: { type: 'api_key', keyId: row.id },
    permission: row.scope,
  };
}

/** Authenticate a request on one of the two exact, configured application hosts. */
export async function authenticate(request, env) {
  try {
    const hosts = configuredHosts(env);
    if (!hosts) return error(503, 'Hostnames are not configured', 'host_configuration_unavailable');
    const hostname = new URL(request.url).hostname.toLowerCase();
    if (hostname === hosts.app) {
      const verified = await verifyAccessAssertion(request, env);
      if (verified.response) return verified.response;
      return { channel: 'app', principal: verified.principal, permission: 'read_write' };
    }
    if (hostname === hosts.api) {
      const verified = await authenticateApiKey(request, env);
      if (verified.response) return verified.response;
      return { channel: 'api', principal: verified.principal, permission: verified.permission };
    }
    return error(404, 'Not found', 'not_found');
  } catch {
    return error(503, 'Authentication is temporarily unavailable', 'authentication_unavailable');
  }
}

/** Same-origin guard for state-changing requests on the Access-protected app host. */
export function assertAppWriteOrigin(request, env) {
  const origin = request.headers.get('origin');
  const appHost = configuredHosts(env)?.app;
  if (!origin || !appHost) return error(403, 'A same-origin request is required', 'origin_forbidden');
  try {
    const requestUrl = new URL(request.url);
    if (requestUrl.protocol !== 'https:'
      || requestUrl.hostname.toLowerCase() !== appHost
      || origin !== `https://${appHost}`) return error(403, 'A same-origin request is required', 'origin_forbidden');
  } catch {
    return error(403, 'A same-origin request is required', 'origin_forbidden');
  }
  return null;
}

function publicKey(row) {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    prefix: row.token_prefix,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

async function listKeys(env) {
  const { results = [] } = await env.DB.prepare(
    `SELECT id, name, scope, token_prefix, created_at, expires_at, revoked_at
       FROM api_keys ORDER BY created_at DESC, id ASC`,
  ).all();
  return results.map(publicKey);
}

async function createKey(request, env) {
  let body;
  try {
    body = await readBoundedJson(request);
  } catch (cause) {
    if (cause instanceof HttpError) return error(cause.status, cause.message, cause.code);
    return error(400, 'Invalid JSON body', 'invalid_json');
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const scope = body.scope === undefined ? 'read' : body.scope;
  const expiresInDays = body.expiresInDays === undefined ? 90 : body.expiresInDays;
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/u.test(name)) return error(400, 'Name must be 1–80 printable characters', 'invalid_key_name');
  if (scope !== 'read' && scope !== 'read_write') return error(400, 'Scope must be read or read_write', 'invalid_key_scope');
  if (expiresInDays !== null && expiresInDays !== 30 && expiresInDays !== 90) {
    return error(400, 'Expiry must be 30 days, 90 days, or null', 'invalid_key_expiry');
  }

  const id = crypto.randomUUID();
  const random = new Uint8Array(32);
  crypto.getRandomValues(random);
  const token = `${KEY_PREFIX}${id.replaceAll('-', '')}_${encodeBase64Url(random)}`;
  const tokenPrefix = `${KEY_PREFIX}${id.slice(0, 8)}`;
  const createdAt = nowIso();
  const expiresAt = expiresInDays === null
    ? null
    : new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO api_keys (id, name, scope, token_digest, token_prefix, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).bind(id, name, scope, await digest(token), tokenPrefix, createdAt, expiresAt).run();
  return json({
    key: { id, name, scope, prefix: tokenPrefix, createdAt, expiresAt, revokedAt: null },
    token,
  }, 201);
}

async function revokeKey(request, env, id) {
  if (!/^[0-9a-f-]{36}$/iu.test(id)) return error(404, 'API key not found', 'api_key_not_found');
  await env.DB.prepare(
    `UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?`,
  ).bind(nowIso(), id).run();
  const row = await env.DB.prepare(
    `SELECT id, name, scope, token_prefix, created_at, expires_at, revoked_at FROM api_keys WHERE id = ? LIMIT 1`,
  ).bind(id).first();
  return row ? json({ key: publicKey(row) }) : error(404, 'API key not found', 'api_key_not_found');
}

/** Handle app-only API-key administration; return null for ordinary app routes. */
export async function handleKeyManagement(request, env, auth) {
  const hosts = configuredHosts(env);
  if (!hosts) return error(503, 'Hostnames are not configured', 'host_configuration_unavailable');
  const url = new URL(request.url);
  const hostname = url.hostname.toLowerCase();
  const keysPath = url.pathname === '/api/keys' || /^\/api\/keys\/[^/]+\/revoke$/u.test(url.pathname);
  if (hostname === hosts.api && (keysPath || url.pathname === '/api/capabilities')) return error(404, 'Not found', 'not_found');
  if (hostname !== hosts.app) return null;
  if (url.pathname !== '/api/capabilities' && !keysPath) return null;
  if (!auth || auth.channel !== 'app' || auth.principal?.type !== 'owner') return error(403, 'Owner authentication required', 'owner_authentication_required');
  if (url.pathname === '/api/capabilities') {
    if (request.method !== 'GET') return error(405, 'Method not allowed', 'method_not_allowed');
    return json({ apiKeys: true, apiBaseUrl: `https://${hosts.api}` });
  }
  if (!env.DB) return error(503, 'API key storage is not configured', 'api_key_storage_unavailable');
  if (url.pathname === '/api/keys' && request.method === 'GET') return json({ keys: await listKeys(env) });
  if (url.pathname === '/api/keys' && request.method === 'POST') {
    const originFailure = assertAppWriteOrigin(request, env);
    if (originFailure) return originFailure;
    return createKey(request, env);
  }
  const revoke = url.pathname.match(/^\/api\/keys\/([^/]+)\/revoke$/u);
  if (revoke && request.method === 'POST') {
    const originFailure = assertAppWriteOrigin(request, env);
    if (originFailure) return originFailure;
    return revokeKey(request, env, revoke[1]);
  }
  return error(405, 'Method not allowed', 'method_not_allowed');
}

// Exposed for deterministic signature tests without making the production handler injectable.
export const securityTestHooks = Object.freeze({ verifyAccessAssertion });
