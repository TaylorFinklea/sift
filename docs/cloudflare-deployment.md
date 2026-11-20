# Sift Cloudflare deployment

Initial launch completed on 2026-11-01 under the approved `cloudflare-launch.md` plan. Initial runtime/frontend source was `f0825fc`; that launch changed no application code. Existing Workers Free billing and local SQLite were preserved.

## Current release — 2026-11-09 (collection actions and responsive round forms)

Owner-authorized UX source `b68635d` is deployed at https://sift.example.com and https://api.sift.example.com. Deployment `22ad010c-fd94-4ff5-bee0-9cd162695b52` serves Worker `d9887b38-1368-420e-9657-6c3b4c93cee2` at100% (2026-11-09T22:09:16Z). Primary Start/Resume is trailing, Edit/Export and library transfer actions are compact accessible icons, and round/rating forms resize without overlap. No migration or content write occurred.

All nine D1 table counts/full-row fingerprints match the secure preflight snapshot; FK0, ledger0001–0005 unchanged. Anonymous main/newasset302 and API401; config SHA256 remains `c907feb9ca19bb773ed400e5b8c90e1b09c45c35f119d1934af1a486ad1baf61`. Actual owner SSO loaded the new `/assets/index-BsB2V3GQ.js`. At390px the page/scroll widths are390, icons and trailing Resume fit. Phone and1024px future rating drafts show readable full-width fields with2/4-column bounds and reachable actions; cancelled without saving. Original16/18sorted and11/13keeps remain, console warnings/errors empty. Captures and sanitized evidence: `reviews/collection-ux-production-release.json`.

Release checks110/110, build, Sites4/4 and dryrun passed; independent Sol source/artifact/pre/post evidence review and normally completed DeepSeek V4.1 Flash release review passed. Wrapper summary failed after Wrangler success because zsh reserves `status`; actual deploy log and fresh provider100% state confirm success, with no repeat deployment. Rollback is same-schema code-only to `9dddd277-df60-4b19-8fc6-5c1e6ba6c1ca`, retaining all D1 data. Keep raw snapshots/config ignored0600. No DNS/Access/billing/API key/Git-push changes; detailed policy/domain mapping, physical Safari/PWA and representative CPU acceptance remain qualified. Release issue `sift-20u`.

## Previous release — 2026-11-09 (numeric card facts and rating rounds)

User-authorized reviewed source `c064394` is live on the existing `sift` Worker at both custom domains. Additive D1 migration `0005_ratings.sql` ran immediately before the deployment. Existing numeric collection facts and explicit rating answers are now supported by the site; export format v2 preserves cross-platform compatibility.

| Release | Identifier |
| --- | --- |
| Deployment | `4b24de63-67d5-4a3f-af55-0785fccb49de` |
| Healthy version at100% | `9dddd277-df60-4b19-8fc6-5c1e6ba6c1ca` |
| Previous version / code rollback target | `fd7bae7e-2ffb-4277-b314-ae08c8e600e6` |

The exact frozen release plan, plan hash, migration/config hashes, fresh pre-migration backup and sanitized deployment receipt are under `docs/reviews/ratings-production-release.*`. The owner-only D1 exports and logs are in ignored `.local/cloudflare-production/`, mode0600. The eight preexisting table row counts and canonical full-row hashes match after the release. All58 prior decisions are present in `sort_answers` with every shared field equal, including `undone_at` and replacement references; `rating_value` is NULL for legacy rows, with no missing IDs or conflicts. Foreign-key check is clean and the migration ledger contains0001–0005 with nothing pending. No repair write was needed.

Fresh anonymous checks still send main-app HTML and its JavaScript asset to the Access login (302); the external API returns401 without a bearer key. Wrangler's current OAuth scopes do not permit a direct read of Access app/policy settings; no Access, DNS, domain, API key or billing settings were changed. An authenticated owner browser was not available for post-deploy rendered UI acceptance. Local UI and build checks passed before release.

