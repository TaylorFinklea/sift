# Using Sift

## Sorting and reviewing

Each sort starts with one round named Round 1. Name additional rounds and optionally preset their keep limits before starting, or use Edit rounds to add future rounds later. Round plans belong to the individual sort, so a collection can be reused with a different plan.

Drag a dark card left to let go or right to keep; the card follows your finger with red or green feedback. Short drags snap back, and long descriptions/pros/cons scroll vertically. Buttons work on mobile and desktop; H/Left lets go, L/Right keeps and Z undoes when no form or review dialog is open.

Skip for now moves a card to the end of the pending queue without counting an answer or using a keep. Review answers lets you filter, browse Previous/Next, and change earlier choices. If later rounds already exist, changing an earlier answer starts a revised path and preserves the old results. Undo restores the prior choice when undoing a revision. Existing keep limits still apply, and offline use remains read-only.

## Transfer between website and iPhone

In Collections, export one collection or choose **Export library**. The `.sift.json` file includes card details, recorded sort history, alternate paths, round plans, and unfinished progress. On iPhone, save the file to Files and choose **Settings → Library transfer → Import .sift.json**, or open the file with Sift. Review the preview, then add it to the current device-only or private iCloud library. The iPhone app can export the same format back to the website.

Imports add data and preserve existing collections. Identical data is skipped; conflicting copies remain separate versions. The website requires a connection to its server for transfer. Files contain library content, so store and share them as you would other personal backups. API keys and account credentials are excluded.

The archive limit is 16 MiB, 100 logical collections, and 20,000 immutable records. Larger or incomplete libraries fail explicitly rather than silently dropping history. See the [format and compatibility rules](transfer-format.md). Cloudflare requires the additive `0004_transfers.sql` migration before deploying this feature; production migration and deployment are separate release actions.

## Numeric values and rating rounds

Collections can define up to eight optional numeric card fields, such as cost, weight, or priority. Each field has a name, minimum, maximum, step, and optional unit. Open a card's details to enter a value with the slider or exact number entry; leaving it blank keeps it unset. Values of zero are supported.

In a sort's round plan, choose **Rate each card** and configure its scale. Adjusting the slider is a draft; **Save rating** records the score and advances. Skip, Undo, and answer review remain available. Results can be ordered high to low or low to high. A rating round passes every card to its next round; a keep/discard round passes only keeps. Started round types and scales are fixed, and changing an earlier answer preserves later results on the original path.

Card facts and round scores are separate, and historical sorts retain their own field definitions and values. Numeric data uses version 2 `.sift.json` archives; current readers also accept version 1 files. Older app versions reject version 2 files, so update both apps before transferring numeric collections. This local feature does not by itself publish a website or TestFlight update.
