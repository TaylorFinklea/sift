import test from "node:test";
import assert from "node:assert/strict";
import { sortActionForKey } from "../src/lib/sort-keyboard.js";

const enabled = { view: "sort", isTyping: false, hasDialog: false, metaKey: false, ctrlKey: false, altKey: false };
const navigationKeys = ["ArrowLeft", "h", "H", "ArrowRight", "l", "L", "z"];

test("sort shortcuts do not act from collection, history, or API-key views", () => {
  for (const view of ["collections", "history", "api-keys"]) {
    for (const key of navigationKeys) {
      assert.equal(sortActionForKey({ ...enabled, view, key }), null, `${view} + ${key}`);
    }
  }
});

test("sort shortcuts map only when sorting and no editor or modifier is active", () => {
  for (const key of ["ArrowLeft", "h", "H"]) {
    assert.equal(sortActionForKey({ ...enabled, key }), "discard", key);
  }
  for (const key of ["ArrowRight", "l", "L"]) {
    assert.equal(sortActionForKey({ ...enabled, key }), "keep", key);
  }
  assert.equal(sortActionForKey({ ...enabled, key: "z" }), "undo");
  assert.equal(sortActionForKey({ ...enabled, key: "h", isTyping: true }), null);
  assert.equal(sortActionForKey({ ...enabled, key: "h", hasDialog: true }), null);
  assert.equal(sortActionForKey({ ...enabled, key: "h", metaKey: true }), null);
  assert.equal(sortActionForKey({ ...enabled, key: "h", ctrlKey: true }), null);
  assert.equal(sortActionForKey({ ...enabled, key: "h", altKey: true }), null);
  assert.equal(sortActionForKey({ ...enabled, key: "a" }), null);
  assert.equal(sortActionForKey({ ...enabled, key: "d" }), null);
  assert.equal(sortActionForKey({ ...enabled, key: "x" }), null);
});

test("rating sliders keep arrow and H/L controls for the focused scale instead of recording keep/discard", () => {
  for (const key of ["ArrowLeft", "h", "H", "ArrowRight", "l", "L"]) {
    assert.equal(sortActionForKey({ ...enabled, isRating: true, key }), null, key);
  }
  assert.equal(sortActionForKey({ ...enabled, isRating: true, key: "z" }), "undo");
});
