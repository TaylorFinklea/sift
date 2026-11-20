export const DEFAULT_NUMERIC_SCALE = Object.freeze({ name: "Rating", minimum: 0, maximum: 10, step: 1, unit: "" });
const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
const graphemes = (value) => segmenter ? [...segmenter.segment(value)].length : [...value].length;
const decimalPlaces = (value) => {
  const text = String(value).toLowerCase();
  const [mantissa, exponentText] = text.split("e");
  const fraction = mantissa.split(".")[1]?.length ?? 0;
  return Math.max(0, fraction - Number(exponentText || 0));
};
export function validateNumericScale(scale, { requireName = true } = {}) {
  if (!scale || typeof scale !== "object" || Array.isArray(scale)) return "A numeric scale must be an object.";
  const name = scale.name;
  const unit = scale.unit;
  if (requireName && (typeof name !== "string" || !name.trim() || graphemes(name.trim()) > 60)) return "Scale names must contain 1 to 60 characters.";
  if (typeof unit !== "string" || graphemes(unit) > 16) return "Scale units must be text with at most 16 characters.";
  const { minimum, maximum, step } = scale;
  if (![minimum, maximum, step].every(Number.isFinite) || Math.max(Math.abs(minimum), Math.abs(maximum), Math.abs(step)) > 1e9
    || minimum >= maximum || step <= 0 || step > maximum - minimum
    || [minimum, maximum, step].some((value) => decimalPlaces(value) > 6)
    || Math.abs((maximum - minimum) / step - Math.round((maximum - minimum) / step)) > 1e-7) {
    return "Use finite scale bounds and a positive step that divides the range (up to six decimal places).";
  }
  return "";
}
export function sameNumericScale(left, right) {
  if (left == null || right == null) return left == null && right == null;
  return ["name", "minimum", "maximum", "step", "unit"].every((key) => Object.hasOwn(left, key) && Object.hasOwn(right, key) && left[key] === right[key]);
}
export function numericValueError(value, scale) {
  if (!Number.isFinite(value) || value < scale.minimum || value > scale.maximum
    || decimalPlaces(value) > 6 || Math.abs((value - scale.minimum) / scale.step - Math.round((value - scale.minimum) / scale.step)) > 1e-7) {
    return `Enter a value from ${scale.minimum} to ${scale.maximum} in steps of ${scale.step}.`;
  }
  return "";
}
export const validateNumericValue = numericValueError;
export function validateNumericFields(fields, cards = []) {
  if (fields === undefined) fields = [];
  if (!Array.isArray(fields) || fields.length > 8) return "Add no more than eight numeric fields.";
  const ids = new Set();
  for (const field of fields) {
    if (!field || typeof field !== "object" || typeof field.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(field.id)) return "Each numeric field needs a UUID.";
    const id = field.id.toUpperCase();
    if (ids.has(id)) return "Numeric field IDs must be unique.";
    ids.add(id);
    const problem = validateNumericScale(field);
    if (problem) return problem;
  }
  for (const card of cards) {
    const values = card.numericValues ?? {};
    if (!values || typeof values !== "object" || Array.isArray(values)) return "Card numeric values must be an object.";
    const seenValueIDs = new Set();
    for (const [id, value] of Object.entries(values)) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return "Card values must use numeric field UUIDs.";
      if (seenValueIDs.has(id.toUpperCase())) return "Card values cannot repeat a numeric field ID.";
      seenValueIDs.add(id.toUpperCase());
      const field = fields.find((entry) => entry.id.toUpperCase() === id.toUpperCase());
      if (!field) return "Card values must refer to a configured numeric field.";
      const problem = numericValueError(value, field);
      if (problem) return problem;
    }
  }
  return "";
}
