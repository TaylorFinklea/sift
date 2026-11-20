# Cloudflare launch plan

Status: the user approved this initial launch and it completed on 2026-11-01. See `cloudflare-deployment.md` for receipts, live acceptance and observed limits. The preflight below records the state before creation. Runtime/frontend source is `f0825fc`; no billing change or SQLite import occurred.

## Verified preflight targets (before creation)

| Item | Verified value |
| --- | --- |
| Account | TaylorFinklea — `<redacted-account-id>` |
| Zone | Active `example.com` — `<redacted-zone-id>` |
| Worker | New `sift`; no existing script/custom-domain binding with this target |
| D1 | New dedicated `sift`; no existing database with this name; 7 account databases currently exist |
| Main hostname | `sift.example.com`; no matching DNS record or Access application |
| API hostname | `api.sift.example.com`; no matching DNS record or Access application |
| Access issuer | `https://TEAM.cloudflareaccess.com` |
| Owner identity | The single email confirmed in the signed-in account and existing owner-only policy; keep its value in ignored deployment configuration |
| Access pattern | Existing private app uses Allow / Include exact owner email and a 24-hour app session |
| Account-wide Access default block | Off; no matching wildcard Access application was present in the complete 11-app inventory |
| Workers plan | Free; no upgrade or billing change proposed |
| Zone TLS mode | Full; no zone-wide TLS setting change proposed |

Wrangler OAuth can read Workers, Custom Domains, zone identity and D1, but DNS-record/zone-setting and Access-organization reads returned permission errors. Its Access-app listing incorrectly appeared empty compared with the signed-in dashboard's 11 applications, so the dashboard is authoritative for this review. A separate browser tab was used without taking over another task's tab. The DNS dashboard search found no records containing `sift`; the zone Worker-routes list is empty. Do not reuse a token registered to another repository or create broader credentials for this launch.

## Approved initial-launch actions (executed)

1. Recheck account and exact target names immediately before writing. Stop if another `sift` resource or hostname record appeared; do not overwrite or adopt it automatically.
2. Create a separate self-hosted Access application **Sift** covering the entire `sift.example.com` hostname, with a dedicated **Sift owner only** Allow policy for the verified exact owner email and 24-hour app session. Preserve other applications, policies, identity providers, MFA and account-wide settings. Record the new app's own audience; never reuse another app's audience. Do not create an Access login gate on the API hostname.
3. Create the dedicated D1 **sift** and record its returned UUID. Do not apply migrations using the placeholder template. The user confirmed an empty cloud library while preserving SQLite. No existing SQLite or other D1 data is changed or imported under this proposal.
4. Generate an ignored local production config from the reviewed template, with the exact account ID, returned D1 UUID, issuer, new Sift audience and confirmed owner email. Keep public source free of the owner email and deployment-specific private metadata. Preserve `workers_dev:false`, `preview_urls:false`, compatibility date `2026-08-06`, `run_worker_first:true`, and the production entry `cloudflare/index.js`. Production must never use the synthetic preview script or fixture credentials.
5. Build and dry-run that exact production config and inspect its DB/ASSETS and host bindings. Then run `wrangler d1 migrations apply sift --remote --config <generated-production-config>` against the recorded new UUID, applying only `0001_core.sql` and `0002_api_keys.sql`, before deploying Worker **sift** with only the two named Custom Domains. Record the resulting Worker version/deployment ID and each newly created Custom Domain binding ID, hostname, service and zone; capture any partial creation on failure through a fresh domains listing. Store these deployment receipts in ignored local state for acceptance and exact rollback targeting. Cloudflare provisions their DNS and certificates; the API's multi-level hostname is supported without a separate Advanced Certificate Manager subscription. Do not alter unrelated zone records/routes or upgrade the Free plan.

## Acceptance and failure handling

- Verify TLS for both exact hostnames after certificate activation. Anonymous main app HTML, JS/assets and API must require Access; forged identity headers must not grant access. The owner must be able to load the app, its same-origin API and the key-management screen.
- The API hostname must return JSON 401 without a bearer key, without an Access sign-in redirect. A newly created read-only key can read but cannot mutate data or manage keys; revocation is effective for subsequent requests. Never print or save its full value to logs, tracked files, command arguments, screenshots or browser-library cache. Keep the generated value only in transient memory for verification and revoke it afterward.
- Confirm the fresh library is empty and D1 key metadata survives reload. Existing SQLite, container and local preview stay untouched. Do not add/delete production card collections as an implicit acceptance fixture; a real collection save can be verified with the user's first intended collection, or through a separately approved disposable-data check.
- Observe live errors and CPU/quota behavior on the existing Free plan. Any paid upgrade requires a separate decision; do not silently change billing.
- On failed acceptance, stop opening traffic and keep the owner Access gate. Preserve D1 and SQLite; do not reverse migrations or delete databases. For this first release there is no prior healthy Sift version to roll back to: remove only the newly created Sift Custom Domain bindings if needed to return to the pre-launch routing state, after rechecking their recorded IDs/hostnames. Retain the Worker, D1 and Access app for diagnosis. Custom Domain certificate cleanup is separate and must not touch unrelated certificates. Future code rollback can use a recorded healthy Worker version, and does not roll back D1 data.

## Evidence and authorization boundary

Read-only account metadata was obtained through existing Wrangler OAuth and the signed-in Cloudflare dashboard. Current source already passed the local Workerd/D1 and browser/security review milestone; H/L changes passed focused tests, build, browser checks and independent Sol review. Live acceptance is recorded separately in `cloudflare-deployment.md`.

The user confirmed fresh D1 with SQLite preserved and explicitly approved the concrete initial-launch actions, including scoped routing rollback if required. That approval has been executed; future production changes need a new scope. No push, broader credential provisioning, paid upgrade, SQLite import, or unrelated Cloudflare change is included.

Official references: [Custom Domains and certificates](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).
