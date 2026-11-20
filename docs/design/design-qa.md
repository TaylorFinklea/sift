# Design QA

final result: passed

## Comparison target and evidence

- Source visual truth: `option-1.png`, the first displayed and selected Product Design concept.
- Source pixels: 1487 × 1058. The analytical comparison normalizes it to 1440 × 1024, preserving its near-identical aspect ratio.
- Final implementation: `../qa/desktop-final.jpg`, 1440 × 1024 pixels, CSS viewport 1440 × 1024, device scale factor 1.
- State: dark theme, Personal Values card sort, round 2, 24 cards, 7 sorted, 4 of 8 keeps, Curiosity pending. The isolated fixture collection has a `Visual QA` suffix; that data label is an intentional difference.
- Full-view comparison: `../qa/desktop-comparison-final.jpg`, with source and browser capture in the same image.
- Focused typography/asset comparison: `../qa/card-focus-comparison.jpg`, source and rendered active-card regions together.
- Additional browser captures: `../qa/mobile-final.jpg` (390 × 844) and `../qa/tablet-final.jpg` (834 × 1194). Both match their CSS viewport at density 1. Initial captures made while resizing were replaced with settled captures and their pixel dimensions were checked.
- Offline browser evidence: `../qa/offline-desktop.jpg`.

## Findings and comparison history

1. Initial browser comparison (`desktop-before.jpg`, `desktop-comparison-before.jpg`) found P2 differences: undersized decision text and card definition, small generated ornament/brand image presentation, keep counter on the left, and an undersized central stage. Desktop typography, image sizing, stage geometry, card tilt, and counter placement were adjusted. The later full and focused comparison confirms the intended white-card/cyan-edge hierarchy and readable decision labels.
2. Initial phone capture (`mobile-before.jpg`) found P1 missing visible undo and keep count, plus redundant small and large decision controls. The phone now has one decision-button row and a visible keep count/undo row. Live Keep and Undo returned Curiosity to 4/8; all controls fit within 390 × 844 without horizontal overflow.
3. Source and browser checks found the active run could initially show another collection's name, and a completed round lacked a visible Undo action. The run now determines its own collection heading, and completed results include Undo last choice. Both were checked in the browser.
4. The first desktop footer adjustment accidentally put Undo on a second grid row. Explicit row placement fixes it. Final browser geometry places Undo at y=912–957 and the counter at y=901–968, inside the 1024px viewport. No primary control is clipped. A small ancillary footer continues below that viewport and remains reachable by scrolling.
5. Offline reload initially failed because the service worker's root request did not request HTML. The worker now sends `Accept: text/html`; cache v2 installs and activates. The browser verified the root shell and seven WOFF2 files in the cache, a disconnected reload, saved history browsing, disabled write controls, and online recovery.

No actionable P0/P1/P2 finding remains in the tested states.

## Required fidelity surfaces

- **Fonts and typography:** self-hosted Manrope and DM Mono; the main card has a bold display title and readable definition. Desktop decision labels now carry the source's hierarchy. Supporting metadata is intentionally quieter. Long titles wrap instead of overflowing.
- **Spacing and layout rhythm:** open dark base surface, three-part sorting stage, tilted ivory card stack, round trail, progress, centered Undo and right-side keep count. Desktop, phone, and tablet have no horizontal overflow. Phone uses one large decision row rather than duplicating desktop orbs.
- **Colors and tokens:** near-black/navy background, electric cyan edge/keep action, rose discard action, lime count/check, and ivory card. Text labels distinguish actions independently of color. Visible keyboard focus styling and reduced-motion rules are present.
- **Image quality and asset fidelity:** actual generated transparent raster wave and compass assets are used, with library icons for controls. No placeholder illustration substitutes remain. The generated compass has a star-like silhouette rather than the source's circular compass treatment; this is P3 polish, not a functional or hierarchy issue.
- **Copy and content:** collection and run labels reflect the saved state. Custom left/right labels survive creation and refinement. Subsequent completion uses “This round is in.” Results display every saved card, not a truncated five-item sample.

## Browser interactions verified

- Create and edit a collection, including bulk card entry and a custom Distraction label.
- Keep a card, undo it, and reload the saved run.
- Enforce a three-keep cap; the fourth Keep is disabled.
- Complete a four-card round with three keeps, then refine only those three cards with a two-keep cap.
- Read both rounds in history; editing the source collection does not rewrite the prior Focus card snapshot.
- Undo the final choice from completed results and complete that round again.
- Press D while Collections is displayed; returning to the sort leaves Curiosity and the 4/8 count unchanged.
- Press D in the active sort, observe the next card, then press Z and observe Curiosity and 4/8 restored.
- Use mobile Keep/Undo controls; inspect tablet control bounds.
- Parse the web app manifest with no errors; observe activated service-worker cache v2 and cached local fonts.
- Reload with browser networking disabled, browse cached history read-only, then restore networking and verify live controls recover.
- No warning/error messages were present in the final online console check. Browser networking and temporary viewport overrides were restored after testing.

## Implementation checklist

- [x] Compare source and render in one full-view image and a focused card comparison.
- [x] Resolve P0/P1/P2 findings and recapture the repaired implementation.
- [x] Verify the principal sorting and persistence flows in the actual browser.
- [x] Verify phone/tablet layout, offline read-only behavior, and online recovery.
- [x] Save final evidence and leave the local app running.

## Follow-up polish and limits

- P3: the generated compass silhouette, exact font metrics, internal card alignment, and subtle glow differ from the raster mockup. The selected layout and interaction hierarchy are preserved.
- Physical home-screen installation, real touch hardware, and a live access-proxy deployment were not tested. Manifest validation, service-worker installation/control, responsive browser behavior, and offline reload were tested locally.
