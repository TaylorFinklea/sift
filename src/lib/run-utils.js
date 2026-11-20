import { ApiError } from "./api.js";
import { DEFAULT_NUMERIC_SCALE } from "../../shared/numeric-scale.js";

export const DEFAULT_KEEP = "Keep";
export const DEFAULT_DISCARD = "Let go";
export const DEFAULT_SCALE = DEFAULT_NUMERIC_SCALE;

/** Decisions that still count: undone decisions stay in history with `undoneAt` set. */
export function activeDecisions(run) {
  return (run?.decisions || []).filter((decision) => decision.undoneAt == null);
}

export const isRatingRound = (round) => Boolean(round?.ratingScale);

export function keptCountFor(run) {
  return activeDecisions(run).filter((decision) => decision.choice === "keep").length;
}

export function sortNewest(a, b) {
  return String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt));
}

export function dateLabel(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

export function formatError(error) {
  if (error instanceof ApiError && error.status === 409) {
    return error.message || "This sort changed in another window. Refreshing the latest state.";
  }
  return error?.message || "That didn’t work. Please try again.";
}

export function choiceLabel(run, choice) {
  return choice === "keep" ? run.keepLabel || DEFAULT_KEEP : run.discardLabel || DEFAULT_DISCARD;
}

export function formatValue(value, unit) {
  return `${value}${unit ? ` ${unit}` : ""}`;
}