The prior Worker version is a code-only containment target. Keep migration0005 and all production data on rollback. Old code writes the `decisions` table while this version reads/writes `sort_answers`; if the old version ever receives writes, reconcile those rows before re-upgrade. Never restore the pre-release SQL over current production data or drop additive schema.

## Previous release — 2026-11-06 (portable collection and history transfer)

User-authorized source `07ff46c` is live at both existing domains. Additive D1 migration `0004_transfers.sql` ran before the Worker deployment; it adds canonical transfer records, collection-version mappings and idempotent receipt storage. Existing card details, snapshots, decisions, sort sessions and API keys were preserved.

| Release | Identifier |
| --- | --- |
| Deployment | `b471672c-10b5-4f6f-9cef-a6ffe817e304` |
| Healthy version at 100% | `fd7bae7e-2ffb-4277-b314-ae08c8e600e6` |
| Previous version / code rollback target | `2d722aad-786a-4833-b4fb-b0d8e35a9697` |

Actual deployment timestamp is `2026-11-07T03:16:35.031479Z` (November6,21:16 local time). The preflight backup's actual timestamp is `2026-11-07T03:07:29Z`; its retained filename has an older date label. Backup and post-release SQL export are mode0600 under ignored `.local/cloudflare-production/`. Independent Sol verified complete row/column equality across all five application tables:1collection/2runs/58decisions/2sessions/3keys. The three transfer tables remained empty, migration 0004 is in the ledger, no migrations remain pending and foreign-key check is clean. No production import, answer, key, DNS, Access, billing or local SQLite changes occurred.

The private config hash remains `c907feb9ca19bb773ed400e5b8c90e1b09c45c35f119d1934af1a486ad1baf61`; domain IDs and disabled workers.dev/preview flags are unchanged. Anonymous main requests redirect to Access; the API returns401 `api_key_invalid`. Existing-owner Google SSO loaded `/assets/index-DL6nZ1ni.js`, retaining the Focus sort at 16/18 sorted and 11/13 keeps. Collections shows Export library, Import file and per-collection Export. Actual export downloaded `sift-library.sift.json`:78,720bytes,1collection,105records; shared JS validation and native Swift codec/replay1/1 passed without importing into a device/cloud store. Browser console warnings/errors were empty. Native Sift Sorter 1.0(2) is separately available in the existing private Personal TestFlight group.

Build/Sites4/4 and Wrangler dry-run normal completion passed; its shell wrapper lost the numeric exit code after Wrangler's explicit `--dry-run: exiting now.` marker, so no numeric dry-run exit claim is made. One Worker race test had a transient response-body-read failure; its focused retry passed 1/1 and prior implementation aggregate/focused checks remain recorded. Migration/deploy each returned actual exit0. Independent Sol accepted pre/post evidence and the corrected rollback pointer; one completed DeepSeek release review found no material issues. See [sanitized release receipt](reviews/transfer-production-release.json) and [release review](reviews/transfer-release-ollama.md).

Retain additive 0004 and all data on code rollback. Rollback is code containment, not a restore; an older Worker cannot export records added through transfer. Never drop transfer tables or restore older SQL over newer user data automatically. Physical Files delivery, build2 device usability and live two-device CloudKit convergence remain unverified.

## Previous release — 2026-11-03 (compact mobile layout)

User-approved source `570c1c4` is deployed to the existing `sift` Worker and both existing domains. Mobile navigation is a pinned row of icons with visible status, the current round sits beside the collection name, and the card/actions use the available phone height. This release required no migration or database/content writes. Authentication, domain bindings, Free billing and original SQLite were preserved.

| Release | Identifier |
| --- | --- |
| Current deployment | `7374b96b-7c09-4639-8e1c-ac9aba8b7217` |
| Current healthy version | `2d722aad-786a-4833-b4fb-b0d8e35a9697` |
| Previous version / code rollback target | `2b7d5461-7777-4e44-8cb7-9e291061e15b` |

