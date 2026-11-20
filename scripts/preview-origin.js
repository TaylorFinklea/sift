export function isAllowedPreviewHost(host, port) {
  return host === `localhost:${port}` || host === `127.0.0.1:${port}`;
}

export function isAllowedPreviewMutationOrigin(host, origin, port) {
  return isAllowedPreviewHost(host, port) && origin === `http://${host}`;
}

export function installPersistentAccessJwks(fetchMock, issuer, jwk) {
  return fetchMock.get(issuer)
    .intercept({ method: "GET", path: "/cdn-cgi/access/certs" })
    .reply(200, { keys: [jwk] })
    .persist();
}
