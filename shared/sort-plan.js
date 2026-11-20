import { validateNumericScale } from "./numeric-scale.js";

export function defaultRoundTitle(index) {
  return `Round ${index + 1}`;
}

export function validateRoundPlan(input, fail, maximumRounds = 50) {
  if (input === undefined) return [{ title: defaultRoundTitle(0), keepLimit: null }];
  if (!Array.isArray(input) || input.length < 1 || input.length > maximumRounds) {
    fail(400, "invalid_round_plan", `A sort needs 1 to ${maximumRounds} rounds.`);
  }
  return input.map((round, index) => {
    if (!round || typeof round !== "object" || Array.isArray(round)) {
      fail(400, "invalid_round_plan", "Each round must be an object.");
    }
    const title = typeof round.title === "string" ? round.title.trim() : "";
    const titleLength = typeof Intl.Segmenter === "function"
      ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(title)].length
      : [...title].length;
    if (!title || titleLength > 60) fail(400, "invalid_round_plan", "Round titles must contain 1 to 60 characters.");
    const keepLimit = round.keepLimit === undefined ? null : round.keepLimit;
    if (keepLimit !== null && (!Number.isInteger(keepLimit) || keepLimit < 1 || keepLimit > 500)) {
      fail(400, "invalid_round_plan", `Round ${index + 1} keeps must be from 1 to 500 or empty.`);
    }
    let ratingScale;
    if (round.ratingScale !== undefined && round.ratingScale !== null) {
      const problem = validateNumericScale(round.ratingScale);
      if (problem) fail(400, "invalid_round_plan", problem);
      if (keepLimit !== null) fail(400, "invalid_round_plan", "Rating rounds cannot have a keep limit.");
      ratingScale = { name: round.ratingScale.name, minimum: round.ratingScale.minimum, maximum: round.ratingScale.maximum, step: round.ratingScale.step, unit: round.ratingScale.unit };
    }
    return { title, keepLimit: ratingScale ? null : keepLimit, ...(ratingScale ? { ratingScale } : {}) };
  });
}

export function fillRoundPlan(plan, roundNumber) {
  const result = [...plan];
  while (result.length < roundNumber) result.push({ title: defaultRoundTitle(result.length), keepLimit: null });
  return result;
}