The provider timestamp is `2026-11-04T01:26:41.03777Z` (November3,19:26 local time). The current deployment is selected by maximum `created_on`, independent of list ordering, and serves the new version at 100%. Private config SHA256 remains `c907feb9ca19bb773ed400e5b8c90e1b09c45c35f119d1934af1a486ad1baf61`, mode0600. The release build/Sites packaging and Wrangler dry run passed. Independent read-only Sol verified the target, unchanged backend/schema/auth, preflight and post-release receipt; the layout had already passed10 focused gesture/session tests, extensive isolated browser QA and independent source review.

All five complete D1 table fingerprints matched before and after deployment: 1 collection,2 runs,58 audit decisions,2 sort sessions and3 keys. No migration is pending or was applied. Both exact domain IDs still map to `sift`; workers.dev and preview URLs remain disabled. Anonymous and forged main requests and exact new-JS requests redirect to Access. API without bearer credentials returns JSON401 `api_key_invalid`. No keys or card fixtures were created and no real answers were changed for verification.

Owner acceptance loaded `/assets/index-DmdzOVua.js`, retaining the in-progress18-card sort at16sorted/11keeps out of13. At390x700, page/root height is700 and the actions end at688; the prior page height was843 with actions below the viewport. Header height changed91 to53px, all three navigation icons have44px targets and status remains visible. At320x568, page/root height is568 and actions end at556. Review/Next opens a296px-wide dialog without horizontal overflow. API-key icon navigation works; at scrollY549 the header remains at top0 with visible status. Console warnings/errors were empty. Phone viewport and Review/navigation checks were read-only; swipe/Skip/answer writes were exercised only in the earlier isolated QA. Physical iOS Safari/PWA installation and representative Free CPU capacity remain unverified.

Sanitized private receipt: `.local/cloudflare-production/release-570c1c4.json`, mode0600, SHA256 `91f001f75c1fe7b55073fdd9f9ec2cb6b08fc9369235350d931b6ef77af0d99d`. It includes explicit before/after fingerprints. Live screenshot: `/private/tmp/sift-compact-deployed-mobile.png`. No new backup was needed for this code-only release; the secure pre0003 backup and prior receipts remain intact. Roll back code to the previous version above if needed, retaining D1 and additive schema0003; never automatically restore old data over newer user changes.

## Previous release — 2026-11-03 (round plans)

User-approved source `a17577d` is deployed to the existing Worker and both existing custom domains. This includes the pending-card-name save fix, per-sort round plans, mobile answer review with preserved revised paths, persistent Skip, and dark finger-following cards. Only additive D1 migration `0003_sort_sessions.sql` was applied. Existing data, SQLite, Free billing, domain bindings, Access policy and API-key state were preserved.

| Release | Identifier |
| --- | --- |
| Current deployment | `02853707-9dd0-45c7-a412-988a675cc61e` |
| Current healthy version | `2b7d5461-7777-4e44-8cb7-9e291061e15b` |
| Previous version / code rollback target | `995a45b6-a95e-4ec4-b743-85b2fff923b4` |

The exact private config SHA256 remains `c907feb9ca19bb773ed400e5b8c90e1b09c45c35f119d1934af1a486ad1baf61`. Fresh account/deployment/domain/disabled-dev-preview readbacks, the release build and Wrangler dry run passed. Independent read-only Sol verified the reviewed source hashes and restored the secure D1 export locally: applying committed migration0003 preserved every legacy field and passed foreign-key/session/queue checks. The runtime already had a completed independent Sol and direct `glm-5.3-flash:cloud` review; no runtime source changed for release.

The pre-migration D1 export is ignored at `.local/cloudflare-production/pre-0003-20261103.sql`, mode0600, 19,343 bytes, SHA256 `f1b7f83c69f7157fbf3bc2eeb13d449c747e7003c79eb55491fddc09085e1b46`. Post-release fingerprints of every pre-existing field in collections, runs, decisions and API keys matched exactly: 1 collection, 1 run, 42 audit decisions, 3 keys and 0 active keys. The migration created 1 sort session; no missing sessions, foreign-key violations or pending-queue mismatches remained, and no migration is pending. No reconciliation or production card/key fixture writes were needed.

