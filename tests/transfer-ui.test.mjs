import assert from "node:assert/strict";
import { test } from "node:test";
import { webWorkspaceToTransfer } from "../shared/transfer.js";
import { graphemeCount, MAX_TRANSFER_FILE_BYTES, parseTransferFile, transferFilename } from "../src/lib/transfer-ui.js";

const archive = webWorkspaceToTransfer({ collections: [{
  id: "b7ec2331-1d16-4bb2-b1aa-42963a316da2",
  name: "My ideas / 2026",
  cards: [{ id: "c4fba9ef-45a5-4989-ac32-b15542713716", text: "Keep this", detail: "Context", pros: [], cons: [] },
    { id: "63a28b31-cb80-4970-86c3-d3364c3d9030", text: "Maybe", detail: "", pros: [], cons: [] }],
}] });

test("transfer file picker helper validates supported JSON before server preview", () => {
  assert.deepEqual(parseTransferFile(JSON.stringify(archive)), archive);
  assert.throws(() => parseTransferFile("{"), /valid JSON/);
  assert.deepEqual(parseTransferFile(JSON.stringify({ ...archive, version: 2 })), { ...archive, version: 2 });
  assert.throws(() => parseTransferFile(JSON.stringify({ ...archive, version: 3 })), /Unsupported transfer format or version/);
  assert.equal(MAX_TRANSFER_FILE_BYTES, 16 * 1024 * 1024);
});

test("transfer download filenames are stable and safe", () => {
  assert.equal(transferFilename("My ideas / 2026"), "sift-my-ideas-2026.sift.json");
  assert.equal(transferFilename("☁️"), "sift-library.sift.json");
  assert.equal(transferFilename(undefined), "sift-library.sift.json");
});

test("imported native Unicode lengths match Swift grapheme counts", () => {
  assert.equal(graphemeCount("😀".repeat(100)), 100);
  assert.equal(graphemeCount("e\u0301".repeat(80)), 80);
});
