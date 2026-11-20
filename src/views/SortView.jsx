import { ArrowCounterClockwise, ArrowRight, Check, CheckCircle, PencilSimple, Plus, SkipForward, Sparkle, X } from "@phosphor-icons/react";
import { roundPlanFor, roundTitleFor } from "../lib/sort-session.js";
import SwipeCard from "../components/SwipeCard.jsx";
import StageCard from "../components/StageCard.jsx";
import { RatingStage } from "../components/RatingStage.jsx";

/**
 * The sorting screen: heading with round trail and progress, then either the active card,
 * the round's results, or an empty state.
 */
export default function SortView(props) {
  const { run, activeCard, ratingMode } = props;
  return (
    <>
      {run ? <SortHeading {...props} /> : null}
      {run && activeCard ? (
        ratingMode ? (
          <RatingStage key={`${run.id}:${activeCard.id}`} run={run} card={activeCard} busy={props.busy || props.isOffline}
            pendingCount={props.pendingCards.length} canUndo={props.canUndo} onSave={(value) => props.onDecide("rating", value)}
            onSkip={props.onSkip} onUndo={props.onUndo} onReview={() => props.onReview(run)} />
        ) : <ChoiceStage {...props} />
      ) : run ? <RoundResults {...props} /> : <EmptySort {...props} />}
      {run && activeCard && !ratingMode ? <SortFooter {...props} /> : null}
    </>
  );
}

/** The heading for an active or finished round: collection, round trail and progress. */
function SortHeading({ run, selectedCollection, decisions, decisionsByCard, ratingMode, isOffline, busy, onChooseCollection, onRoundPlan }) {
  const segmentClass = (card) => {
    const decision = decisionsByCard.get(card.id);
    if (!decision) return "";
    return decision.choice === "keep" ? "is-kept" : decision.choice === "rating" ? "is-rated" : "is-discarded";
  };
  return (
    <section className="sort-heading" aria-label="Sort details">
      <div className="sort-heading__collection">
        <span className="eyebrow">Collection</span>
        <button className="collection-picker" type="button" onClick={onChooseCollection} aria-label="Choose collection">
          <span>{selectedCollection?.name || "Your collections"}</span><span className="collection-picker__caret" aria-hidden="true">⌄</span>
        </button>
        <p className="round-meta">{roundTitleFor(run)}, {run.status === "complete" ? "complete" : "in progress"} ({run.cards.length} cards)</p>
      </div>

      <div className="round-trail-wrap">
        <div className="round-trail" aria-label={`Round ${run.roundNumber}: ${roundTitleFor(run)}`}>
          {roundPlanFor(run).map((planned, index) => {
            const round = index + 1;
            const finished = round < run.roundNumber;
            const current = round === run.roundNumber;
            return (
              <div className={`round-trail__step ${finished ? "is-done" : ""} ${current ? "is-current" : ""}`} key={`${index}-${planned.title}`}>
                <span className="round-trail__node">{finished ? <Check weight="bold" /> : round}</span>
                <span className="round-trail__label" title={planned.title}>{planned.title}</span>
              </div>
            );
          })}
        </div>
        <button className="round-plan-link" type="button" aria-label="Edit rounds" title="Edit rounds" disabled={isOffline || busy} onClick={() => onRoundPlan(run)}><PencilSimple /> Edit rounds</button>
      </div>

      <div className="sort-heading__progress">
        <div className="progress-segments" role="progressbar" aria-label={ratingMode ? "Rating progress" : "Sort progress"}
          aria-valuemin={0} aria-valuemax={run.cards.length || 1} aria-valuenow={decisions.length}>
          {run.cards.map((card) => <span className={`progress-segments__segment ${segmentClass(card)}`} key={card.id} />)}
        </div>
        <span>{`${decisions.length} of ${run.cards.length} ${ratingMode ? "rated" : "sorted"}`}</span>
      </div>
    </section>
  );
}

