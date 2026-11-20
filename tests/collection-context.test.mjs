import test from "node:test";
import assert from "node:assert/strict";
import { collectionForRun } from "../src/lib/collection-context.js";

test("a refinement uses the collection belonging to the selected history run", () => {
  const collectionA = { id: "a", name: "Collection A" };
  const collectionB = { id: "b", name: "Collection B" };
  const runB = { id: "run-b", collectionId: "b" };
  assert.equal(collectionForRun(runB, [collectionA, collectionB]), collectionB);
});

test("a run snapshot name is used if its collection is no longer in the workspace", () => {
  assert.deepEqual(collectionForRun({ collectionId: "gone", collectionName: "Archived values" }, []), { name: "Archived values" });
  assert.equal(collectionForRun({ collectionId: "gone" }, []), null);
});
