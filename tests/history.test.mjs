import test from "node:test";
import assert from "node:assert/strict";
import { groupRunsBySort } from "../src/lib/history.js";

const run = (id, fields) => ({ id, createdAt: "2026-11-01T00:00:00.000Z", ...fields });

test("groups rounds by sort session, newest activity first", () => {
  const groups = groupRunsBySort([
    run("a1", { sortId: "a", roundNumber: 1, updatedAt: "2026-11-02T00:00:00.000Z" }),
    run("b1", { sortId: "b", roundNumber: 1, updatedAt: "2026-11-05T00:00:00.000Z" }),
    run("a2", { sortId: "a", roundNumber: 2, createdAt: "2026-11-03T00:00:00.000Z", updatedAt: "2026-11-04T00:00:00.000Z" }),
  ]);
  assert.deepEqual(groups.map((group) => group.key), ["b", "a"]);
  assert.deepEqual(groups[1].rounds.map((item) => item.id), ["a1", "a2"]);
});

test("keeps sibling rounds with the same number as separate rows in creation order", () => {
  const [group] = groupRunsBySort([
    run("late", { sortId: "s", roundNumber: 2, createdAt: "2026-11-03T00:00:00.000Z" }),
    run("first", { sortId: "s", roundNumber: 1 }),
    run("early", { sortId: "s", roundNumber: 2, createdAt: "2026-11-02T00:00:00.000Z" }),
  ]);
  assert.deepEqual(group.rounds.map((item) => item.id), ["first", "early", "late"]);
});

test("a revised path with its own sort ID and runs without a sort ID form their own groups", () => {
  const groups = groupRunsBySort([
    run("original", { sortId: "s", roundNumber: 1 }),
    run("revised", { sortId: "r", roundNumber: 2, revisesRunId: "original" }),
    run("legacy", { roundNumber: 1 }),
  ]);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.find((group) => group.key === "r").rounds.map((item) => item.id), ["revised"]);
  assert.ok(groups.some((group) => group.key === "legacy"));
});
