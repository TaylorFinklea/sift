/** The face of a card: title, optional description, pros/cons and numeric values. */
export default function StageCard({ card, numericFields = [] }) {
  const pros = Array.isArray(card.pros) ? card.pros : [];
  const cons = Array.isArray(card.cons) ? card.cons : [];
  const hasLists = Boolean(pros.length || cons.length);
  const hasLongDetail = Boolean(card.detail && card.detail.length > 150);
  const values = numericFields.filter((field) => card.numericValues?.[field.id] != null);
  const hasScrollableContext = hasLists || hasLongDetail || values.length > 0;

  return (
    <article className={`active-card${hasScrollableContext ? " active-card--with-context" : ""}`} aria-live="polite" aria-atomic="true">
      <h1 className="active-card__title">{card.text}</h1>
      <div className="active-card__rule" />
      {hasScrollableContext ? (
        <div className="active-card__context" role="region" aria-label="Card details" tabIndex={0} data-card-scroll-region="true">
          {card.detail ? <p className="active-card__detail">{card.detail}</p> : null}
          {pros.length ? <CardList kind="pros" title="Pros" items={pros} /> : null}
          {cons.length ? <CardList kind="cons" title="Cons" items={cons} /> : null}
          {values.length ? (
            <section className="active-card__numeric-values" aria-label="Card values">
              {values.map((field) => (
                <p key={field.id}>
                  <span>{field.name}</span>
                  <strong>{card.numericValues[field.id]}{field.unit ? ` ${field.unit}` : ""}</strong>
                </p>
              ))}
            </section>
          ) : null}
        </div>
      ) : card.detail ? <p className="active-card__detail">{card.detail}</p> : null}
    </article>
  );
}

function CardList({ kind, title, items }) {
  return (
    <section className={`active-card__list active-card__list--${kind}`}>
      <h2>{title}</h2>
      <ul>{items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>
    </section>
  );
}
