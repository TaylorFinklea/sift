import { validateNumericScale } from "../../shared/numeric-scale.js";

export function roundPlanFor(run) {
  if (Array.isArray(run?.roundPlan) && run.roundPlan.length) {
    return run.roundPlan.map((round, index) => ({
      title: String(round.title || `Round ${index + 1}`),
      keepLimit: Number.isInteger(round.keepLimit) ? round.keepLimit : null,
      ...(round.ratingScale ? { ratingScale: round.ratingScale } : {}),
    }));
  }
  const number = Math.max(1, Number(run?.roundNumber) || 1);
  return Array.from({ length: number }, (_, index) => ({
    title: `Round ${index + 1}`,
    keepLimit: index === number - 1 && Number.isInteger(run?.keepLimit) ? run.keepLimit : null,
    ...(index === number - 1 && run?.ratingScale ? { ratingScale: run.ratingScale } : {}),
  }));
}

export function roundTitleFor(run) {
  const plan = roundPlanFor(run);
  return plan[Math.max(0, (Number(run?.roundNumber) || 1) - 1)]?.title || `Round ${run?.roundNumber || 1}`;
}

export function pendingCardsInQueueOrder(run, decisionsByCard) {
  const cards = run?.cards || [];
  const pendingById = new Map(cards.filter((card) => !decisionsByCard.has(card.id)).map((card) => [card.id, card]));
  const ordered = [];
  for (const id of Array.isArray(run?.queue) ? run.queue : []) {
    const card = pendingById.get(id);
    if (!card) continue;
    ordered.push(card);
    pendingById.delete(id);
  }
  for (const card of cards) {
    if (pendingById.has(card.id)) {
      ordered.push(card);
      pendingById.delete(card.id);
    }
  }
  return ordered;
}

export function validateRoundPlan(rounds, { cards, startedRounds = 0, requireFirstKeepLimit = false } = {}) {
  if (!Array.isArray(rounds) || rounds.length < 1 || rounds.length > 50) return "Add between 1 and 50 rounds.";
  for (let index = 0; index < rounds.length; index += 1) {
    const round = rounds[index];
    const title = round.title?.trim() || "";
    const titleLength = typeof Intl.Segmenter === "function"
      ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(title)].length
      : [...title].length;
    if (!title || titleLength > 60) return `Round ${index + 1} needs a title of 1 to 60 characters.`;
    if (round.ratingScale) {
      const problem = validateNumericScale(round.ratingScale);
      if (problem) return `Round ${index + 1}: ${problem}`;
      if (round.keepLimit != null) return `Round ${index + 1} rating rounds cannot have a keep limit.`;
    }
    if (round.keepLimit != null && (!Number.isInteger(Number(round.keepLimit)) || Number(round.keepLimit) < 1 || Number(round.keepLimit) > 500)) {
      return `Round ${index + 1} keep limit must be between 1 and 500.`;
    }
    if (index < startedRounds && round.keepLimit == null && !round.ratingScale) return `Round ${index + 1} already has a keep limit.`;
  }
  if (requireFirstKeepLimit && rounds[0].keepLimit == null) return "Round 1 needs a keep limit to start sorting.";
  if (rounds[0].keepLimit != null && Number(rounds[0].keepLimit) > cards) return `Round 1 can keep no more than ${cards} cards.`;
  for (let index = 1; index < rounds.length; index += 1) {
    const previous = rounds[index - 1].keepLimit;
    const current = rounds[index].keepLimit;
    if (previous != null && current != null && Number(current) >= Number(previous)) return `Round ${index + 1} must keep fewer than Round ${index}.`;
  }
  return "";
}

export function validateStartedRoundCaps(rounds, originalPlan, startedRounds) {
  for (let index = 0; index < startedRounds; index += 1) {
    if (originalPlan[index]?.keepLimit != null && Number(rounds[index]?.keepLimit) !== Number(originalPlan[index].keepLimit)) {
      return `The keep limit for ${originalPlan[index].title} is already in use.`;
    }
  }
  return "";
}