function ChoiceStage({ run, activeCard, keptCards, keepLabel, discardLabel, busy, isOffline, dialogOpen, onDecide }) {
  const keepFull = keptCards.length >= run.keepLimit;
  return (
    <section className="sort-stage" aria-label="Sort this card">
      <div className="decision-side decision-side--left">
        <button className="decision-orb decision-orb--discard" type="button" disabled={busy || isOffline} onClick={() => onDecide("discard")} aria-label={`${discardLabel}: ${activeCard.text}`}><X weight="bold" /></button>
        <h2>{discardLabel}</h2>
        <p>{activeCard.detail ? "Not for this round." : "This one can wait."}</p>
        <span className="key-hint"><kbd>←</kbd><kbd>H</kbd></span>
      </div>

      <SwipeCard cardKey={`${run.id}:${activeCard.id}`} disabled={busy || isOffline || dialogOpen} canKeep={!keepFull} onChoice={onDecide}>
        <StageCard key={`${run.id}:${activeCard.id}`} card={activeCard} numericFields={run.numericFields || []} />
      </SwipeCard>

      <div className="decision-side decision-side--right">
        <button className="decision-orb decision-orb--keep" type="button" disabled={busy || isOffline || keepFull} onClick={() => onDecide("keep")} aria-label={`${keepLabel}: ${activeCard.text}`}><Check weight="bold" /></button>
        <h2>{keepLabel}</h2>
        <p>{keepFull ? "Your keep limit is full." : "This matters to me."}</p>
        <span className="key-hint"><kbd>→</kbd><kbd>L</kbd></span>
      </div>
    </section>
  );
}

function RoundResults({ run, ratingMode, ratingOrder, onToggleRatingOrder, decisions, decisionsByCard, keptCards, discardedCards, keepLabel, discardLabel, canUndo, hasLaterResults, isOffline, busy, onReview, onUndo, onRefine, onRoundPlan, onHistory }) {
  const carried = ratingMode ? run.cards.length : keptCards.length;
  const plan = roundPlanFor(run);
  return (
    <section className="sort-complete" aria-label="Sort results">
      <div className="sort-complete__icon"><CheckCircle weight="duotone" /></div>
      <p className="eyebrow">{roundTitleFor(run)} complete</p>
      <h1>{ratingMode ? "Your scores are in." : run.roundNumber === 1 ? "Your first cut is in." : "This round is in."}</h1>
      <p className="sort-complete__copy">
        {ratingMode ? `Scored ${decisions.length} cards on ${run.ratingScale.name}.` : `You kept ${keptCards.length} of ${run.cards.length} cards. Want to narrow it down again?`}
      </p>
      {ratingMode ? <RatingResults run={run} decisionsByCard={decisionsByCard} order={ratingOrder} onToggleOrder={onToggleRatingOrder} /> : (
        <div className="result-columns">
          <ResultColumn kind="keep" label={keepLabel} cards={keptCards} />
          <ResultColumn kind="discard" label={discardLabel} cards={discardedCards} />
        </div>
      )}
      <button className="button button--quiet sort-complete__undo" type="button" onClick={() => onReview(run)}>Review and change answers</button>
      <button className="button button--quiet sort-complete__undo" type="button" disabled={!canUndo} onClick={onUndo}><ArrowCounterClockwise /> Undo last choice</button>
      {hasLaterResults ? <p className="form-hint sort-complete__undo-hint">This round has later results. Use Review answers to start a revised path and preserve this history.</p> : null}
      {carried > 1 && plan.length > run.roundNumber ? (
        <button className="button button--cyan sort-complete__next" type="button" onClick={() => onRefine(run)}><Sparkle /> {plan[run.roundNumber]?.title || "Continue to next round"} <ArrowRight /></button>
      ) : carried > 1 ? (
        <button className="button button--quiet sort-complete__next" type="button" disabled={isOffline || busy} onClick={() => onRoundPlan(run)}>Add another round <Plus /></button>
      ) : (
        <button className="button button--quiet sort-complete__next" type="button" onClick={onHistory}>See sort history <ArrowRight /></button>
      )}
    </section>
  );
}

function ResultColumn({ kind, label, cards }) {
  return (
    <div className="result-column">
      <h2><span className={`result-column__mark result-column__mark--${kind}`} /> {label}<span>{cards.length}</span></h2>
      {cards.map((card) => <div className="result-row" key={card.id}>{card.text}</div>)}
    </div>
  );
}

function RatingResults({ run, decisionsByCard, order, onToggleOrder }) {
  const scale = run.ratingScale;
  const valueOf = (card, missing) => Number(decisionsByCard.get(card.id)?.value ?? missing);
  const sorted = order === "high"
    ? run.cards.slice().sort((a, b) => valueOf(b, -Infinity) - valueOf(a, -Infinity))
    : run.cards.slice().sort((a, b) => valueOf(a, Infinity) - valueOf(b, Infinity));
  return (
    <div className="rating-results" aria-label={`${scale.name} scores, ${order === "high" ? "highest" : "lowest"} first`}>
      <div className="rating-results__heading">
        <span>{scale.name}</span>
        <button type="button" onClick={onToggleOrder}>Sort {order === "high" ? "high to low ↓" : "low to high ↑"}</button>
      </div>
      {sorted.map((card) => (
        <div className="rating-results__row" key={card.id}>
          <span>{card.text}</span>
          <strong>{decisionsByCard.get(card.id)?.value}{scale.unit ? ` ${scale.unit}` : ""}</strong>
        </div>
      ))}
    </div>
  );
}

