import { useState } from "react";
import { Check, Plus, Trash } from "@phosphor-icons/react";
import { validateNumericFields } from "../../shared/numeric-scale.js";
import { createEditableCards, createEditableCardsFromTitles, serializeCards } from "../lib/card-editor.js";
import { graphemeCount } from "../lib/transfer-ui.js";
import { DEFAULT_DISCARD, DEFAULT_KEEP, DEFAULT_SCALE } from "../lib/run-utils.js";
import Modal from "../components/Modal.jsx";
import { NumericScaleEditor, NumericValueControl } from "../components/NumericControls.jsx";

const MAX_NUMERIC_FIELDS = 8;

function validateCollection({ name, description, keepLabel, discardLabel, cards }) {
  if (!name.trim()) return "Give your collection a name to keep it easy to find.";
  if (graphemeCount(name.trim()) > 100) return "Collection names can be up to 100 characters.";
  if (graphemeCount(description.trim()) > 500) return "Collection descriptions can be up to 500 characters.";
  if (graphemeCount(keepLabel.trim() || DEFAULT_KEEP) > 36 || graphemeCount(discardLabel.trim() || DEFAULT_DISCARD) > 36) {
    return "Choice labels can be up to 36 characters.";
  }
  if (cards.length < 2) return "A collection needs at least two cards.";
  if (cards.length > 500) return "A collection can contain up to 500 cards.";
  if (cards.some((card) => !card.text.trim() || graphemeCount(card.text.trim()) > 120)) return "Each card needs a name of 1 to 120 characters.";
  if (cards.some((card) => graphemeCount(card.detail) > 500)) return "Descriptions can be up to 500 characters.";
  if (cards.some((card) => [...card.pros, ...card.cons].some((item) => graphemeCount(item) > 200))) return "Each pro or con can be up to 200 characters.";
  if (cards.some((card) => card.pros.length > 10 || card.cons.length > 10)) return "Each card can have up to 10 pros and 10 cons.";
  return "";
}

/**
 * Creates or edits a collection. Card names still in the bulk box are saved too, so
 * "Add cards" is optional. Drafts are left untouched when validation fails.
 */
