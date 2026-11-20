import { useState } from "react";
import { ArrowLeft, ArrowRight } from "@phosphor-icons/react";
import { roundTitleFor } from "../lib/sort-session.js";
import { activeDecisions, choiceLabel, formatValue } from "../lib/run-utils.js";
import Modal from "../components/Modal.jsx";
import StageCard from "../components/StageCard.jsx";
import { RatingReviewEditor } from "../components/RatingStage.jsx";

/**
 * Browse a round's answers with filters and Previous/Next, and change any of them.
 * Changing an answer after later rounds exist creates a revised path (handled by `onRevise`).
 */
export default function ReviewDialog({ run, offline, busy, onDismiss, onRevise }) {
  const decisions = activeDecisions(run);
  const byCard = new Map(decisions.map((decision) => [decision.cardId, decision]));
  const scale = run.ratingScale;
  const [filter, setFilter] = useState("all");
  const [selectedId, setSelectedId] = useState(() => run.cards.find((card) => byCard.has(card.id))?.id || "");
  const [message, setMessage] = useState("");

  const matches = (card, value) => {
    const decision = byCard.get(card.id);
    return Boolean(decision) && (value === "all" || decision.choice === value);
  };
  const visibleCards = run.cards.filter((card) => matches(card, filter));
  const selectedCard = visibleCards.find((card) => card.id === selectedId) || visibleCards[0] || null;
  const selectedIndex = visibleCards.findIndex((card) => card.id === selectedCard?.id);
  const selectedDecision = selectedCard ? byCard.get(selectedCard.id) : null;

  const chooseFilter = (value) => {
    setFilter(value);
    const next = run.cards.find((card) => matches(card, value));
    if (next) setSelectedId(next.id);
  };
  const move = (offset) => {
    const next = visibleCards[selectedIndex + offset];
    if (next) setSelectedId(next.id);
  };
  const changeChoice = (choice) => {
    if (!selectedCard || !selectedDecision || selectedDecision.choice === choice) return;
    const kept = decisions.filter((decision) => decision.choice === "keep").length;
    if (choice === "keep" && kept >= run.keepLimit) {
      setMessage("Your keep limit is full. Change another keep first.");
      return;
    }
    setMessage("");
    onRevise(selectedCard, choice);
  };

  const filterLabel = (value) => value === "all"
    ? `All (${decisions.length})`
    : `${choiceLabel(run, value)} (${decisions.filter((decision) => decision.choice === value).length})`;
  const answerLabel = (decision) => decision.choice === "rating"
    ? `${formatValue(decision.value, scale.unit)} · ${scale.name}`
    : choiceLabel(run, decision.choice);

  return (
    <Modal title={`Review ${roundTitleFor(run)}`}
      description={scale ? `Browse your ${scale.name} scores and adjust any rating.` : "Browse your answers in order. Choose another side to update a card."}
      onDismiss={onDismiss} className="review-dialog">
      <div className="review-filters" role="group" aria-label="Filter reviewed answers">
        {(scale ? ["all"] : ["all", "keep", "discard"]).map((value) => (
          <button className={filter === value ? "is-selected" : ""} type="button" key={value} onClick={() => chooseFilter(value)}>{filterLabel(value)}</button>
        ))}
      </div>

      {selectedCard ? (
        <div className="review-content">
          <nav className="review-list" aria-label="Answered cards">
            {visibleCards.map((card, index) => {
              const decision = byCard.get(card.id);
              return (
                <button className={card.id === selectedCard.id ? "is-current" : ""} type="button" key={card.id} onClick={() => setSelectedId(card.id)}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <strong>{card.text}</strong>
                  <small className={`review-choice review-choice--${decision.choice}`}>{answerLabel(decision)}</small>
                </button>
              );
            })}
          </nav>
          <section className="review-detail" aria-live="polite">
            <div className="review-position">
              <button className="icon-button" type="button" aria-label="Previous answer" disabled={selectedIndex <= 0} onClick={() => move(-1)}><ArrowLeft /></button>
              <span>{selectedIndex + 1} of {visibleCards.length}</span>
              <button className="icon-button" type="button" aria-label="Next answer" disabled={selectedIndex >= visibleCards.length - 1} onClick={() => move(1)}><ArrowRight /></button>
            </div>
            <div className="review-card"><StageCard key={selectedCard.id} card={selectedCard} numericFields={run.numericFields || []} /></div>
            {scale ? (
              <>
                <p className="review-current-choice">Current rating: <strong>{formatValue(selectedDecision.value, scale.unit)}</strong></p>
                <RatingReviewEditor key={`${run.id}:${selectedCard.id}:${selectedDecision.value}`} card={selectedCard} decision={selectedDecision}
                  scale={scale} busy={busy} offline={offline} onSave={(value) => onRevise(selectedCard, "rating", value)} />
              </>
            ) : (
              <>
                <p className="review-current-choice">Current answer: <strong>{choiceLabel(run, selectedDecision.choice)}</strong></p>
                <div className="review-actions">
                  <button className="review-action review-action--discard" type="button" disabled={busy || offline || selectedDecision.choice === "discard"} onClick={() => changeChoice("discard")}>{choiceLabel(run, "discard")}</button>
                  <button className="review-action review-action--keep" type="button" disabled={busy || offline || selectedDecision.choice === "keep"} onClick={() => changeChoice("keep")}>{choiceLabel(run, "keep")}</button>
                </div>
              </>
            )}
            {message ? <p className="form-error" role="alert">{message}</p> : null}
            {offline ? <p className="form-hint" role="status">Answers are read-only while offline.</p> : null}
          </section>
        </div>
      ) : <p className="form-hint">No answers match this filter.</p>}
    </Modal>
  );
}
