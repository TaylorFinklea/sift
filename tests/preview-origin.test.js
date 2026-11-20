import assert from "node:assert/strict";
import test from "node:test";
import { createFetchMock } from "miniflare";
import {
  installPersistentAccessJwks,
  isAllowedPreviewHost,
  isAllowedPreviewMutationOrigin,
} from "../scripts/preview-origin.js";

const port = 8787;

test("local Worker preview accepts only exact loopback Host and matching mutation Origin", () => {
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`]) {
    assert.equal(isAllowedPreviewHost(host, port), true);
    assert.equal(isAllowedPreviewMutationOrigin(host, `http://${host}`, port), true);
    assert.equal(isAllowedPreviewMutationOrigin(host, null, port), false);
    assert.equal(isAllowedPreviewMutationOrigin(host, "https://attacker.example", port), false);
    assert.equal(isAllowedPreviewMutationOrigin(host, `http://${host}/path`, port), false);
  }
  for (const host of ["localhost", "localhost.evil:8787", "127.0.0.1:3000", "evil.example:8787"]) {
    assert.equal(isAllowedPreviewHost(host, port), false);
    assert.equal(isAllowedPreviewMutationOrigin(host, `http://${host}`, port), false);
  }
});

test("local preview JWKS fixture remains available for a later cache refresh", async () => {
  const issuer = "https://sift-preview-test.cloudflareaccess.com";
  const jwk = { kty: "RSA", kid: "fixture-key", n: "n", e: "AQAB" };
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  installPersistentAccessJwks(fetchMock, issuer, jwk);
  try {
    for (let request = 0; request < 2; request += 1) {
      const response = await fetchMock.request({
        origin: issuer,
        path: "/cdn-cgi/access/certs",
        method: "GET",
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(JSON.parse(await response.body.text()), { keys: [jwk] });
    }
  } finally {
    await fetchMock.close();
  }
});
