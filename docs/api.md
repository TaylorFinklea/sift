# Sift HTTP API

Both runtimes, the Node + SQLite container and the Cloudflare Worker + D1, serve the same JSON API.

Every successful API call returns a JSON object. Failures use `{ "error": { "code": "...", "message": "..." } }`. Browser writes must send a same-origin `Origin` header. Keep the current `revision` and pass it as `expectedRevision` for decisions, revisions, skips and undo; use `planRevision` as `expectedPlanRevision` for plan changes. Stale writes return `409 revision_conflict` so a second tab or device cannot silently overwrite a newer sort.

| Method and path | Request | Response |
| --- | --- | --- |
| `GET /api/health` | — | `{ ok, storage }` |
| `GET /api/capabilities` | Main app only | `{ apiKeys, apiBaseUrl? }`; container returns `apiKeys: false` |
| `GET /api/collections` | — | `{ collections: Collection[] }` |
| `POST /api/collections` | `{ name, description?, keepLabel?, discardLabel?, cards: [{ id?, text, detail?, pros?: string[], cons?: string[] }] }` | `201 { collection }` |
| `GET /api/collections/:id` | — | `{ collection }` |
| `PUT /api/collections/:id` | Collection fields and the `expectedUpdatedAt` timestamp from the opened version | `{ collection }` or `409 revision_conflict` when another device saved first |
| `GET /api/runs?collectionId=:id` | — | `{ runs: Run[] }` |
| `POST /api/runs` | `{ collectionId, keepLimit, rounds?: [{ title, keepLimit?: number or null, ratingScale? }] }` | `201 { run }`; default one Round 1 |
| `POST /api/runs` | `{ parentRunId, keepLimit? }` | `201 { run }` using the parent's kept cards (every card after a rating round); an omitted limit uses its saved preset |
| `GET /api/runs/:id` | — | `{ run }` |
| `POST /api/runs/:id/decisions` | `{ cardId, choice: "keep" or "discard", expectedRevision }`, or in a rating round `{ cardId, choice: "rating", value, expectedRevision }` | `{ run }` |
| `POST /api/runs/:id/undo` | `{ expectedRevision }` | `{ run }` |
| `PATCH /api/runs/:id/plan` | `{ rounds: [{ title, keepLimit: number or null, ratingScale? }], expectedPlanRevision }` | `{ run }`; preserves started rounds and their actual keep limits |
| `POST /api/runs/:id/skip` | `{ cardId, expectedRevision }` | `{ run }`; moves a pending card to the queue tail |
| `POST /api/runs/:id/revise` | `{ cardId, choice: "keep", "discard" or "rating", value?, expectedRevision }` | `{ run }`; may return a new run/session when later results exist |
| `GET /api/transfers/export?collectionId=:id` | `collectionId` optional; omit it to export the whole library | `{ archive }` in the [`.sift.json` format](transfer-format.md) |
| `POST /api/transfers/preview` | `{ archive }` | `{ previewToken, summary }` with duplicate and conflict counts |
| `POST /api/transfers/import` | `{ archive, previewToken }` | Adds new collections and history; never overwrites existing data. `409 transfer_changed` if the library changed after preview |

A card needs a unique stable ID within its collection and a title. Its optional `detail` is the description (up to 500 characters); `pros` and `cons` are optional lists of up to 10 non-empty items each, with each item up to 200 characters. Older collections and run snapshots without these lists are returned with empty lists. Collections need between 2 and 500 cards, and each JSON request is limited to 2 MiB (17 MiB for transfer preview and import); requests over the limit are rejected. A run exposes `status`, `keepLimit`, `keptCount`, `discardedCount`, `revision`, its fixed card snapshot, and ordered `decisions`. Undone decisions stay in the history with `undoneAt` set, while an undo changes the revision. The server rejects a keep that exceeds the limit. A new round requires a completed parent and at least two cards to carry forward: its keeps, or every card after a rating round. Editing a collection never changes earlier sort snapshots.

Runs also expose `sortId`, `roundTitle`, `roundPlan`, `planRevision`, `revisesRunId`, `hasLaterResults`, and the pending card-ID `queue`. Decision audit rows include `replacesDecisionId`. Follow the returned run after a revision: a revised path has a new run/session ID and retains its source through `revisesRunId`. Changing a plan or starting a later round can advance `planRevision`. Plans allow 1–50 rounds with titles of 1–60 characters; future keep presets may be empty, but a first round that is not a rating round requires a keep limit. Starting a later round validates its preset against the cards actually kept in its parent.

The additive `0003_sort_sessions.sql` D1 migration adds sessions, queue/revision metadata, and audit links while preserving existing card snapshots and decisions. Apply it only under a separately approved production release; SQLite adds the same fields on startup. Local legacy migration tests exercise populated parent chains and differing historical branch caps with foreign keys enabled.

## Numeric values and rating rounds

Collections may define up to eight `numericFields` (`{ id, name, minimum, maximum, step, unit }`), and cards may carry `numericValues` keyed by field ID. A round in the plan becomes a rating round when it has a `ratingScale` (`{ name, minimum, maximum, step, unit }`); its `keepLimit` is `null`. Rating decisions use `choice: "rating"` with a numeric `value`, zero included; keep/discard decisions never carry a value. Runs expose `ratingScale` and a `numericFields` snapshot. The full cross-runtime contract is in [ratings-contract.md](ratings-contract.md).

## Cloudflare-only endpoints

On the Cloudflare runtime, `GET /api/capabilities` reports `apiKeys: true` with the bearer API host, and the main app can create, list and revoke API keys under `/api/keys`. Bearer keys used against the API host can read data, or read and write it, but can never manage keys. See [self-hosting](self-hosting.md#cloudflare-workers-and-d1).
