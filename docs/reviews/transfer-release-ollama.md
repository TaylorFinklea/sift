# Independent release configuration review

Exact approved DeepSeek V4.1 Flash via Ollama, read-only, one request, think=false, normal stop. No material findings. Static plan review is not live release acceptance.

**No material P1/P2 findings.** Config/migration/version diff are internally consistent with the stated release plan and constraints.

Supporting notes (not findings):

- `0004_transfers.sql` is purely additive: three `CREATE TABLE IF NOT EXISTS` and two `CREATE INDEX IF NOT EXISTS`. `transfer_collection_versions.collection_id REFERENCES collections(id)` only adds an FK *on the new table*; it does not alter `collections`, existing rows, or FK definitions. Applying it before the new Worker is safe: old Worker doesn't reference these tables, and new Worker's read JOIN requires them to exist — ordering in the plan (migrate, then deploy) is correct.
- `ExportOptions.TestFlight.plist` `method=app-store-connect` matches the stated "validate-before-upload" flow; signed archive step must override `CODE_SIGNING_ALLOWED=NO` to `YES` at the command line (consistent with the plan and `project.yml` base setting). No contradiction with the base `CODE_SIGNING_ALLOWED: NO`.
- Entitlements: `aps-environment=production`, `icloud-container-environment=Production`, single container `iCloud.com.example.sift` — matches the authorized container. `CFBundleDocumentTypes`/`UTExportedTypeDeclarations` declaring `public.json` is an app-declaration only; it does not create public system type registration or schema changes, consistent with the "do not claim public type registration from CFBundle declarations" instruction.
- Version diff is minimal and matches build 1→2 intent: `TestFlight.xcconfig CURRENT_PROJECT_VERSION=2` and `SiftCloudProduction Debug CURRENT_PROJECT_VERSION="2"`. Release value inherits `2` from the xcconfig (Release config uses `Config/TestFlight.xcconfig`), and Debug is overridden to `"2"` so both configs are `2` — no stale `1` for the production target.
- ASC baseline: existing build1 `VALID`, `expired=false`, `INSTALLED` tester (provider state only), group `isInternalGroup=true`, `hasAccessToAllBuilds=false`, no public link, no Apple Silicon/Vision availability — all consistent with "attach only build2 to internal Personal without adding testers/expiring build1/enabling public/all-future/Mac/Vision". No build2 in baseline confirms "unused".
- Worker config: `workers_dev=false`, `preview_urls=false`, two `custom_domain` routes to the authorized hostnames, D1 binding to the authorized `b3573242-…` DB, assets `run_worker_first=true` — matches authorization; no DNS/Access/billing changes implied.

Caveats to keep explicit in the Sol gate (not findings, already stated in prompt): live deployment/readback, post-apply fingerprints, IPA signature/entitlement verification, Apple validation, upload/VALID, and IN_BETA_TESTING must be proven by actual artifacts — this static review does not attest them. Physical-device usability and live two-device convergence remain unverified.
