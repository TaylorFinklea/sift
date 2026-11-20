import { Trash } from "@phosphor-icons/react";
import { DEFAULT_SCALE } from "../lib/run-utils.js";
import { NumericScaleEditor } from "../components/NumericControls.jsx";

export const MAX_ROUNDS = 50;

export const newRound = (index) => ({ title: `Round ${index + 1}`, keepLimit: "", ratingScale: null });

/** Converts editable round rows into the API's round plan shape. */
export function roundValues(rounds) {
  return rounds.map((round) => ({
    title: round.title.trim(),
    keepLimit: round.ratingScale ? null : (String(round.keepLimit).trim() ? Number(round.keepLimit) : null),
    ...(round.ratingScale ? { ratingScale: round.ratingScale } : {}),
  }));
}

/** Round style (keep/let go or rating) and its keep limit or rating scale. */
export function RatingScaleRoundFields({ round, update, disabled = false }) {
  const selectType = (value) => update(value === "rating"
    ? { ratingScale: round.ratingScale || { ...DEFAULT_SCALE }, keepLimit: "" }
    : { ratingScale: null });
  return (
    <>
      <label>Round style
        <select value={round.ratingScale ? "rating" : "keep"} disabled={disabled} onChange={(event) => selectType(event.target.value)}>
          <option value="keep">Keep or let go</option>
          <option value="rating">Rate each card</option>
        </select>
      </label>
      {round.ratingScale ? (
        <div className="plan-round-row__scale">
          <NumericScaleEditor scale={round.ratingScale} onChange={(ratingScale) => update({ ratingScale })} disabled={disabled} />
        </div>
      ) : (
        <label className="plan-round-row__keep-limit">Keep limit <span className="field-optional">Optional preset</span>
          <input type="number" min="1" max="500" placeholder="Choose when you get here" value={round.keepLimit ?? ""} disabled={disabled}
            onChange={(event) => update({ keepLimit: event.target.value })} />
        </label>
      )}
    </>
  );
}

/** One editable row in a round plan. */
export function PlanRoundRow({ round, index, update, onRemove, disabled = false }) {
  return (
    <div className={`plan-round-row${round.ratingScale ? " plan-round-row--rating" : ""}`}>
      <label>Round {index + 1} title<input value={round.title} onChange={(event) => update({ title: event.target.value })} /></label>
      <RatingScaleRoundFields round={round} update={update} disabled={disabled} />
      {onRemove ? (
        <button className="icon-button plan-round-remove" type="button" aria-label={`Remove round ${index + 1}`} onClick={onRemove}><Trash /></button>
      ) : null}
    </div>
  );
}
