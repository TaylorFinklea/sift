import test from "node:test";
import assert from "node:assert/strict";
import {
  beginSortGesture,
  beginPointerSortGesture,
  finishPointerSortGesture,
  finishSortGesture,
  isIOSDevice,
  isStandaloneDisplay,
  moveSortGesture,
  movePointerSortGesture,
} from "../src/lib/sort-gesture.js";

const touch = (identifier, clientX, clientY) => ({ identifier, clientX, clientY });

test("one horizontal finger maps left and right to the matching sort choice", () => {
  const start = beginSortGesture([touch(4, 160, 100)]);
  assert.equal(finishSortGesture(start, [touch(4, 70, 110)], []), "discard");
  assert.equal(finishSortGesture(start, [touch(4, 250, 108)], []), "keep");
});

test("vertical scrolling and short movements never become sort choices", () => {
  const start = beginSortGesture([touch(1, 100, 100)]);
  const scrolling = moveSortGesture(start, [touch(1, 108, 124)]);
  assert.equal(scrolling, null);
  assert.equal(finishSortGesture(scrolling, [touch(1, 220, 130)], []), null);
  assert.equal(finishSortGesture(start, [touch(1, 160, 100)], []), null);
});

test("multitouch, unmatched fingers, and remaining fingers cancel the gesture", () => {
  assert.equal(beginSortGesture([touch(1, 0, 0), touch(2, 20, 0)]), null);
  const start = beginSortGesture([touch(1, 0, 0)]);
  assert.equal(moveSortGesture(start, [touch(1, 0, 0), touch(2, 10, 0)]), null);
  assert.equal(finishSortGesture(start, [touch(2, 100, 0)], []), null);
  assert.equal(finishSortGesture(start, [touch(1, 100, 0)], [touch(2, 10, 0)]), null);
  assert.equal(finishSortGesture(null, [touch(1, 100, 0)], []), null);
});

test("pointer gestures follow one finger and resolve only after a horizontal release threshold", () => {
  const start = beginPointerSortGesture({ pointerId: 8, x: 160, y: 100, pointerType: "touch" });
  const movingRight = movePointerSortGesture(start, { pointerId: 8, x: 250, y: 108 });
  const movingLeft = movePointerSortGesture(start, { pointerId: 8, x: 70, y: 105 });
  assert.equal(movingRight.intent, "horizontal");
  assert.equal(finishPointerSortGesture(movingRight, { pointerId: 8, x: 250, y: 108 }), "keep");
  assert.equal(finishPointerSortGesture(movingLeft, { pointerId: 8, x: 70, y: 105 }), "discard");
  assert.equal(finishPointerSortGesture(movingRight, { pointerId: 8, x: 205, y: 108 }), null);
});

test("pointer vertical intent, multitouch, mismatched ids, and cancellation never sort", () => {
  const start = beginPointerSortGesture({ pointerId: 2, x: 100, y: 100 });
  assert.equal(movePointerSortGesture(start, { pointerId: 2, x: 108, y: 124 }), null);
  assert.equal(movePointerSortGesture(start, { pointerId: 2, x: 170, y: 102, activePointers: 2 }), null);
  assert.equal(movePointerSortGesture(start, { pointerId: 3, x: 170, y: 102 }), null);
  assert.equal(finishPointerSortGesture(start, { pointerId: 2, x: 200, y: 100, activePointers: 1 }), null);
  assert.equal(finishPointerSortGesture(start, { pointerId: 3, x: 200, y: 100 }), null);
  assert.equal(finishPointerSortGesture(null, { pointerId: 2, x: 200, y: 100 }), null);
});

test("install helpers detect Apple mobile, iPad desktop mode, and standalone display", () => {
  assert.equal(isIOSDevice({ userAgent: "Mozilla iPhone", platform: "iPhone" }), true);
  assert.equal(isIOSDevice({ platform: "MacIntel", maxTouchPoints: 5 }), true);
  assert.equal(isIOSDevice({ userAgent: "Mozilla Android", platform: "Linux" }), false);
  assert.equal(isStandaloneDisplay({ displayMode: true }), true);
  assert.equal(isStandaloneDisplay({ iosStandalone: true }), true);
  assert.equal(isStandaloneDisplay({}), false);
});
