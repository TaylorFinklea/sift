import { ArrowRight, DownloadSimple, PencilSimple, Plus, Sparkle } from "@phosphor-icons/react";
import { exportTransfer } from "../lib/api.js";
import { transferFilename } from "../lib/transfer-ui.js";
import { dateLabel, keptCountFor, sortNewest } from "../lib/run-utils.js";
import Transfer from "../components/Transfer.jsx";

async function downloadCollection(item) {
  const archive = await exportTransfer(item.id);
  const blob = new Blob([JSON.stringify(archive)], { type: "application/json" });
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = transferFilename(item.name);
  link.click();
  URL.revokeObjectURL(href);
}

/** The library: every collection with its latest sort, plus import/export. */
export default function CollectionsView({ collections, runs, isOffline, busy, onImported, onNewCollection, onEditCollection, onStartRound, onOpenRun, onSelectCollection, onError }) {
  return (
    <section className="library-view">
      <div className="page-heading">
        <div>
          <h1>Collections</h1>
          <p className="page-heading__sub">Each collection is a deck of cards you can sort as often as you like.</p>
        </div>
        <button className="button button--cyan" type="button" onClick={onNewCollection}><Plus /> New collection</button>
      </div>
      <Transfer collections={collections} offline={isOffline} onImported={onImported} />

      {collections.length ? (
        <div className="collection-list">
          {collections.map((item) => (
            <CollectionRow key={item.id} item={item} runs={runs} isOffline={isOffline} busy={busy}
              onEditCollection={onEditCollection} onStartRound={onStartRound} onOpenRun={onOpenRun}
              onSelectCollection={onSelectCollection} onError={onError} />
          ))}
        </div>
      ) : (
        <div className="library-empty">
          <h2>No collections yet</h2>
          <p>Add a few cards, such as options, values or ideas, then sort them down to what matters.</p>
          <button className="button button--cyan" type="button" onClick={onNewCollection}><Plus /> Create a collection</button>
        </div>
      )}
      <div className="collections-hint"><Sparkle /> One idea per card makes your sort much easier.</div>
    </section>
  );
}

function CollectionRow({ item, runs, isOffline, busy, onEditCollection, onStartRound, onOpenRun, onSelectCollection, onError }) {
  const itemRuns = runs.filter((savedRun) => savedRun.collectionId === item.id).sort(sortNewest);
  const inProgress = itemRuns.find((savedRun) => savedRun.status === "in-progress");
  const previous = itemRuns[0];
  const cardCount = item.cards?.length || 0;

  const open = () => {
    onSelectCollection(item.id);
    if (inProgress) onOpenRun(inProgress);
    else if (previous) onOpenRun(previous);
    else onStartRound(item);
  };
  const exportItem = async () => {
    try {
      await downloadCollection(item);
    } catch (error) {
      onError(error.message || "The export could not be created.");
    }
  };

  return (
    <article className="collection-row">
      <button className="collection-row__main" type="button" onClick={open}>
        <span className={`collection-row__dot${inProgress ? " is-active" : ""}`} aria-hidden="true" />
        <span className="collection-row__details"><strong>{item.name}</strong><span>{item.description || `${cardCount} cards ready to sort`}</span></span>
        <span className="collection-row__count">{cardCount}<small>cards</small></span>
        <span className="collection-row__last">
          {inProgress ? <span className="status-pill"><span /> In progress</span>
            : previous ? `${previous.keptCount ?? keptCountFor(previous)} kept · ${dateLabel(previous.updatedAt || previous.createdAt)}`
              : "Ready when you are"}
        </span>
        <ArrowRight className="collection-row__arrow" />
      </button>
      <div className="collection-row__actions">
        <button className="icon-button collection-row__utility" type="button" aria-label={`Edit ${item.name}`} title={`Edit ${item.name}`} onClick={() => onEditCollection(item)}><PencilSimple /></button>
        <button className="icon-button collection-row__utility" type="button" aria-label={`Export ${item.name}`} title={`Export ${item.name}`} disabled={isOffline || busy} onClick={exportItem}><DownloadSimple /></button>
        {inProgress ? (
          <button className="button button--cyan collection-row__start" type="button" onClick={() => onOpenRun(inProgress)}><ArrowRight /><span>Resume</span></button>
        ) : (
          <button className="button button--cyan collection-row__start" type="button" onClick={() => onStartRound(item)}><ArrowRight /><span>Start sort</span></button>
        )}
      </div>
    </article>
  );
}
