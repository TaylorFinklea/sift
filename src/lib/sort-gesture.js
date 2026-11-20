const SWIPE_THRESHOLD = 76;
const POINTER_VERTICAL_INTENT_THRESHOLD = 12;

/** Record a gesture only when a single touch starts on the card stack. */
export function beginSortGesture(touches) {
  if (touches.length !== 1) return null;
  const touch = touches[0];
  return { identifier: touch.identifier, x: touch.clientX, y: touch.clientY, scrolling: false };
}

/** Cancel multitouch and gestures whose movement has committed to vertical scrolling. */
export function moveSortGesture(gesture, touches) {
  if (!gesture || touches.length !== 1) return null;
  const touch = Array.from(touches).find(({ identifier }) => identifier === gesture.identifier);
  if (!touch) return null;
  const deltaX = touch.clientX - gesture.x;
  const deltaY = touch.clientY - gesture.y;
  if (Math.abs(deltaY) > 12 && Math.abs(deltaY) > Math.abs(deltaX) * 0.8) return null;
  return gesture;
}

/** Return a choice only after the tracked finger ends with no other fingers down. */
export function finishSortGesture(gesture, changedTouches, activeTouches) {
  if (!gesture || activeTouches.length !== 0) return null;
  const touch = Array.from(changedTouches).find(({ identifier }) => identifier === gesture.identifier);
  if (!touch) return null;

  if (gesture.scrolling) return null;
  const deltaX = touch.clientX - gesture.x;
  const deltaY = touch.clientY - gesture.y;
  if (Math.abs(deltaX) <= SWIPE_THRESHOLD || Math.abs(deltaX) <= Math.abs(deltaY) * 1.25) return null;
  return deltaX > 0 ? "keep" : "discard";
}

/** Start a pointer gesture for a finger or primary mouse button. */
export function beginPointerSortGesture({ pointerId, x, y, pointerType = "touch" }) {
  if (!Number.isFinite(pointerId) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { pointerId, startX: x, startY: y, x, y, pointerType, intent: "pending" };
}

/** Track a pointer while canceling multitouch and vertical scrolling intent. */
export function movePointerSortGesture(gesture, { pointerId, x, y, activePointers = 1 } = {}) {
  if (!gesture || activePointers !== 1 || pointerId !== gesture.pointerId) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  const deltaX = x - gesture.startX;
  const deltaY = y - gesture.startY;
  if (Math.abs(deltaY) > POINTER_VERTICAL_INTENT_THRESHOLD
    && Math.abs(deltaY) > Math.abs(deltaX) * 0.8) return null;

  return {
    ...gesture,
    x,
    y,
    intent: Math.abs(deltaX) > Math.abs(deltaY) ? "horizontal" : "pending",
  };
}

/** Resolve a completed pointer gesture into a choice only past the swipe threshold. */
export function finishPointerSortGesture(gesture, {
  pointerId,
  x,
  y,
  activePointers = 0,
  threshold = SWIPE_THRESHOLD,
} = {}) {
  if (!gesture || pointerId !== gesture.pointerId || activePointers !== 0) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  const deltaX = x - gesture.startX;
  const deltaY = y - gesture.startY;
  if (gesture.intent !== "horizontal"
    || Math.abs(deltaX) <= threshold
    || Math.abs(deltaX) <= Math.abs(deltaY) * 1.25) return null;
  return deltaX > 0 ? "keep" : "discard";
}

export function isStandaloneDisplay({ displayMode = false, iosStandalone = false } = {}) {
  return displayMode || iosStandalone;
}

export function isIOSDevice({ userAgent = "", platform = "", maxTouchPoints = 0 } = {}) {
  return /iPad|iPhone|iPod/u.test(userAgent)
    || (platform === "MacIntel" && maxTouchPoints > 1);
}
