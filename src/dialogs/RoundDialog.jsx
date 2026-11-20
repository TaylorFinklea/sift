import { useState } from "react";
import { ArrowRight, Minus, Plus, Sparkle } from "@phosphor-icons/react";
import { validateNumericScale } from "../../shared/numeric-scale.js";
import { roundPlanFor, validateRoundPlan } from "../lib/sort-session.js";
import { activeDecisions } from "../lib/run-utils.js";
import Modal from "../components/Modal.jsx";
import { MAX_ROUNDS, newRound, PlanRoundRow, roundValues } from "./RoundFields.jsx";

const defaultKeepLimit = (cardCount, maxLimit) => Math.min(Math.max(1, Math.floor(cardCount * 0.5)), maxLimit);

/** Cards that carry into the round after `parent`: every card after a rating round, otherwise only keeps. */
function cardsAfter(parent) {
  if (parent.ratingScale) return parent.cards;
  const kept = new Set(activeDecisions(parent).filter((decision) => decision.choice === "keep").map((decision) => decision.cardId));
  return (parent.cards || []).filter((card) => kept.has(card.id));
}

/**
 * Starts a sort. Without `parent` it plans the rounds for a new sort of `collection`;
 * with `parent` it starts the next planned round from that completed round.
 */
export default function RoundDialog({ collection, parent, busy, offline, onDismiss, onStart, onAdjustPlan }) {
  const plan = parent ? roundPlanFor(parent) : [];
  const nextRound = parent ? parent.roundNumber : 0;
  const planned = parent ? plan[nextRound] || { title: `Round ${nextRound + 1}`, keepLimit: null } : null;
  const cards = parent ? cardsAfter(parent) : collection?.cards || [];
  const maxLimit = Math.max(1, cards.length - (parent ? 1 : 0));
  const presetExceedsCards = parent && !planned?.ratingScale && planned?.keepLimit != null && planned.keepLimit > maxLimit;

  const [maximum, setMaximum] = useState(String(planned?.keepLimit ?? defaultKeepLimit(cards.length, maxLimit)));
  const [rounds, setRounds] = useState(() => [{
    title: "Round 1",
    keepLimit: String(defaultKeepLimit(cards.length, Math.max(1, cards.length - 1))),
    ratingScale: null,
  }]);
  const [error, setError] = useState("");

  const setValue = (value) => setMaximum(String(Math.max(1, Math.min(maxLimit, value))));
  const updateRound = (index, patch) => setRounds((current) => current.map((round, row) => row === index ? { ...round, ...patch } : round));
  const addRound = () => setRounds((current) => current.length >= MAX_ROUNDS ? current : [...current, newRound(current.length)]);
  const removeRound = (index) => setRounds((current) => current.filter((_, row) => row !== index));

  const startNewSort = () => {
    const values = roundValues(rounds);
    const scaleProblem = values.map((round) => round.ratingScale && validateNumericScale(round.ratingScale)).find(Boolean);
    if (scaleProblem) return setError(scaleProblem);
    const problem = validateRoundPlan(values, { cards: cards.length, requireFirstKeepLimit: !values[0]?.ratingScale });
    if (problem) return setError(problem);
    onStart(values[0].keepLimit, values);
  };

  const continueSort = () => {
    const roundName = planned?.title || `Round ${nextRound + 1}`;
    if (presetExceedsCards) return setError(`You kept ${cards.length}, but this preset asks for ${planned.keepLimit}. Lower the preset before continuing.`);
    if (cards.length < 2) return setError("A next round needs at least two cards.");
    if (planned?.ratingScale && validateNumericScale(planned.ratingScale)) return setError("The planned rating scale is invalid. Edit the round plan first.");
    const parsed = maximum === "" ? null : Number(maximum);
    if (!planned?.ratingScale && planned?.keepLimit != null && parsed !== planned.keepLimit) {
      return setError(`${roundName} is set to keep ${planned.keepLimit}. Edit the round plan to change future limits.`);
    }
    if (!planned?.ratingScale && (parsed == null || !Number.isInteger(parsed) || parsed < 1 || parsed >= cards.length)) {
      return setError(`The next round needs a keep limit from 1 to ${cards.length - 1}.`);
    }
    onStart(planned?.ratingScale ? {} : { keepLimit: parsed });
  };

  const submit = (event) => {
    event.preventDefault();
    if (parent) continueSort();
    else startNewSort();
  };

  const presetLocked = planned?.keepLimit != null;
  const explanation = planned?.ratingScale
    ? `Rate all ${cards.length} cards. The next round starts with this same full set.`
    : `Refine your ${cards.length} ${parent?.ratingScale ? "cards" : "keeps"} down to ${maximum || "…"} that matter most.`;

  return (
    <Modal title={parent ? "Continue your sort" : "Plan your rounds"}
      description={parent ? "Continue with the saved round plan." : "Start with one round. Add more whenever you want to compare or trim."}
      onDismiss={onDismiss} className="round-dialog">
      <form className="round-form" onSubmit={submit}>
        <div className="round-form__line">
          <div><span className="eyebrow">{collection?.name || "Your cards"}</span><strong>{cards.length} cards for this round</strong></div>
          {parent ? <span className="round-form__round">{planned?.title || `Round ${nextRound + 1}`}</span> : null}
        </div>

        {!parent ? (
          <div className="plan-round-list">
            {rounds.map((round, index) => (
              <PlanRoundRow key={index} round={round} index={index} update={(patch) => updateRound(index, patch)}
                onRemove={index > 0 ? () => removeRound(index) : null} />
            ))}
            <button className="button button--quiet plan-add-round" type="button" disabled={rounds.length >= MAX_ROUNDS} onClick={addRound}><Plus /> Add a round</button>
          </div>
        ) : (
          <>
            {planned?.ratingScale ? (
              <div className="rating-plan-summary">
                <strong>{planned.ratingScale.name}</strong>
                <span>{planned.ratingScale.minimum}–{planned.ratingScale.maximum}{planned.ratingScale.unit ? ` ${planned.ratingScale.unit}` : ""} · step {planned.ratingScale.step}</span>
              </div>
            ) : (
              <div className="keep-limit-control">
                <div>
                  <span>Maximum keeps</span>
                  <small>{presetLocked ? `Preset for ${planned.title}.` : "Choose how many are worth carrying forward."}</small>
                </div>
                <div className="stepper" aria-label="Maximum keeps">
                  <button type="button" aria-label="Decrease keep limit" onClick={() => setValue(Number(maximum) - 1)} disabled={Number(maximum) <= 1 || busy || presetLocked}><Minus /></button>
                  <input type="number" min="1" max={maxLimit} aria-label="Maximum keeps" value={maximum} readOnly={presetLocked} onChange={(event) => setMaximum(event.target.value)} />
                  <button type="button" aria-label="Increase keep limit" onClick={() => setValue(Number(maximum) + 1)} disabled={Number(maximum) >= maxLimit || busy || presetLocked}><Plus /></button>
                </div>
              </div>
            )}
            {presetExceedsCards ? (
              <div className="round-preset-warning" role="alert">
                <p>The preset for {planned.title} is larger than this round’s keep count.</p>
                <button className="text-button" type="button" onClick={onAdjustPlan}>Edit round plan <ArrowRight /></button>
              </div>
            ) : null}
          </>
        )}

        {parent ? <p className="round-form__explain">{explanation}</p> : null}
        {offline ? <p className="form-hint" role="status">Reconnect to start sorting. Your settings will stay here.</p> : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="modal__actions">
          <button className="button button--quiet" type="button" onClick={onDismiss}>Maybe later</button>
          <button className="button button--cyan" type="submit" disabled={busy || offline}><Sparkle /> Start sorting <ArrowRight /></button>
        </div>
      </form>
    </Modal>
  );
}
