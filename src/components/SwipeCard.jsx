import { useCallback, useEffect, useRef } from "react";
import {
  beginPointerSortGesture,
  finishPointerSortGesture,
  movePointerSortGesture,
} from "../lib/sort-gesture.js";
import "./swipe-card.css";

const SWIPE_THRESHOLD = 76;

function clearCardPresentation(card) {
  if (!card) return;
  card.style.removeProperty("transform");
  card.style.removeProperty("box-shadow");
  card.style.removeProperty("transition");
}

function getActiveCard(stack) {
  return stack?.querySelector(".active-card") || null;
}

export default function SwipeCard({ cardKey, disabled = false, canKeep = true, onChoice, children }) {
  const stackRef = useRef(null);
  const gestureRef = useRef(null);
  const pointersRef = useRef(new Set());
  const frameRef = useRef(0);
  const visualRef = useRef({ x: 0, y: 0, blocked: false });
  const returnRef = useRef(null);
  const returnGenerationRef = useRef(0);

  const cancelReturn = useCallback(() => {
    const activeReturn = returnRef.current;
    returnRef.current = null;
    returnGenerationRef.current += 1;
    if (!activeReturn) return;
    window.clearTimeout(activeReturn.timer);
    activeReturn.card.removeEventListener("transitionend", activeReturn.finish);
  }, []);

  const cancelVisual = useCallback(() => {
    cancelReturn();
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
    const stack = stackRef.current;
    if (!stack) return;
    stack.classList.remove("is-dragging", "is-returning");
    delete stack.dataset.direction;
    delete stack.dataset.blocked;
    clearCardPresentation(getActiveCard(stack));
  }, [cancelReturn]);

  const cancelGesture = useCallback(() => {
    const stack = stackRef.current;
    const pointerId = gestureRef.current?.pointerId;
    gestureRef.current = null;
    pointersRef.current.clear();
    if (pointerId != null && stack?.hasPointerCapture?.(pointerId)) {
      try { stack.releasePointerCapture(pointerId); } catch { /* Capture may have ended with the gesture. */ }
    }
    cancelVisual();
  }, [cancelVisual]);

  useEffect(() => {
    cancelGesture();
  }, [cardKey, disabled, cancelGesture]);

  useEffect(() => () => {
    cancelReturn();
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    const stack = stackRef.current;
    const pointerId = gestureRef.current?.pointerId;
    if (pointerId != null && stack?.hasPointerCapture?.(pointerId)) {
      try { stack.releasePointerCapture(pointerId); } catch { /* Component is unmounting. */ }
    }
  }, [cancelReturn]);

  const scheduleVisualUpdate = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      const stack = stackRef.current;
      const card = getActiveCard(stack);
      if (!stack || !card || !gestureRef.current) return;

      const { x, y, blocked } = visualRef.current;
      const intensity = Math.min(1, Math.abs(x) / (SWIPE_THRESHOLD * 1.8));
      const direction = x >= 0 ? "keep" : "discard";
      const glow = direction === "keep"
        ? (blocked ? "255, 94, 115" : "92, 242, 140")
        : "255, 94, 115";
      stack.dataset.direction = direction;
      if (blocked) stack.dataset.blocked = "true";
      else delete stack.dataset.blocked;
      stack.classList.add("is-dragging");
      card.style.transition = "none";
      card.style.transform = `translate3d(${x}px, ${y * 0.12 - 6}px, 0) rotate(${Math.max(-7, Math.min(7, x / 42))}deg)`;
      card.style.boxShadow = `0 0 0 1px rgba(${glow}, ${0.16 + intensity * 0.52}), 0 0 ${8 + intensity * 32}px rgba(${glow}, ${0.15 + intensity * 0.48}), 0 19px 42px rgba(0, 0, 0, .52)`;
    });
  }, []);

  const handlePointerDown = useCallback((event) => {
    if (disabled) return;
    const pointers = pointersRef.current;
    pointers.add(event.pointerId);
    if (pointers.size !== 1) {
      gestureRef.current = null;
      cancelVisual();
      return;
    }
    if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) {
      pointers.delete(event.pointerId);
      return;
    }

    cancelVisual();
    gestureRef.current = beginPointerSortGesture({
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      pointerType: event.pointerType,
    });
    visualRef.current = { x: 0, y: 0, blocked: false };
    const card = getActiveCard(stackRef.current);
    if (card) {
      card.style.transition = "none";
      card.style.transform = "translate3d(0, -6px, 0) rotate(0deg)";
    }
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Capture is optional on older browsers. */ }
  }, [cancelVisual, disabled]);

  const handlePointerMove = useCallback((event) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    const updated = movePointerSortGesture(gesture, {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      activePointers: pointersRef.current.size,
    });
    if (!updated) {
      cancelGesture();
      return;
    }
    gestureRef.current = updated;
    if (updated.intent !== "horizontal") return;
    const x = event.clientX - updated.startX;
    const y = event.clientY - updated.startY;
    visualRef.current = { x, y, blocked: x > 0 && !canKeep };
    scheduleVisualUpdate();
  }, [canKeep, cancelGesture, scheduleVisualUpdate]);

  const handlePointerEnd = useCallback((event, canceled = false) => {
    const gesture = gestureRef.current;
    pointersRef.current.delete(event.pointerId);
    if (!gesture || gesture.pointerId !== event.pointerId) {
      if (pointersRef.current.size === 0) cancelVisual();
      return;
    }

    const choice = canceled ? null : finishPointerSortGesture(gesture, {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      activePointers: pointersRef.current.size,
    });
    gestureRef.current = null;
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    } catch { /* The browser may have already released capture. */ }

    const stack = stackRef.current;
    const card = getActiveCard(stack);
    stack?.classList.remove("is-dragging");
    if (choice && (choice !== "keep" || canKeep) && !disabled) {
      cancelVisual();
      onChoice?.(choice);
      return;
    }

    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
    if (stack) stack.classList.add("is-returning");
    if (card) {
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      card.style.transition = reduceMotion ? "none" : "transform 220ms cubic-bezier(.2,.75,.25,1), box-shadow 220ms ease";
      card.style.transform = "translate3d(0, -6px, 0) rotate(0deg)";
      card.style.boxShadow = "";
      const generation = ++returnGenerationRef.current;
      const activeReturn = { generation, timer: 0, card, stack, finish: null };
      const finishReturn = (event) => {
        if (event && (event.target !== card || event.propertyName !== "transform")) return;
        if (returnRef.current !== activeReturn || generation !== returnGenerationRef.current) return;
        cancelReturn();
        if (stackRef.current === stack && !gestureRef.current) {
          stack?.classList.remove("is-returning");
          delete stack.dataset.direction;
          delete stack.dataset.blocked;
          clearCardPresentation(card);
        }
      };
      activeReturn.finish = finishReturn;
      returnRef.current = activeReturn;
      card.addEventListener("transitionend", finishReturn);
      activeReturn.timer = window.setTimeout(() => finishReturn(), reduceMotion ? 0 : 260);
    } else {
      cancelVisual();
    }
  }, [canKeep, cancelReturn, cancelVisual, disabled, onChoice]);

  return (
    <div
      ref={stackRef}
      className="card-stack swipe-card-stack"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => handlePointerEnd(event)}
      onPointerCancel={(event) => handlePointerEnd(event, true)}
      onLostPointerCapture={(event) => {
        if (gestureRef.current?.pointerId === event.pointerId) handlePointerEnd(event, true);
      }}
      aria-label="Sort card. Drag right to keep or left to let go."
      data-disabled={disabled ? "true" : undefined}
    >
      <div className="card-stack__back card-stack__back--three" aria-hidden="true" />
      <div className="card-stack__back card-stack__back--two" aria-hidden="true" />
      <div className="card-stack__back card-stack__back--one" aria-hidden="true" />
      {children}
    </div>
  );
}
