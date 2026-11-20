export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function fail(status, code, message) {
  throw new HttpError(status, code, message);
}

const JSON_LIMIT = 2 * 1024 * 1024;

/** Read a JSON object with a hard streaming limit for both app and API routes. */
export async function readBoundedJson(request, limit = JSON_LIMIT) {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > limit) fail(413, "body_too_large", "Request body is too large.");
  const reader = request.body?.getReader();
  if (!reader) fail(400, "invalid_json", "Request body must be valid JSON.");
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel().catch(() => {});
      fail(413, "body_too_large", "Request body is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    fail(400, "invalid_json", "Request body must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(400, "invalid_input", "Request body must be a JSON object.");
  }
  return parsed;
}

export const TRANSFER_JSON_LIMIT = 17 * 1024 * 1024;
