# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Card content feedback

Save collection includes card names still entered in the bulk box; Add cards is optional. Preserve draft inputs on validation failure and avoid duplicating names across Add and Save.

Each card may have an optional description, pros, and cons. Editing a collection must preserve these fields and stable card IDs; blank list rows are trimmed only when saving. Sorting cards with pros or cons should keep long content readable and scrollable.

## Desktop keyboard feedback

Use vim-style H for left/let go and L for right/keep, alongside the arrow keys. Keep Z for undo. Sort shortcuts must remain inactive while typing, in dialogs, and outside the sort view.

## Mobile and PWA feedback

Support left swipes to let go and right swipes to keep alongside buttons and desktop H/L. Vertical scrolling through long card context, interrupted touches and multitouch must not record choices. Keep limits and undo apply consistently across input methods. Offline use stays read-only; reconnect must refresh authoritative state before writes resume. Preserve optional card context and unsaved form inputs.

## Round plans and answer review

Each individual sort defaults to one round named Round 1. Round titles are customizable, future rounds can be added at any time, and each round may have a preset keep limit. Replace the hard-coded Good/Better/Best labels with the actual plan. Collections remain reusable independently of each sort's plan.

Make earlier choices easy to browse on mobile with filters and Previous/Next navigation. Changing a round after a later round has started creates a revised path; preserve the original rounds, decisions, card snapshots and later results. Keep limits apply to changes too.

Skip for now sends an undecided card to the end of the current round's queue, persists across devices/reloads, and does not change sorted counts or consume a keep. A skipped card returns after other pending cards.

Cards use a dark navy surface with readable light text. Dragging follows the finger directly with a slight tilt; green glow strengthens toward Keep and red toward Let go. Release beyond the threshold to commit, otherwise snap back. Preserve vertical context scrolling, cancellation/multitouch safety, reduced-motion support and desktop keyboard/button access.

## Compact mobile sorting feedback

Pin the app header while scrolling and keep the logo, status indicator, and navigation icons together on one row. Put the round trail beside the collection name on phones. Keep the active card and core sort actions in the first phone viewport when practical; let long card details scroll inside their card. Icon-only controls need clear accessible names and generous touch targets.

## Collection transfer feedback

Both website and native iPhone app support the shared versioned `.sift.json` file. Export one collection with recorded history or the whole library; preserve card details, historical snapshots, revised paths, named rounds, limits and pending order so sorting can continue. Preview import, skip identical data, and preserve conflicts as separate complete versions; never overwrite existing library data. Export from the authoritative server snapshot rather than the truncated offline cache. Deployment is a separate explicitly authorized release action; preserve production data and apply additive transfer storage before publishing code.

## Numeric card values and rating rounds

Owner approved numeric facts on cards and separate per-run rating answers. Scales have a custom name, minimum, maximum, step and optional unit; default Rating 0–10 step 1. Use a slider and exact number entry, leave unset values unanswered, and only record rating answers on explicit Save. Zero is a valid answer. Preserve Skip, Undo, mobile Review, immutable history and revised paths. A rating round retains every card for the next round; choice rounds pass only keeps. Started scales/types are immutable. Preserve v1 libraries and use explicit version gates for new semantics so older apps cannot silently drop numeric data. Implementation and local verification are authorized; live publication is a separate action.


## Mobile collection actions and rating plan forms

On collection cards, keep Start/Resume as the primary trailing action. Edit and Export are icon-only utility actions with accessible names, titles, and touch targets of at least 44px. In round editors, rating scale controls occupy a dedicated full-width section with responsive fields; keep-limit inputs retain a compact natural width. Avoid overlap and clipping at phone and tablet widths.
