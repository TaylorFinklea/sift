import { useState } from "react";
import { Check, Plus } from "@phosphor-icons/react";
import { validateNumericScale } from "../../shared/numeric-scale.js";
import { roundPlanFor, validateRoundPlan, validateStartedRoundCaps } from "../lib/sort-session.js";
import Modal from "../components/Modal.jsx";
import { MAX_ROUNDS, newRound, PlanRoundRow, roundValues } from "./RoundFields.jsx";

/**
 * Edits the round plan of an existing sort. Started rounds keep their type, scale and
 * actual keep limit; future rounds can be added, renamed, retyped or removed.
 */
export default function RoundPlanDialog({ run, startedRoundCount = run.roundNumber, busy, offline, onDismiss, onSave }) {
  const started = Math.max(1, Number(startedRoundCount) || Number(run.roundNumber) || 1);
  const original = roundPlanFor(run);
  const [rounds, setRounds] = useState(() => original.map((round) => ({
    title: round.title,
    keepLimit: round.keepLimit == null ? "" : String(round.keepLimit),
    ratingScale: round.ratingScale || null,
  })));
  const [error, setError] = useState("");
  const updateRound = (index, patch) => setRounds((current) => current.map((round, row) => row === index ? { ...round, ...patch } : round));
  const addRound = () => setRounds((current) => current.length >= MAX_ROUNDS ? current : [...current, newRound(current.length)]);
  const removeRound = (index) => setRounds((current) => current.filter((_, row) => row !== index));

  const submit = (event) => {
    event.preventDefault();
    const values = roundValues(rounds);
    const scaleProblem = values.map((round) => round.ratingScale && validateNumericScale(round.ratingScale)).find(Boolean);
    if (scaleProblem) return setError(scaleProblem);
    const problem = validateRoundPlan(values, { startedRounds: 0 });
    if (problem) return setError(problem);
    if (values.length < started) return setError(`Keep all ${started} started rounds in this plan.`);
    const startedError = validateStartedRoundCaps(values, original, started);
    if (startedError) return setError(startedError);
    for (let index = 0; index < started; index += 1) {
      if (JSON.stringify(values[index]?.ratingScale || null) !== JSON.stringify(original[index]?.ratingScale || null)) {
        return setError(`The type and scale for ${original[index]?.title || `Round ${index + 1}`} cannot change after it starts.`);
      }
    }
    onSave(values);
  };

  return (
    <Modal title="Edit this sort’s rounds" description="The plan belongs to this sort. You can add future rounds at any time." onDismiss={onDismiss} className="round-dialog">
      <form className="round-form" onSubmit={submit}>
        <div className="plan-round-list">
          {rounds.map((round, index) => (
            <PlanRoundRow key={index} round={round} index={index} update={(patch) => updateRound(index, patch)}
              disabled={index < started || offline || busy} onRemove={index >= started ? () => removeRound(index) : null} />
          ))}
        </div>
        <button className="button button--quiet plan-add-round" type="button" disabled={rounds.length >= MAX_ROUNDS || offline || busy} onClick={addRound}><Plus /> Add a round</button>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        {offline ? <p className="form-hint" role="status">Reconnect to save this plan. Your edits will stay here.</p> : null}
        <div className="modal__actions">
          <button className="button button--quiet" type="button" onClick={onDismiss}>Cancel</button>
          <button className="button button--cyan" type="submit" disabled={busy || offline}><Check /> Save round plan</button>
        </div>
      </form>
    </Modal>
  );
}