Live acceptance: the authenticated owner loaded `/assets/index-DpVmhP-X.js` with the existing 18-card completed round and 12 keeps intact. The single Round1 plan, 390px answer review filters/Next, navy card gradient/light text and a draft optional second round were visible; the draft was cancelled without saving. Review dialog width/scrollWidth both366px; console warnings/errors and Chromium installability errors were empty. Anonymous and forged-identity main requests redirected to Access; missing-bearer API returned JSON401 `api_key_invalid`. Both original domain IDs and disabled workers.dev/preview flags were unchanged. No new production sort/revision/skip writes or physical-device installation were exercised; those flows passed isolated pre-release QA. This release adds no representative production CPU headroom claim.

Sanitized release receipt: `.local/cloudflare-production/release-a17577d.json`, mode0600, SHA256 `a70cbff01a316c098c3a93828792fdac00519864a759979f3bb45aefcaa49e19`. Live mobile screenshot: `/private/tmp/sift-rounds-deployed-mobile.png`. Provider metadata command `wrangler d1 info` returned auth10000, while the necessary D1 query/export/migration operations and known-account Worker readbacks succeeded.

For code rollback, retain the additive D1 schema and all data. The old Worker can still read the schema, but writes made by old code can lack new sort-session links; verify/reconcile those legacy links before re-upgrading. Code rollback is containment, not a database restore. Do not drop new columns/tables or import the backup over current user data without a separate recovery decision.

## Previous release — 2026-11-02

Reviewed runtime/frontend commit `784799d` is deployed to the existing Worker and both existing custom domains. No migration, database write, Access-policy change, domain/billing change or local SQLite change was made.

| Release | Identifier |
| --- | --- |
| Current deployment | `bf6565b5-2302-4601-96c5-80b24e9b6836` |
| Current healthy version | `995a45b6-a95e-4ec4-b743-85b2fff923b4` |
| Previous version / code rollback target | `02763abf-3402-466f-bca7-bf4cf1318c61` |

The production config SHA256 remains `c907feb9ca19bb773ed400e5b8c90e1b09c45c35f119d1934af1a486ad1baf61`. A fresh provider/config/build/dry-run check passed independent Sol review before upload; post-release receipts and this handoff received independent read-only Sol review. The CPU patch already had a completed direct text-only `glm-5.3-flash:cloud` review; the deployed source is unchanged from that reviewed local commit.

Release acceptance: actual owner app loads `/assets/index-BjYgNmNQ.js` and its APIs without console errors; HTML includes credential-aware manifest fetching. Anonymous main HTML and the exact new JS asset redirect to Access; forged identity is also redirected. Missing bearer requests on the API return JSON 401 without an Access redirect. Both original domain binding IDs and disabled workers.dev/preview flags were read back unchanged. Before/after D1 aggregates matched: 0 collections/runs/decisions, 3 keys and 0 active keys; the verification SELECTs wrote zero rows. No verification keys or card fixtures were created.

The live 390-pixel header fits all three navigation tabs and the install button. Chromium reports no manifest/installation errors. The first manifest read came from the older service-worker cache; after the normal service-worker update and reload, the new maskable icon was present. No storage was cleared. Physical device installation and live sort writes remain untested; swipe/offline behaviors passed the prior isolated local QA.

A short immediately post-deploy smoke window, **2026-11-02 19:52:34–19:54:51 UTC**, returned 34 requests, 0 errors, 31 subrequests, CPU P50 1768µs and P99 9059µs (~9.1ms). This aggregate is not version-segregated or a matched comparison with the initial smoke window; it establishes neither a speedup nor representative Free-plan headroom.