export default function CollectionDialog({ collection, busy, offline, onDismiss, onSave }) {
  const [name, setName] = useState(collection?.name || "");
  const [description, setDescription] = useState(collection?.description || "");
  const [cards, setCards] = useState(() => createEditableCards(collection?.cards || []));
  const [bulkTitles, setBulkTitles] = useState("");
  const [keepLabel, setKeepLabel] = useState(collection?.keepLabel || DEFAULT_KEEP);
  const [discardLabel, setDiscardLabel] = useState(collection?.discardLabel || DEFAULT_DISCARD);
  const [numericFields, setNumericFields] = useState(() => (collection?.numericFields || []).map((field) => ({ ...field })));
  const [error, setError] = useState("");

  const updateCard = (id, patch) => setCards((current) => current.map((card) => card.id === id ? { ...card, ...patch } : card));
  const removeCard = (id) => setCards((current) => current.filter((item) => item.id !== id));
  const addTitles = () => {
    const additions = createEditableCardsFromTitles(bulkTitles);
    if (!additions.length) return;
    setCards((current) => [...current, ...additions]);
    setBulkTitles("");
    setError("");
  };
  const addNumericField = () => setNumericFields((current) => current.length >= MAX_NUMERIC_FIELDS ? current : [...current, {
    id: crypto.randomUUID(),
    ...DEFAULT_SCALE,
    name: current.some((field) => field.name === "Rating") ? `Value ${current.length + 1}` : "Rating",
  }]);
  const updateNumericField = (id, scale) => setNumericFields((current) => current.map((field) => field.id === id ? scale : field));
  const removeNumericField = (id) => {
    setNumericFields((current) => current.filter((field) => field.id !== id));
    setCards((current) => current.map((card) => {
      const numericValues = { ...(card.numericValues || {}) };
      delete numericValues[id];
      return { ...card, numericValues };
    }));
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    const savedCards = serializeCards([...cards, ...createEditableCardsFromTitles(bulkTitles)]).map((card, index) => {
      const numericValues = Object.fromEntries(numericFields
        .filter((field) => cards[index]?.numericValues?.[field.id] != null)
        .map((field) => [field.id, cards[index].numericValues[field.id]]));
      return Object.keys(numericValues).length ? { ...card, numericValues } : card;
    });
    const problem = validateCollection({ name, description, keepLabel, discardLabel, cards: savedCards })
      || validateNumericFields(numericFields, savedCards);
    if (problem) return setError(problem);
    onSave({
      name: name.trim(),
      description: description.trim(),
      keepLabel: keepLabel.trim() || DEFAULT_KEEP,
      discardLabel: discardLabel.trim() || DEFAULT_DISCARD,
      numericFields,
      cards: savedCards,
    });
  };

  return (
    <Modal title={collection ? "Shape your collection" : "A new collection"} description="One good thought per card. Add context when it helps, then sort the deck." onDismiss={onDismiss} className="collection-dialog">
      <form className="collection-form" onSubmit={handleSubmit}>
        <label>Collection name<input autoComplete="off" value={name} onChange={(event) => setName(event.target.value)} placeholder="Personal values" /></label>
        <label>A little context <span className="field-optional">Optional, up to 500 characters</span>
          <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What are you sorting through?" />
        </label>

        <section className="card-editor" aria-label="Cards">
          <details className="numeric-field-list">
            <summary>Numeric card values <span className="field-optional">Optional, up to 8</span></summary>
            <p className="form-hint">Add values like cost, weight, or priority. Each card can be left blank.</p>
            {numericFields.map((field, index) => (
              <article className="numeric-field-card" key={field.id}>
                <div className="numeric-field-card__heading">
                  <strong>Value {index + 1}</strong>
                  <button className="icon-button" type="button" aria-label={`Remove ${field.name} field`} onClick={() => removeNumericField(field.id)}><Trash /></button>
                </div>
                <NumericScaleEditor scale={field} onChange={(scale) => updateNumericField(field.id, scale)} />
              </article>
            ))}
            <button className="button button--quiet" type="button" disabled={numericFields.length >= MAX_NUMERIC_FIELDS} onClick={addNumericField}><Plus /> Add a numeric field</button>
          </details>

          <div className="card-editor__heading"><strong>Your cards</strong><span className="field-optional">2 to 500 cards</span></div>
          {cards.map((card, index) => (
            <CardEditorRow key={card.id} card={card} index={index} numericFields={numericFields}
              update={(patch) => updateCard(card.id, patch)} onRemove={() => removeCard(card.id)} />
          ))}

          <div className="card-editor__bulk">
            <label htmlFor="bulk-card-titles">Add card names <span className="field-optional">One per line</span>
              <textarea id="bulk-card-titles" rows={3} value={bulkTitles} onChange={(event) => setBulkTitles(event.target.value)} placeholder={"Curiosity\nFamily\nHealth"} />
            </label>
            <button className="button button--quiet" type="button" onClick={addTitles} disabled={!bulkTitles.trim()}><Plus /> Add cards</button>
          </div>
        </section>

        <div className="label-fields">
          <label>Right button<input value={keepLabel} onChange={(event) => setKeepLabel(event.target.value)} /></label>
          <label>Left button<input value={discardLabel} onChange={(event) => setDiscardLabel(event.target.value)} /></label>
        </div>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        {offline ? <p className="form-hint" role="status">Reconnect to save your changes. Your form will stay open.</p>
          : busy ? <p className="form-hint" role="status">Saving your collection…</p> : null}
        <div className="modal__actions">
          <button className="button button--quiet" type="button" onClick={onDismiss}>Cancel</button>
          <button className="button button--cyan" type="submit" disabled={busy || offline}><Check /> Save collection</button>
        </div>
      </form>
    </Modal>
  );
}

function CardEditorRow({ card, index, numericFields, update, onRemove }) {
  return (
    <article className="card-editor__card">
      <div className="card-editor__title-row">
        <label className="visually-hidden" htmlFor={`card-title-${card.id}`}>Card {index + 1} name</label>
        <input id={`card-title-${card.id}`} value={card.text} onChange={(event) => update({ text: event.target.value })} placeholder={`Card ${index + 1} name`} />
        <button className="icon-button card-editor__remove" type="button" aria-label={`Remove card ${index + 1}`} onClick={onRemove}><Trash /></button>
      </div>
      <details className="card-editor__details">
        <summary>{numericFields.length ? "Add description, pros, cons & numeric values" : "Add description, pros & cons"} <span>Optional</span></summary>
        <label>Description <span className="field-optional">Optional, up to 500 characters</span>
          <textarea rows={2} value={card.detail} onChange={(event) => update({ detail: event.target.value })} placeholder="A little more context about this card" />
        </label>
        <div className="card-editor__lists">
          <label>Pros <span className="field-optional">Optional, up to 10</span>
            <textarea rows={3} value={card.prosText} onChange={(event) => update({ prosText: event.target.value })} placeholder="One pro per line" />
          </label>
          <label>Cons <span className="field-optional">Optional, up to 10</span>
            <textarea rows={3} value={card.consText} onChange={(event) => update({ consText: event.target.value })} placeholder="One con per line" />
          </label>
        </div>
        <p className="form-hint">Each pro or con can be up to 200 characters.</p>
        {numericFields.map((field) => (
          <NumericValueControl key={`${card.id}-${field.id}`} id={`${card.id}-${field.id}`} scale={field} value={card.numericValues?.[field.id]}
            onChange={(value) => update({ numericValues: { ...(card.numericValues || {}), [field.id]: value } })} compact />
        ))}
      </details>
    </article>
  );
}
