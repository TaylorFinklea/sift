# Numeric values and rating rounds — local verification

Numeric card facts and per-round scores are separate. Collections define optional stable-ID fields; sorts retain immutable field/value snapshots. Rating rounds explicitly save answers, distinguish zero from unset, support Skip/Undo/Review and preserve revised paths, and pass all cards to their next round. Started round types/scales remain fixed. Card/answer values must lie on a finite configured grid.

SQLite uses an additive answer store, retains the original decision audit, and creates/copies/backfills the new store transactionally with retryable recovery. D1 migration0005 was subsequently applied to the existing production database on2026-11-09; see `ratings-production-release.md` and its receipt. The manual archive reads v1 and v2, gates new semantics at v2, validates every card revision including unused revisions, and preserves valid original payload bytes. Numeric conflict copies remap field IDs and value keys. The v2 native remapper uses a local JavaScriptCore context with a trusted static sorted-tree/stringify function and JSON passed as data; it has no host/network bridge or file-content evaluation and fails closed. The released v1 serializer is unchanged.

## Evidence

- Website full suite110/110 and production/Sites build passed. Browser page identity, meaningful content, no error overlay and empty warn/error console checked. Actual create/edit values, zero/off-grid save, Skip, Undo, replacement Undo, score ordering, rating-to-choice all-card continuation and preserved earlier-round revisions passed. Historical Cost80 remained after editing and clearing the collection value. Phone375x667 and390x844 and desktop1280x800 checked; temporary viewport override reset. Owned3994 restarted against final source, preserving synthetic data and old3993.
- Native Core31/31; hosted persistence/outbox/rollback/disk reopen3/3; updated v2 remap1/1 and existing v1 remap1/1. The actual UI case1/1 passed decimal keystrokes, negative entry, clearing, Skip, choice-to-next setup, two rating scales, Review identity/reset/reorder, revised scores, Undo and termination/relaunch. XCTest wrapper zero-test lines in hosted logs are not the result: the Swift Testing summaries show actual executed cases.
- Seven remapped cross-runtime record envelopes and payload bytes match exactly, covering all four kinds,0.1,0.3,0.000001, zero, timestamps, numeric field UUID keys, literal UUID text and retained integer-like keys. Real synthetic browser and mixed legacy-upgrade archives passed native codec/replay.

## Independent reviews

Independent read-only Sol reviewed the current source, all22 native source hashes, actual logs/screenshots and fresh byte comparison; no material code issues remain. Fixes include historical field snapshots, future-rating version gates, structural scale equality, case-folded UUID validation, native precise-entry and Review identity handling, retryable SQLite migration and every-card numeric validation.

The initial DeepSeek V4.1 Flash Ollama attempt was incomplete (done_reason length) and receives no approval credit. A narrower unused-card validation gap found during source checks was fixed and regression tested in both apps. On 2026-11-09 the owner authorized full relevant repository context and a retry without a narrow scope approval. The retry covered all41 final runtime/test files (425,872bytes), terminated normally with done_reason stop and explicitly concluded no confirmed material P1/P2 findings. Independent Sol checked the report's explicit retractions against source and verified all41 hashes; no changes were needed. See ratings-ollama.md and ratings-ollama-complete.json. The prepared narrow packet was superseded without dispatch.

The local3994 server was restarted using its preserved synthetic database on 2026-11-09. HTTP HTML, final bundle and health were rechecked. Fresh browser automation was unavailable because the native Computer Use pipe was missing; previous browser/Simulator visual evidence remains the recorded qualification.

## Limits

The native UI check used a portrait iPhone17e Simulator. No fresh native landscape, accessibility-size, other-device, physical-device or live CloudKit qualification is claimed. One unattributed SwiftUI `Invalid frame dimension (negative or non-finite)` warning occurred during keyboard appearance (UI log264); assertions and visible layout passed. Its cause is not established. No TestFlight upload or Git push occurred as part of the local verification milestone. The website release followed on2026-11-09; see `ratings-production-release.md`.

Machine-readable hashes and local evidence paths are in ratings-verification.json. Screenshots and synthetic archive contents remain outside Git.
