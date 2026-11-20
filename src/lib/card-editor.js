export function createEditableCards(cards) {
  return cards.map((card) => ({
    id: card.id || crypto.randomUUID(),
    text: card.text || "",
    detail: card.detail || "",
    prosText: Array.isArray(card.pros) ? card.pros.join("\n") : "",
    consText: Array.isArray(card.cons) ? card.cons.join("\n") : "",
    numericValues: { ...(card.numericValues || {}) },
  }));
}

export function createEditableCardsFromTitles(rawText) {
  const cards = rawText.split(/\r?\n/).map((title) => title.trim()).filter(Boolean).map((text) => ({ text }));
  return createEditableCards(cards);
}

function parseItems(rawText) {
  return rawText.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

export function serializeCards(cards) {
  return cards.map((card) => {
    const numericValues = Object.fromEntries(Object.entries(card.numericValues || {}).filter(([, value]) => value != null));
    return {
      id: card.id,
      text: card.text.trim(),
      detail: card.detail.trim(),
      pros: parseItems(card.prosText),
      cons: parseItems(card.consText),
      ...(Object.keys(numericValues).length ? { numericValues } : {}),
    };
  });
}
