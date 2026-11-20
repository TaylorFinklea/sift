# Self-hosting Sift

Sift has two production runtimes that share one API and front end:

- **Container:** Node.js 24+ with a built-in SQLite database. No external database service.
- **Cloudflare:** a Worker with D1, Cloudflare Access for the app and hashed bearer keys for the API.

For local development, see the [README](../README.md#run-it-locally).

## Production build on your machine

Run `npm run build` followed by `npm start`, then open `http://localhost:3000`. Local `npm start` keeps the server on loopback unless proxy-protected mode is enabled.

## Container hosting behind an access proxy

Sift does not implement user accounts or validate proxy identity headers. Keep it behind an access proxy such as Cloudflare Access. The proxy must authenticate users before forwarding requests, and the app container must not be reachable directly from an untrusted network. The container requires an exact public HTTPS origin so writes can be limited to same-origin browser requests; that origin check helps prevent cross-site request forgery but does not authenticate a user.

Set the public origin to the exact HTTPS address users will open, then build and start the container:

```sh
SIFT_PUBLIC_ORIGIN=https://sift.example.com docker compose up -d --build
```

The Compose port binds to `127.0.0.1:3000` on the host. Point the existing proxy or tunnel to that private local address and keep its authentication gate enabled. The persistent `sift-data` volume stores `/data/sift.sqlite`. Back up that volume before moving or upgrading the container. Change the host port in `compose.yaml` only when needed.

The API server binds to `127.0.0.1` by default. `SIFT_TRUST_PROXY_AUTH=1` is an explicit deployment setting that binds the server inside the container so the host proxy can reach it. This setting trusts the deployment boundary only for reachability; Sift never trusts `X-Forwarded-*` identity headers. `SIFT_PUBLIC_ORIGIN` must be an HTTPS origin with no path. Never publish the container port on a network interface exposed to untrusted clients.

## Cloudflare Workers and D1

`cloudflare/index.js` is the production Cloudflare entry; `wrangler.jsonc` binds one Worker to two Custom Domains and one D1 database. The container and original Sites starter remain separate hosting options. The hostnames below are placeholders: set your own in the routes and in `SIFT_APP_HOST` and `SIFT_API_HOST`.

- `sift.example.com` (`SIFT_APP_HOST`): the main app and same-origin browser API. Cloudflare Access must protect the entire hostname. The Worker itself serves only `GET` and `HEAD` requests for `/privacy` and `/support` without an Access assertion, for the public privacy and support pages. The Worker also verifies the signed Access JWT, expected issuer/audience, expiration, and configured owner email before serving API responses or static assets.
- `api.sift.example.com` (`SIFT_API_HOST`): external clients use `Authorization: Bearer YOUR_API_KEY`. Keys can read data or explicitly read/write it; they cannot create, list, or revoke keys. No browser CORS access is enabled. The main app never uses bearer keys.

The API keys screen appears only on the Cloudflare runtime. New keys default to read-only and 90-day expiry, with explicit read/write, 30-day, and no-expiry choices. The full key is returned once, displayed masked until revealed, and kept only in transient UI state. D1 stores a SHA-256 digest and safe metadata. Revocation is checked on every subsequent API request. Keys and key-management responses are excluded from the offline read model and service-worker cache.

The checked-in configuration deliberately has placeholder hostnames, a placeholder D1 ID and empty host and Access settings. Before any deployment, review the target Cloudflare account and zone, create or select the intended D1 database, and configure:

| Configuration | Value |
| --- | --- |
| `routes` | Your two Custom Domains |
| `SIFT_APP_HOST` | The app hostname, with no scheme, port or path |
| `SIFT_API_HOST` | The API hostname, different from the app hostname |
| `DB` / `database_id` | The reviewed Sift D1 database ID |
| `SIFT_ACCESS_ISSUER` | Exact `https://TEAM.cloudflareaccess.com` issuer |
| `SIFT_ACCESS_AUD` | The main app's Access application audience |
| `SIFT_ACCESS_OWNER_EMAIL` | The single authorized owner's email |

Set the hostnames to match `routes` in the config you deploy from; `wrangler deploy` replaces dashboard variables with the file's values, including empty ones. The Worker fails closed without these settings: it answers `503` until both hostnames are set and rejects sign-in until Access is configured. `workers.dev` and preview URLs are disabled, and `run_worker_first: true` keeps static assets behind authentication. Configure the owner-only Access policy on the main hostname; keep the API hostname available for bearer authentication. Authentication depends on cryptographic JWT verification, not an email or forwarded-identity header.

Local checks use real Workerd and isolated D1 storage, generated test signing keys, and a synthetic Access JWKS response; they do not contact a live Cloudflare account or import existing SQLite data:

```sh
npm run build
npm run test:worker
npm run dev:worker:preview
```

The synthetic preview opens at `http://127.0.0.1:8787`, signs temporary fixture assertions only in memory, and starts with isolated demo data. It is a local development harness, never the deployed entry. Cloudflare snapshots are limited to 1,900,000 UTF-8 bytes to leave metadata headroom under D1's row limit; larger snapshots receive `413 snapshot_too_large`. The separate request-body limit remains 2 MiB.

For an ordinary local Wrangler database, `npm run db:local:migrate` applies only local migrations. A direct Wrangler preview still enforces production hostname and authentication rules; use the separate synthetic preview fixture for interactive QA. A new cloud database starts empty. SQLite import, production migrations, domain/Access changes, and publication require a separately reviewed deployment plan. Preserve the current SQLite database until any migration is explicitly approved and verified.

Cloud data and local SQLite remain separate. [Deployment receipts and acceptance](cloudflare-deployment.md) record how the author's private installation was released, with account identifiers and hostnames redacted. Python clients encountering Cloudflare edge1010 should send a descriptive `User-Agent`, such as `SiftClient/1.0`.

## Sites packaging check

The repository also keeps a minimal static Sites packaging target (`worker/index.js`, `.openai/hosting.json`, `scripts/prepare-sites-build.mjs`). After `npm run build`, `npm run test:sites` checks that packaging only. It is not the production container, the persistent database or the access-proxy setup.
