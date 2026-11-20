const CACHE_KEY = "sift.read-model.v1";

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request(path, options) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers: {
        ...(options?.body ? { "Content-Type": "application/json" } : {}),
        ...options?.headers,
      },
    });
  } catch {
    throw new ApiError("You’re offline. Reconnect to save changes.");
  }

  const contentType = response.headers.get("content-type") || "";
  if (!response.ok) {
    const body = contentType.includes("json") ? await response.json().catch(() => ({})) : {};
    throw new ApiError(body.error?.message || body.message || (typeof body.error === "string" ? body.error : "Something went wrong. Try again."), response.status);
  }
  if (response.status === 204) return null;
  if (!contentType.includes("json")) {
    throw new ApiError("The access proxy may need you to sign in again before loading your cards.", 401);
  }
  return response.json();
}

function unwrap(value, key) {
  return value?.[key] ?? value;
}

function getCachedModel() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (cached?.version === 1 && Array.isArray(cached.collections) && Array.isArray(cached.runs)) return cached;
  } catch {
    // A missing or malformed offline cache should never prevent the live server read.
  }
  return null;
}

function saveCachedModel(model) {
  try {
    // Keep a bounded last-known read model; live server state remains authoritative.
    const bounded = {
      version: 1,
      collections: model.collections.slice(0, 100),
      runs: model.runs.slice(0, 40),
      savedAt: Date.now(),
    };
    let serialized = JSON.stringify(bounded);
    while (serialized.length > 3_500_000 && bounded.runs.length > 1) {
      bounded.runs.pop();
      serialized = JSON.stringify(bounded);
    }
    if (serialized.length > 3_500_000) return;
    localStorage.setItem(CACHE_KEY, serialized);
  } catch {
    // Storage can be disabled or full; use the server response for this session.
  }
}

export function mergeRunIntoWorkspace(workspace, updatedRun) {
  const runs = [
    ...workspace.runs.filter((run) => run.id !== updatedRun.id),
    updatedRun,
  ].sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
  const merged = { ...workspace, runs };
  saveCachedModel(merged);
  return merged;
}

export async function loadWorkspace({ shouldCommit = () => true } = {}) {
  try {
    const [collectionsResponse, runsResponse] = await Promise.all([
      request("/api/collections"),
      request("/api/runs"),
    ]);
    const model = {
      collections: unwrap(collectionsResponse, "collections"),
      runs: unwrap(runsResponse, "runs"),
      connection: "online",
    };
    if (!Array.isArray(model.collections) || !Array.isArray(model.runs)) {
      throw new ApiError("The server returned an unexpected response. Please reload.");
    }
    if (shouldCommit()) saveCachedModel(model);
    return model;
  } catch (error) {
    const cached = getCachedModel();
    if (!cached) throw error;
    const offline = error instanceof ApiError && error.status === 0;
    const proxyDenied = error instanceof ApiError && [401, 403].includes(error.status);
    return {
      ...cached,
      connection: offline ? "offline" : proxyDenied ? "proxy" : "unavailable",
      connectionMessage: offline
        ? "You’re offline. Reconnect to keep sorting and save changes."
        : proxyDenied
          ? "The access proxy needs your sign-in. Reauthenticate to keep sorting and save changes."
          : "The server is unavailable. Your saved cards are available read-only.",
    };
  }
}

export async function createCollection(input) {
  return unwrap(await request("/api/collections", { method: "POST", body: JSON.stringify(input) }), "collection");
}

export async function updateCollection(id, input, expectedUpdatedAt) {
  return unwrap(await request(`/api/collections/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify({ ...input, expectedUpdatedAt }),
  }), "collection");
}

export async function createRun(input) {
  return unwrap(await request("/api/runs", { method: "POST", body: JSON.stringify(input) }), "run");
}

export async function updateRoundPlan(run, rounds) {
  return unwrap(await request(`/api/runs/${encodeURIComponent(run.id)}/plan`, {
    method: "PATCH",
    body: JSON.stringify({ rounds, expectedPlanRevision: run.planRevision }),
  }), "run");
}

export async function skipCard(run, cardId) {
  return unwrap(await request(`/api/runs/${encodeURIComponent(run.id)}/skip`, {
    method: "POST",
    body: JSON.stringify({ cardId, expectedRevision: run.revision }),
  }), "run");
}

export async function reviseDecision(run, cardId, choice, value) {
  return unwrap(await request(`/api/runs/${encodeURIComponent(run.id)}/revise`, {
    method: "POST",
    body: JSON.stringify({ cardId, choice, ...(choice === "rating" ? { value } : {}), expectedRevision: run.revision }),
  }), "run");
}

export async function saveDecision(run, cardId, choice, value) {
  return unwrap(await request(`/api/runs/${encodeURIComponent(run.id)}/decisions`, {
    method: "POST",
    body: JSON.stringify({ cardId, choice, ...(choice === "rating" ? { value } : {}), expectedRevision: run.revision }),
  }), "run");
}

export async function undoDecision(run) {
  return unwrap(await request(`/api/runs/${encodeURIComponent(run.id)}/undo`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision: run.revision }),
  }), "run");
}

export async function getRun(id) {
  return unwrap(await request(`/api/runs/${encodeURIComponent(id)}`), "run");
}

export async function getCapabilities() {
  return request("/api/capabilities", { cache: "no-store" });
}

export async function previewTransfer(archive) {
  return request("/api/transfers/preview", { method: "POST", body: JSON.stringify({ archive }) });
}

export async function importTransfer(archive, previewToken) {
  return request("/api/transfers/import", { method: "POST", body: JSON.stringify({ archive, previewToken }) });
}

export async function exportTransfer(collectionId) {
  const query = collectionId ? `?collectionId=${encodeURIComponent(collectionId)}` : "";
  const response = await request(`/api/transfers/export${query}`, { cache: "no-store" });
  return unwrap(response, "archive");
}

export async function getApiKeys() {
  return request("/api/keys", { cache: "no-store", headers: { "Cache-Control": "no-store" } });
}

export async function createApiKey(input) {
  return request("/api/keys", {
    method: "POST",
    cache: "no-store",
    headers: { "Cache-Control": "no-store" },
    body: JSON.stringify(input),
  });
}

export async function revokeApiKey(id) {
  return request(`/api/keys/${encodeURIComponent(id)}/revoke`, {
    method: "POST",
    cache: "no-store",
    headers: { "Cache-Control": "no-store" },
  });
}

export function readCachedWorkspace() {
  return getCachedModel();
}
