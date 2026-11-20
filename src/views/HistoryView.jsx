import { ArrowLeft, ArrowRight, ClockCounterClockwise } from "@phosphor-icons/react";
import { roundTitleFor } from "../lib/sort-session.js";
import { activeDecisions, dateLabel } from "../lib/run-utils.js";
import { groupRunsBySort } from "../lib/history.js";

/** Every saved sort, newest activity first, with its rounds and links to resume, review or continue. */
export default function HistoryView({ runs, collections, selectedCollection, onOpenRun, onReview, onRefine, onStartRound, onCollections }) {
  const groups = groupRunsBySort(runs);
  return (
    <section className="library-view history-view">
      <div className="page-heading">
        <div>
          <h1>History</h1>
          <p className="page-heading__sub">Every sort you’ve started, newest first. Earlier answers stay as they were.</p>
        </div>
        <button className="text-button" type="button" onClick={onCollections}><ArrowLeft /> Collections</button>
      </div>
      {groups.length ? (
        <div className="history-list">
          {groups.map((group) => (
            <HistoryGroup key={group.key} group={group} collection={collections.find((entry) => entry.id === group.rounds[0].collectionId)}
              onOpenRun={onOpenRun} onReview={onReview} onRefine={onRefine} />
          ))}
        </div>
      ) : (
        <div className="history-empty">
          <div className="history-empty__icon"><ClockCounterClockwise /></div>
          <h2>No sorts yet</h2>
          <p>Each sort you start appears here with its rounds and results.</p>
          <button className="button button--cyan" type="button" onClick={() => selectedCollection ? onStartRound(selectedCollection) : onCollections()}>
            {selectedCollection ? "Start sorting" : "View collections"} <ArrowRight />
          </button>
        </div>
      )}
    </section>
  );
}

function HistoryGroup({ group, collection, onOpenRun, onReview, onRefine }) {
  const first = group.rounds[0];
  const revised = group.rounds.some((run) => run.revisesRunId);
  const headingId = `history-${group.key}`;
  return (
    <section className="history-group" aria-labelledby={headingId}>
      <header className="history-group__heading">
        <h2 id={headingId}>{collection?.name || "Collection"}</h2>
        <span>{revised ? "Revised path, started" : "Started"} {dateLabel(first.createdAt)}</span>
      </header>
      {group.rounds.map((run) => (
        <HistoryRow key={run.id} savedRun={run} onOpenRun={onOpenRun} onReview={onReview} onRefine={onRefine} />
      ))}
    </section>
  );
}

function HistoryRow({ savedRun, onOpenRun, onReview, onRefine }) {
  const savedDecisions = activeDecisions(savedRun);
  const savedKept = savedDecisions.filter((decision) => decision.choice === "keep").length;
  const complete = savedRun.status === "complete";
  const rating = Boolean(savedRun.ratingScale);
  return (
    <article className="history-row">
      <div className="history-row__main">
        <strong>{roundTitleFor(savedRun)}</strong>
        <span>{rating ? `Rated on ${savedRun.ratingScale.name}` : `Keep up to ${savedRun.keepLimit}`}</span>
      </div>
      <span className={`history-status ${complete ? "history-status--complete" : ""}`}><span /> {complete ? "Complete" : "In progress"}</span>
      <div className="history-row__count">
        <strong>{rating ? savedDecisions.length : savedKept}</strong>
        <span>{rating ? `of ${savedRun.cards.length} rated` : `of ${savedRun.cards.length} kept`}</span>
      </div>
      <div className="history-row__actions">
        <button className="text-button" type="button" onClick={() => onOpenRun(savedRun)}>{complete ? "View results" : "Resume"} <ArrowRight /></button>
        {savedDecisions.length ? <button className="text-button" type="button" onClick={() => onReview(savedRun)}>Review answers</button> : null}
        {complete && (rating ? savedRun.cards.length : savedKept) > 1 ? (
          <button className="text-button" type="button" onClick={() => onRefine(savedRun)}>Continue to next round</button>
        ) : null}
      </div>
    </article>
  );
}
