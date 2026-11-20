import { useRef, useState } from "react";
import { DownloadSimple, UploadSimple } from "@phosphor-icons/react";
import { exportTransfer, importTransfer, previewTransfer } from "../lib/api.js";
import { MAX_TRANSFER_FILE_BYTES, parseTransferFile, transferFilename } from "../lib/transfer-ui.js";

function saveArchive(archive, name) {
  const blob = new Blob([JSON.stringify(archive)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export default function Transfer({ collections, offline, onImported }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(null);

  async function exportLibrary(collectionId) {
    setBusy(true); setMessage("");
    try {
      const archive = parseTransferFile(JSON.stringify(await exportTransfer(collectionId)));
      const chosen = collections.find((item) => item.id === collectionId)?.name;
      saveArchive(archive, transferFilename(chosen));
      setMessage(`Exported ${archive.collections.length} ${archive.collections.length === 1 ? "collection" : "collections"} with complete history.`);
    } catch (error) { setMessage(error.message || "The export could not be created."); }
    finally { setBusy(false); }
  }

  async function selectFile(event) {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file) return;
    if (file.size > MAX_TRANSFER_FILE_BYTES) { setMessage("This file exceeds the 16 MiB transfer limit."); return; }
    setBusy(true); setMessage(""); setPending(null);
    try {
      const archive = parseTransferFile(await file.text());
      const preview = await previewTransfer(archive);
      setPending({ archive, preview });
      setMessage("");
    } catch (error) { setMessage(error.message || "Choose a supported Sift transfer file."); }
    finally { setBusy(false); }
  }

  async function confirmImport() {
    if (!pending) return;
    setBusy(true); setMessage("");
    try {
      const result = await importTransfer(pending.archive, pending.preview.previewToken);
      setPending(null);
      setMessage(result.message || `Imported ${result.importedCollections} collections. Existing data was preserved.`);
      onImported?.();
    } catch (error) { setMessage(error.message || "The import could not be completed. Preview the file again and retry."); }
    finally { setBusy(false); }
  }

  return <section className="transfer-tools transfer-tools--toolbar" aria-label="Library backup and restore">
    <div className="transfer-tools__actions transfer-tools__toolbar-actions">
      <button className="icon-button transfer-tools__utility" type="button" aria-label="Export library" title="Export library" disabled={busy || offline || !collections.length} onClick={() => exportLibrary()}><DownloadSimple /><span className="transfer-tools__label">Export library</span></button>
      <button className="icon-button transfer-tools__utility" type="button" aria-label="Import file" title="Import file" disabled={busy || offline} onClick={() => inputRef.current?.click()}><UploadSimple /><span className="transfer-tools__label">Import</span></button>
      <input ref={inputRef} className="visually-hidden" type="file" accept="application/json,.json" onChange={selectFile} aria-label="Choose a Sift transfer file" />
    </div>
    {pending ? <div className="transfer-preview" role="group" aria-label="Import preview">
      <p><strong>{pending.preview.summary?.collectionCount ?? pending.archive.collections.length} {((pending.preview.summary?.collectionCount ?? pending.archive.collections.length) === 1) ? "collection" : "collections"}</strong> · {pending.preview.summary?.recordCount ?? pending.archive.collections.reduce((n, item) => n + item.records.length, 0)} complete history records · {pending.preview.summary?.duplicateCount ?? 0} already present · {pending.preview.summary?.conflictCount ?? 0} conflicts will be preserved as separate versions.</p>
      {pending.preview.summary?.collections?.length ? <ul className="transfer-preview__collections" aria-label="Collections included in this file">
        {pending.preview.summary.collections.map((collection, index) => <li key={`${collection.name}-${index}`}>
          <strong>{collection.name}</strong>
          <span>{collection.cardCount} {collection.cardCount === 1 ? "card" : "cards"} · {collection.historyPathCount ? `${collection.historyPathCount} history ${collection.historyPathCount === 1 ? "path" : "paths"}` : "No sort history"}{collection.roundCount ? ` · ${collection.roundCount} ${collection.roundCount === 1 ? "round" : "rounds"}` : ""}</span>
        </li>)}
      </ul> : null}
      <div className="transfer-tools__actions"><button className="button button--cyan" type="button" disabled={busy || offline} onClick={confirmImport}>Add to library</button><button className="button button--quiet" type="button" disabled={busy} onClick={() => setPending(null)}>Cancel</button></div>
    </div> : null}
    {message ? <p className="transfer-tools__message" role="status">{message}</p> : null}
    {busy ? <p className="transfer-tools__message" role="status">Working with the library…</p> : null}
  </section>;
}
