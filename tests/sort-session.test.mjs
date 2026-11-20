import test from "node:test";
import assert from "node:assert/strict";
import { pendingCardsInQueueOrder, roundPlanFor, roundTitleFor, validateRoundPlan, validateStartedRoundCaps } from "../src/lib/sort-session.js";

test("round plans provide a single sensible legacy fallback and preserve custom titles", () => {
  assert.deepEqual(roundPlanFor({ roundNumber: 1, keepLimit: 4 }), [{ title: "Round 1", keepLimit: 4 }]);
  const run = { roundNumber: 2, roundPlan: [{ title: "First pass", keepLimit: 5 }, { title: "Shortlist", keepLimit: 2 }] };
  assert.equal(roundTitleFor(run), "Shortlist");
  assert.equal(roundPlanFor(run).length, 2);
});

test("pending cards follow persisted queue order without changing the card snapshot", () => {
  const cards = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const run = { cards, queue: ["c", "missing", "a", "b"] };
  const pending = pendingCardsInQueueOrder(run, new Map([["a", { choice: "keep" }]]));
  assert.deepEqual(pending.map((card) => card.id), ["c", "b", "d"]);
  assert.deepEqual(run.cards, cards);
});

test("round plans validate useful limits and prevent non-decreasing presets", () => {
  assert.equal(validateRoundPlan([{ title: "Round 1", keepLimit: 4 }, { title: "Shortlist", keepLimit: 2 }], { cards: 8 }), "");
  assert.match(validateRoundPlan([{ title: "Round 1", keepLimit: null }], { cards: 6, requireFirstKeepLimit: true }), /Round 1 needs a keep limit/);
  assert.equal(validateRoundPlan([{ title: "Round 1", keepLimit: 3 }, { title: "Shortlist", keepLimit: null }], { cards: 6, requireFirstKeepLimit: true }), "");
  assert.match(validateRoundPlan([{ title: "Round 1", keepLimit: 4 }, { title: "Shortlist", keepLimit: 4 }], { cards: 8 }), /fewer than Round 1/);
  assert.match(validateRoundPlan([{ title: "Round 1", keepLimit: 9 }], { cards: 8 }), /no more than 8/);
});

test("editing a later round does not compare the original cap with the smaller current snapshot", () => {
  const original = [
    { title: "First pass", keepLimit: 4 },
    { title: "Shortlist", keepLimit: 2 },
    { title: "Final two", keepLimit: 1 },
  ];
  const edited = [...original.map((round) => ({ ...round })), { title: "Extra pass", keepLimit: null }];
  assert.equal(validateRoundPlan(edited, { startedRounds: 3 }), "");
  assert.equal(validateStartedRoundCaps(edited, original, 3), "");
  edited[0].keepLimit = 3;
  assert.match(validateStartedRoundCaps(edited, original, 3), /First pass is already in use/);
});

test("rating plans validate scales and permit started rounds without keep limits", () => {
  const rating = { name: "Cost", minimum: 0, maximum: 100, step: 5, unit: "$" };
  const plan = [{ title: "Estimate", keepLimit: null, ratingScale: rating }, { title: "Keep or release", keepLimit: 3 }];
  assert.equal(validateRoundPlan(plan, { cards: 6, startedRounds: 1 }), "");
  assert.deepEqual(roundPlanFor({ roundNumber: 1, roundPlan: plan })[0].ratingScale, rating);
  assert.match(validateRoundPlan([{ title: "Rate", keepLimit: 1, ratingScale: rating }], { cards: 6 }), /cannot have a keep limit/);
  assert.match(validateRoundPlan([{ title: "Rate", keepLimit: null, ratingScale: { ...rating, step: 7 } }], { cards: 6 }), /step that divides/);
});
