import { useState } from "react";
import { ArrowCounterClockwise, Check, SkipForward } from "@phosphor-icons/react";
import { numericValueError } from "../../shared/numeric-scale.js";
import { roundTitleFor } from "../lib/sort-session.js";
import { activeDecisions } from "../lib/run-utils.js";
import { NumericValueControl } from "./NumericControls.jsx";
import StageCard from "./StageCard.jsx";

/** The active card in a rating round. A rating is only recorded on an explicit Save. */
export function RatingStage({ run, card, busy, pendingCount, canUndo, onSave, onSkip, onUndo, onReview }) {
  const existing = activeDecisions(run).find((decision) => decision.cardId === card.id);
  const [value, setValue] = useState(existing?.value ?? null);
  const scale = run.ratingScale;
  const invalid = value == null || Boolean(numericValueError(value, scale));

  return (
    <section className="rating-stage" aria-label={`Rate ${card.text}`}>
      <div className="rating-stage__card"><StageCard card={card} numericFields={run.numericFields || []} /></div>
      <div className="rating-stage__control">
        <p className="eyebrow">{roundTitleFor(run)}: rate this card</p>
        <h2>{scale.name}</h2>
        <NumericValueControl id={`sort-${run.id}-${card.id}`} scale={scale} value={value} onChange={setValue} />
        <button className="button button--cyan rating-stage__save" type="button" disabled={busy || invalid} onClick={() => onSave(value)}>
          <Check /> Save rating
        </button>
        <p className="form-hint">Your score is saved when you tap Save rating.</p>
        <div className="rating-stage__actions">
          <button className="button button--undo" type="button" disabled={busy || !canUndo} onClick={onUndo}><ArrowCounterClockwise /> Undo</button>
          <button className="button button--undo" type="button" disabled={pendingCount === 0} onClick={onReview}>Review answers</button>
          <button className="button button--undo" type="button" disabled={busy || pendingCount <= 1} onClick={onSkip}><SkipForward /> Skip</button>
        </div>
      </div>
    </section>
  );
}

/** Edits one saved rating from the review dialog. */
export function RatingReviewEditor({ card, decision, scale, busy, offline, onSave }) {
  const [value, setValue] = useState(decision.value ?? null);
  const changed = value !== decision.value;
  const invalid = value == null || Boolean(numericValueError(value, scale));
  return (
    <div className="rating-review-editor">
      <NumericValueControl id={`review-${card.id}`} scale={scale} value={value} onChange={setValue} />
      <button className="button button--cyan" type="button" disabled={busy || offline || invalid || !changed} onClick={() => onSave(value)}>
        <Check /> Save rating
      </button>
    </div>
  );
}