The sanitized release receipt is ignored at `.local/cloudflare-production/release-784799d.json` (0600; SHA256 `172925fe9da3073c5a059fe1eed199335fc9df70e9a0f43cbd0e8ab3b4b9d33e`). Initial launch receipts remain intact. Live screenshot: `/private/tmp/sift-deployed-mobile.jpg`.

## Initial live resources

| Resource | Identifier |
| --- | --- |
| Owner app | https://sift.example.com |
| External bearer API | https://api.sift.example.com |
| Account | TaylorFinklea / `<redacted-account-id>` |
| Zone | example.com / `<redacted-zone-id>` |
| Worker | `sift` |
| Initial deployment | `951d3ca0-1f01-40f0-9cef-9d88b7296d4a` |
| Initial healthy version | `02763abf-3402-466f-bca7-bf4cf1318c61` |
| Dedicated D1 | `sift` / `<redacted-d1-id>` |
| Access app | `<redacted-access-app-id>` |
| Sift owner-only policy | `<redacted-access-policy-id>` |
| Main domain binding | `<redacted-domain-binding-id>` |
| API domain binding | `<redacted-domain-binding-id>` |

The main app has whole-host Access protection with an exact-owner Allow policy and 24-hour session. Its signed JWT issuer/audience/email are also verified by the Worker. The API hostname uses bearer keys without an Access login gate. `workers.dev` and preview URLs were read back as disabled. Both Custom Domain bindings point to `sift` in the intended production zone; TLS verifies for both.

Deployment-specific config and receipts are ignored in `.local/cloudflare-production/` with mode 0600. Use the exact `.local/cloudflare-production/wrangler.jsonc` for any separately authorized future dry-run/deploy/migration; the public template remains unconfigured. The private owner email and Sift audience stay in local config/Access. No API secret is stored in these receipts.

## Initial launch acceptance

- Anonymous and forged-identity main HTML and exact JS-asset requests redirect to the Access login hostname; the owner browser loads the app and its same-origin API successfully.
- API requests without credentials return JSON 401 `api_key_invalid` without Access redirection for default curl/Node clients and Python with `User-Agent: SiftClient/1.0`.
- A real read-only key generated through the main app returned 200 on collections, 403 `read_only_key` on a write attempt, and 404 on API key administration. After revoking that same key in the app, its next API request returned 401. Key metadata and revocation survived reload; no secret dialog remained and browser console was clean.
- All 3 temporary verification keys are revoked. Final D1 reads showed 0 collections,0 runs,0 decisions and 0 unrevoked keys. No production card fixture or local data import occurred. Full key values stayed in transient memory; the API client received a key through a mode 0600 memory-only FIFO, never a regular file, command argument, screenshot or log. Initial test-harness transport attempts did not complete the revocation phase and were not counted as passing; the final same-key sequence completed successfully.
- The existing SQLite preview/database was not changed by launch. Creating and saving the user's first intended collection and physical device PWA installation remain user follow-ups, rather than unperformed checks claimed here.

## Observed limits and follow-up

The initial last 30 minutes metric snapshot contained 74 Worker requests and 0 invocation errors, CPU P50 1515µs and P99 14309µs (~14.3ms). This is a small smoke sample, not a capacity guarantee. [Cloudflare documents a 10 ms Free CPU allowance with occasional-overrun flexibility](https://developers.cloudflare.com/workers/platform/limits/#cpu-time); monitor representative use before treating Free-plan capacity as qualified. No paid upgrade was made or authorized.

Python's default urllib User-Agent received the existing Cloudflare edge 1010 `browser_signature_banned`; a truthful descriptive `SiftClient/1.0` agent worked. No zone-wide browser-integrity, WAF, or Access settings were weakened. Clients encountering that edge response should identify themselves with a descriptive User-Agent.

Retain D1 during any code rollback. The healthy Worker version above is now a rollback target; code rollback does not restore database contents. Future production changes, imports, billing decisions or broader policy changes require their own scope/approval.