function EmptySort({ selectedCollection, onStartRound, onNewCollection, onChooseCollection }) {
  return (
    <section className="empty-sort">
      <div className="empty-sort__glyph"><Sparkle weight="duotone" /></div>
      <h1>{selectedCollection ? "No sort in progress" : "Start with a collection"}</h1>
      <p>{selectedCollection
        ? "Pick a collection and narrow its cards down, one round at a time."
        : "A collection is a deck of cards: options, values, ideas. Add a few, then sort them."}</p>
      <button className="button button--cyan" type="button" onClick={() => selectedCollection ? onStartRound(selectedCollection) : onNewCollection()}>
        <Plus /> {selectedCollection ? `Sort ${selectedCollection.name}` : "Create a collection"}
      </button>
      {selectedCollection ? <button className="text-button" type="button" onClick={onChooseCollection}>Choose another collection</button> : null}
    </section>
  );
}

function SortFooter({ run, decisions, pendingCards, keptCards, keepLabel, discardLabel, canUndo, busy, isOffline, dialogOpen, onUndo, onReview, onSkip, onDecide }) {
  const keepFull = keptCards.length >= run.keepLimit;
  const skipDisabled = busy || isOffline || pendingCards.length <= 1 || dialogOpen;
  const skipLabel = pendingCards.length <= 1 ? "Skip unavailable when one card remains" : "Skip for now and return to this card later";
  const skipTitle = pendingCards.length <= 1 ? "One card is left, so there is nowhere to move it." : "Move this card to the end of the queue.";
  return (
    <section className="sort-footer" aria-label="Sort controls">
      <div className="sort-footer__left">
        <span>Keeps</span>
        <strong className={keepFull ? "is-cap" : ""}>{keptCards.length}<span> / {run.keepLimit}</span></strong>
        <div className="keep-meter" role="meter" aria-label="Keeps used" aria-valuenow={keptCards.length} aria-valuemin={0} aria-valuemax={run.keepLimit}>
          <span style={{ width: `${Math.min(100, keptCards.length / Math.max(1, run.keepLimit) * 100)}%` }} />
        </div>
        {keepFull ? <small>Keep limit reached</small> : null}
      </div>
      <div className="sort-footer__undo">
        <button className="button button--undo" type="button" disabled={!canUndo} onClick={onUndo}><ArrowCounterClockwise /> Undo</button>
        <button className="button button--undo" type="button" disabled={decisions.length === 0} onClick={() => onReview(run)}>Review answers</button>
        <button className="button button--undo sort-footer__skip" type="button" aria-label={skipLabel} title={skipTitle} disabled={skipDisabled} onClick={onSkip}><SkipForward /> Skip</button>
        <span className="sort-footer__separator" />
        <span className="undo-hint"><kbd>Z</kbd><span>Undo last sort</span></span>
      </div>
      <div className="sort-footer__spacer" />
      <div className="mobile-decision-controls">
        <div className="mobile-sort-status">
          <div className="mobile-keep-count"><span>Keeps</span><strong>{keptCards.length} / {run.keepLimit}</strong></div>
          <button className="button button--undo mobile-undo" type="button" aria-label="Undo last choice" title="Undo last choice" disabled={!canUndo || busy || isOffline} onClick={onUndo}>
            <ArrowCounterClockwise /><span className="visually-hidden">Undo</span>
          </button>
          <button className="button button--undo mobile-review" type="button" aria-label={`Review ${decisions.length} answers`} title={`Review ${decisions.length} answers`} disabled={!decisions.length} onClick={() => onReview(run)}>Review</button>
          <button className="mobile-skip" type="button" aria-label={skipLabel} title={skipTitle} disabled={skipDisabled} onClick={onSkip}>
            <SkipForward /><span className="visually-hidden">Skip for now</span>
          </button>
        </div>
        <button className="mobile-discard" type="button" disabled={busy || isOffline} onClick={() => onDecide("discard")}><X /> {discardLabel}</button>
        <button className="mobile-keep" type="button" disabled={busy || isOffline || keepFull} onClick={() => onDecide("keep")}><Check /> {keepLabel}</button>
      </div>
    </section>
  );
}
