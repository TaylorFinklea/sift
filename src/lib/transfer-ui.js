import { validateTransfer } from "../../shared/transfer.js";

export const MAX_TRANSFER_FILE_BYTES = 16 * 1024 * 1024;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function graphemeCount(value) {
  return [...graphemes.segment(String(value))].length;
}

export function parseTransferFile(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("This file is not valid JSON. Choose a Sift transfer file."); }
  return validateTransfer(value);
}

export function transferFilename(collectionName) {
  const slug = String(collectionName || "library").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `sift-${slug || "library"}.sift.json`;
}
