export function sortActionForKey({ key: rawKey, view, isTyping, hasDialog, isRating, metaKey, ctrlKey, altKey }) {
  if (view !== "sort" || isTyping || hasDialog || metaKey || ctrlKey || altKey) return null;
  const key = rawKey.toLowerCase();
  if (key === "z") return "undo";
  if (isRating) return null;
  if (key === "arrowleft" || key === "h") return "discard";
  if (key === "arrowright" || key === "l") return "keep";
  return null;
}
