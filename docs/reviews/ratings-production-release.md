# Numeric fields and rating rounds — Cloudflare production release

Reviewed web commit `c064394` is live on the existing `sift` Worker at `sift.example.com` and `api.sift.example.com`. Additive D1 migration `0005_ratings.sql` was applied first; deployment then completed successfully as `4b24de63-67d5-4a3f-af55-0785fccb49de`, Worker version `9dddd277-df60-4b19-8fc6-5c1e6ba6c1ca` at100%.

The exact approved plan and fresh owner-only pre-migration backup are recorded with hashes in the JSON receipt. All eight preexisting tables retain the same row counts and canonical full-row fingerprints. The prior58 decision rows have matching rows in `sort_answers`, equal on every shared field including `undone_at` and replacement links; no ID is missing or conflicting, legacy `rating_value` is null, and the foreign-key check is clean. No reconciliation write was needed.

The migration ledger lists0001–0005 with no pending migration. Anonymous requests to the main app and its JS asset redirect302 to the existing Access gate; the API returns401. The current OAuth profile did not provide Access-configuration read scope, so direct application/policy setting readback was unavailable. No Access or domain setting was changed. Build, Sites tests4/4 and the reviewed dry run passed.

The prior Worker version `fd7bae7e-2ffb-4277-b314-ae08c8e600e6` is a code-only containment target. Keep all schema and data on rollback. The old Worker writes decisions while this release reads/writes `sort_answers`; reconcile decisions before any re-upgrade if the old version received writes. Never restore the pre-release backup over newer production data.

The web app was not opened in an authenticated browser after deployment because browser automation was unavailable. Existing collection, run, decision and API-key content was preserved. Migration0005 added schema and backfilled those existing decisions into `sort_answers`; it created no card or API-key fixtures. DNS, Access policy, billing and the original SQLite database were not modified.

See [`ratings-production-release.json`](ratings-production-release.json) and owner-only logs/backups under ignored `.local/cloudflare-production/`.
