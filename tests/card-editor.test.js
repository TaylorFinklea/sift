import assert from "node:assert/strict";
import { test } from "node:test";
import { createEditableCards, createEditableCardsFromTitles, serializeCards } from "../src/lib/card-editor.js";

test("editor keeps stable IDs and optional metadata on collection edits", () => {
  const original = [{ id: "keep-me", text: "Choice", detail: "Context", pros: ["Good"], cons: ["Cost"] }];
  const editable = createEditableCards(original);
  editable[0].text = "Renamed";
  assert.deepEqual(serializeCards(editable), [{
    id: "keep-me", text: "Renamed", detail: "Context", pros: ["Good"], cons: ["Cost"],
  }]);
});

test("raw list text keeps spaces and newlines while typing, then trims blank rows on save", () => {
  const [card] = createEditableCards([{ id: "raw", text: "Choice" }]);
  card.prosText = "A reason with a space\n\n Next reason ";
  card.consText = "  A tradeoff\n";
  assert.equal(card.prosText, "A reason with a space\n\n Next reason ");
  assert.deepEqual(serializeCards([card]), [{
    id: "raw", text: "Choice", detail: "", pros: ["A reason with a space", "Next reason"], cons: ["A tradeoff"],
  }]);
});

test("editor fills legacy fields and keeps blank-title cards for explicit correction or removal", () => {
  const [legacy, added, cleared] = createEditableCards([
    { id: "legacy", text: "Old" }, { text: "New" }, { id: "cleared", text: "Was here", pros: ["Still here"] },
  ]);
  cleared.text = "   ";
  assert.deepEqual(serializeCards([legacy, added, cleared]), [
    { id: "legacy", text: "Old", detail: "", pros: [], cons: [] },
    { id: added.id, text: "New", detail: "", pros: [], cons: [] },
    { id: "cleared", text: "", detail: "", pros: ["Still here"], cons: [] },
  ]);
});

test("pending bulk titles append on save without changing existing card identity or context", () => {
  const original = [{ id: "existing", text: "Consulting", detail: "Client work", pros: ["Flexible"], cons: ["Travel"] }];
  const editable = createEditableCards(original);
  const additions = createEditableCardsFromTitles("\n Gardening \r\n\nFriends\n Service \n");

  assert.deepEqual(serializeCards([...editable, ...additions]), [
    { id: "existing", text: "Consulting", detail: "Client work", pros: ["Flexible"], cons: ["Travel"] },
    ...additions.map((card, index) => ({ id: card.id, text: ["Gardening", "Friends", "Service"][index], detail: "", pros: [], cons: [] })),
  ]);
  assert.deepEqual(serializeCards(editable), [
    { id: "existing", text: "Consulting", detail: "Client work", pros: ["Flexible"], cons: ["Travel"] },
  ]);
});

test("pending bulk titles alone serialize as a valid card list", () => {
  const cards = createEditableCardsFromTitles("First\nSecond");
  assert.deepEqual(serializeCards(cards).map((card) => card.text), ["First", "Second"]);
});

test("blank pending titles add no cards and cleared bulk text cannot append the same titles twice", () => {
  const existing = createEditableCards([{ id: "first", text: "One" }]);
  assert.deepEqual(createEditableCardsFromTitles(" \n\r\n "), []);

  const bulkText = "Two\nThree";
  const added = createEditableCardsFromTitles(bulkText);
  const afterAdd = [...existing, ...added];
  const afterSave = [...afterAdd, ...createEditableCardsFromTitles("")];
  assert.deepEqual(serializeCards(afterSave).map((card) => card.text), ["One", "Two", "Three"]);
});

test("numeric card values survive collection edits and explicit clearing removes only that field", () => {
  const original = [{ id: "card-1", text: "Home", numericValues: { "field-cost": 42, "field-weight": 0 } }];
  const [card] = createEditableCards(original);
  card.text = "Home office";
  card.numericValues["field-cost"] = null;
  const [saved] = serializeCards([card]);
  assert.deepEqual(saved.numericValues, { "field-weight": 0 });
  assert.deepEqual(serializeCards(createEditableCards([{ id: "legacy", text: "Legacy" }])), [
    { id: "legacy", text: "Legacy", detail: "", pros: [], cons: [] },
  ]);
});
