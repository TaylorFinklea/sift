import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowCounterClockwise, ClockCounterClockwise, DownloadSimple, Info, Key, ListBullets } from "@phosphor-icons/react";
import {
  ApiError,
  createCollection,
  createRun,
  getCapabilities,
  loadWorkspace,
  mergeRunIntoWorkspace,
  readCachedWorkspace,
  reviseDecision,
  saveDecision,
  skipCard,
  undoDecision,
  updateCollection,
  updateRoundPlan,
} from "./lib/api.js";
import { sortActionForKey } from "./lib/sort-keyboard.js";
import { isIOSDevice, isStandaloneDisplay } from "./lib/sort-gesture.js";
import { collectionForRun } from "./lib/collection-context.js";
import { pendingCardsInQueueOrder, roundTitleFor } from "./lib/sort-session.js";
import { activeDecisions, DEFAULT_DISCARD, DEFAULT_KEEP, formatError, isRatingRound, sortNewest } from "./lib/run-utils.js";
import Modal from "./components/Modal.jsx";
import CollectionDialog from "./dialogs/CollectionDialog.jsx";
import RoundDialog from "./dialogs/RoundDialog.jsx";
import RoundPlanDialog from "./dialogs/RoundPlanDialog.jsx";
import ReviewDialog from "./dialogs/ReviewDialog.jsx";
import SortView from "./views/SortView.jsx";
import CollectionsView from "./views/CollectionsView.jsx";
import HistoryView from "./views/HistoryView.jsx";
import ApiKeysView from "./views/ApiKeysView.jsx";

/** Validates the API base URL advertised by the Cloudflare runtime; anything else hides key management. */
function safeApiBaseUrl(capabilities) {
  if (capabilities?.apiKeys !== true) return "";
  try {
    const url = new URL(capabilities?.apiBaseUrl);
    if (url.protocol === "https:" && !url.username && !url.password) return url.href.replace(/\/$/, "");
  } catch {
    // An invalid or absent endpoint keeps key management hidden.
  }
  return "";
}

const readStandalone = (displayMode) => isStandaloneDisplay({
  displayMode: displayMode?.matches || false,
  iosStandalone: navigator.standalone === true,
});

function App() {
  const [workspace, setWorkspace] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState("sort");
  const [collectionId, setCollectionId] = useState("");
  const [runId, setRunId] = useState("");
  const [dialog, setDialog] = useState(null);
  const [reviewRunId, setReviewRunId] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [installPrompt, setInstallPrompt] = useState(null);
  const [installHelpOpen, setInstallHelpOpen] = useState(false);
  const [iosDevice] = useState(() => isIOSDevice({ userAgent: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints }));
  const [standalone, setStandalone] = useState(() => readStandalone(window.matchMedia?.("(display-mode: standalone)")));
  const [browserOnline, setBrowserOnline] = useState(() => navigator.onLine);
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [ratingSort, setRatingSort] = useState("high");
  const refreshSequence = useRef(0);
  const initialViewChosen = useRef(false);

  // On first load only, open the library when nothing is in progress. Later refreshes
  // (reconnects, imports, conflicts) never move the user to another view.
  const chooseInitialView = (loadedRuns) => {
    if (initialViewChosen.current) return;
    initialViewChosen.current = true;
    if (!loadedRuns.some((run) => run.status === "in-progress")) setView("collections");
  };

  // Loads the authoritative workspace. Only the newest request may commit, and a failed
  // load falls back to the read-only offline cache when one exists.
  const refresh = useCallback(async (quiet = false) => {
    const sequence = ++refreshSequence.current;
    if (!quiet) setLoading(true);
    setLoadError("");
    try {
      const shouldCommit = () => sequence === refreshSequence.current;
      const fresh = await loadWorkspace({ shouldCommit });
      if (!shouldCommit()) return null;
      setWorkspace(fresh);
      chooseInitialView(fresh.runs);
      setCollectionId((oldId) => oldId && fresh.collections.some((collection) => collection.id === oldId)
        ? oldId
        : fresh.collections[0]?.id || "");
      const mostRecent = fresh.runs.slice().sort(sortNewest);
      setRunId((oldId) => oldId && mostRecent.some((run) => run.id === oldId)
        ? oldId
        : mostRecent.find((run) => run.status === "in-progress")?.id || mostRecent[0]?.id || "");
      setBrowserOnline(navigator.onLine);
      return fresh;
    } catch (error) {
      if (sequence !== refreshSequence.current) return null;
      const cached = readCachedWorkspace();
      if (cached) {
        setWorkspace({ ...cached, offline: true });
        chooseInitialView(cached.runs);
        setCollectionId((oldId) => oldId || cached.collections[0]?.id || "");
        const activeRun = cached.runs.find((run) => run.status === "in-progress");
        setRunId((oldId) => oldId || activeRun?.id || cached.runs[0]?.id || "");
      } else {
        setLoadError(formatError(error));
      }
    } finally {
      if (sequence === refreshSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    let current = true;
    getCapabilities()
      .then((capabilities) => { if (current) setApiBaseUrl(safeApiBaseUrl(capabilities)); })
      // Older Node installs and inaccessible capability endpoints simply omit this feature.
      .catch(() => { if (current) setApiBaseUrl(""); });
    return () => { current = false; };
  }, []);

  // PWA install, standalone display and online/offline tracking.
  useEffect(() => {
    if (import.meta.env.PROD && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/service-worker.js").catch((error) => {
        console.warn("Sift service worker registration failed.", error);
      });
    }
    const displayMode = window.matchMedia?.("(display-mode: standalone)");
    const updateStandalone = () => setStandalone(readStandalone(displayMode));
    const onInstall = (event) => {
      event.preventDefault();
      setInstallPrompt(event);
    };
    const onInstalled = () => { setStandalone(true); setInstallPrompt(null); setInstallHelpOpen(false); };
    const onOffline = () => {
      refreshSequence.current += 1;
      setBrowserOnline(false);
      refresh(true);
    };
    const onOnline = () => { refresh(true); };
    window.addEventListener("beforeinstallprompt", onInstall);
    window.addEventListener("appinstalled", onInstalled);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    displayMode?.addEventListener?.("change", updateStandalone);
    return () => {
      window.removeEventListener("beforeinstallprompt", onInstall);
      window.removeEventListener("appinstalled", onInstalled);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      displayMode?.removeEventListener?.("change", updateStandalone);
    };
  }, [refresh]);

  useEffect(() => {
    if (!toast) return undefined;
    const timeout = window.setTimeout(() => setToast(""), 3800);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const collections = workspace?.collections || [];
  const runs = workspace?.runs || [];
  const run = runs.find((item) => item.id === runId) || null;
  const displayedCollectionId = view === "sort" && run ? run.collectionId : collectionId;
  const selectedCollection = collections.find((item) => item.id === displayedCollectionId) || collections[0] || null;
  const decisions = activeDecisions(run);
  const decisionsByCard = useMemo(() => new Map(decisions.map((decision) => [decision.cardId, decision])), [decisions]);
  const pendingCards = pendingCardsInQueueOrder(run, decisionsByCard);
  const activeCard = pendingCards[0] || null;
  const reviewRun = runs.find((item) => item.id === reviewRunId) || null;
  const ratingMode = isRatingRound(run);
  const keptCards = (run?.cards || []).filter((card) => decisionsByCard.get(card.id)?.choice === "keep");
  const discardedCards = (run?.cards || []).filter((card) => decisionsByCard.get(card.id)?.choice === "discard");
  const keepLabel = run?.keepLabel || selectedCollection?.keepLabel || DEFAULT_KEEP;
  const discardLabel = run?.discardLabel || selectedCollection?.discardLabel || DEFAULT_DISCARD;
  const isOffline = Boolean(workspace?.connection && workspace.connection !== "online") || !browserOnline;
  const hasLaterResults = Boolean(run?.hasLaterResults) || runs.some((savedRun) => savedRun.parentRunId === run?.id);
  const canUndo = decisions.length > 0 && !isOffline && !busy && !hasLaterResults;
  const dialogOpen = Boolean(dialog) || Boolean(reviewRunId) || installHelpOpen;

  // Runs one write at a time. Writes are blocked offline; a 409 means another device or tab
  // saved first, so the authoritative state is reloaded.
  const perform = useCallback(async (action, { quiet = false, mergeRun = false } = {}) => {
    if (busy || isOffline) return null;
    setBusy(true);
    try {
      const result = await action();
      if (result?.collectionId) {
        setRunId(result.id);
        setCollectionId(result.collectionId);
        if (mergeRun && workspace) {
          setWorkspace(mergeRunIntoWorkspace(workspace, result));
        } else {
          await refresh(true);
        }
      } else {
        await refresh(true);
      }
      if (!quiet) setToast("Saved. Your sort is up to date.");
      return result;
    } catch (error) {
      setToast(formatError(error));
      if (error instanceof ApiError && error.status === 409) await refresh(true);
      return null;
    } finally {
      setBusy(false);
    }
  }, [busy, isOffline, refresh, workspace]);

  const decide = useCallback((choice, value) => {
    if (view !== "sort" || !run || !activeCard || busy || isOffline || (ratingMode !== (choice === "rating"))
      || (choice === "keep" && keptCards.length >= run.keepLimit)) return;
    if (choice === "rating" && !Number.isFinite(value)) return;
    perform(() => saveDecision(run, activeCard.id, choice, value), { quiet: true, mergeRun: true });
  }, [view, run, activeCard, busy, isOffline, ratingMode, keptCards.length, perform]);

  const undo = useCallback(() => {
    if (view !== "sort" || !run || !canUndo || hasLaterResults) return;
    perform(() => undoDecision(run), { quiet: true, mergeRun: true });
  }, [view, run, canUndo, hasLaterResults, perform]);

  const skipCurrent = useCallback(() => {
    if (view !== "sort" || !run || !activeCard || pendingCards.length <= 1 || busy || isOffline || dialogOpen) return;
    perform(() => skipCard(run, activeCard.id), { quiet: true, mergeRun: true });
  }, [view, run, activeCard, pendingCards.length, busy, isOffline, dialogOpen, perform]);

  const reviseReviewedChoice = useCallback((card, choice, value) => {
    if (!reviewRun || !card || busy || isOffline) return;
    const current = activeDecisions(reviewRun).find((decision) => decision.cardId === card.id);
    if (!current || (current.choice === choice && current.value === value)) return;
    if (choice !== "rating") {
      const kept = activeDecisions(reviewRun).filter((decision) => decision.choice === "keep").length;
      if (choice === "keep" && kept >= reviewRun.keepLimit) {
        setToast("Your keep limit is full. Change another keep first.");
        return;
      }
    }
    const oldId = reviewRun.id;
    const revise = choice === "rating" ? () => reviseDecision(reviewRun, card.id, choice, value) : () => reviseDecision(reviewRun, card.id, choice);
    perform(revise, { quiet: true, mergeRun: true }).then((updated) => {
      if (!updated) return;
      if (updated.id !== oldId) setToast(`${roundTitleFor(reviewRun)} updated. A new path was created; earlier results are preserved.`);
      else setToast(choice === "rating" ? "Rating updated." : "Answer updated.");
      setReviewRunId(updated.id);
    });
  }, [reviewRun, busy, isOffline, perform]);

  const savePlan = async (targetRun, rounds, afterSave = "") => {
    const updated = await perform(() => updateRoundPlan(targetRun, rounds), { quiet: true });
    if (updated) {
      setDialog(afterSave === "refine"
        ? { kind: "refine", parent: updated, collection: collectionForRun(updated, collections) }
        : null);
      setToast("Round plan saved for this sort.");
    }
  };

  // Desktop shortcuts: H/← let go, L/→ keep, Z undo. Inactive while typing, in dialogs and outside the sort view.
  useEffect(() => {
    const onKeyDown = (event) => {
      const target = event.target;
      const typing = target instanceof HTMLElement && (
        target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
        || target.closest("[data-card-scroll-region]") !== null
      );
      const action = sortActionForKey({
        key: event.key,
        view,
        isRating: ratingMode,
        isTyping: typing,
        hasDialog: dialogOpen,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
      });
      if (!action) return;
      event.preventDefault();
      if (action === "undo") undo();
      else decide(action);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [decide, undo, dialogOpen, view, ratingMode]);

  const startRound = async (input) => {
    const created = await perform(() => createRun(input), { quiet: true });
    if (created) {
      setDialog(null);
      setView("sort");
      setToast("Your new round is ready.");
    }
  };

  const showNewCollection = () => setDialog({ kind: "collection" });
  const showEditCollection = (item) => setDialog({ kind: "collection", collection: item });
  const showStartRound = (item = selectedCollection) => {
    if (!item) return showNewCollection();
    setDialog({ kind: "start", collection: item });
  };
  const showRefine = (parent) => setDialog({ kind: "refine", parent, collection: collectionForRun(parent, collections) });
  const showRoundPlan = (target = run, afterSave = "") => {
    if (!target) return;
    const sessionRuns = target.sortId ? runs.filter((saved) => saved.sortId === target.sortId) : [target];
    const startedRoundCount = Math.max(Number(target.roundNumber) || 1, ...sessionRuns.map((saved) => Number(saved.roundNumber) || 1));
    setDialog({ kind: "plan", run: target, startedRoundCount, afterSave });
  };
  const showReview = (target = run) => {
    if (target) setReviewRunId(target.id);
  };
  const switchToRun = (next) => {
    if (!next) return;
    setCollectionId(next.collectionId);
    setRunId(next.id);
    setView("sort");
  };
  const installApp = async () => {
    if (installPrompt) {
      await installPrompt.prompt();
      setInstallPrompt(null);
    } else {
      setInstallHelpOpen(true);
    }
  };

  if (loading && !workspace) {
    return <main className="loading-screen"><div className="loading-screen__orbit" /><p>Gathering your cards…</p></main>;
  }

  if (loadError && !workspace) {
    return (
      <main className="setup-screen">
        <img src="/assets/brand-mark.png" alt="" />
        <h1>Can’t reach the Sift server</h1>
        <p className="setup-screen__copy">Your collections load from the Sift server. Check that it is running, then try again.</p>
        <p className="error-note" role="alert">{loadError}</p>
        <button className="button button--cyan" type="button" onClick={() => refresh()}><ArrowCounterClockwise /> Try again</button>
      </main>
    );
  }

  const applyCollection = async (input) => {
    const action = dialog.collection
      ? () => updateCollection(dialog.collection.id, input, dialog.collection.updatedAt)
      : () => createCollection(input);
    const created = await perform(action, { quiet: true });
    if (created) {
      setCollectionId(created.id);
      setView("collections");
      setDialog(null);
      setToast(dialog.collection ? "Collection updated." : "Your collection is ready.");
    }
  };

  const navLink = (target, label, Icon) => (
    <button className={`nav-link ${view === target ? "is-current" : ""}`} type="button" aria-label={label} title={label} onClick={() => setView(target)}>
      <Icon /> <span>{label}</span>
    </button>
  );
  const statusLabel = busy ? "Saving" : isOffline ? "Offline, read only" : "Saved to your library";
  const shellClass = ["app-shell", view === "sort" ? "app-shell--sort" : "app-shell--library", view === "sort" && activeCard ? "app-shell--active-sort" : ""]
    .filter(Boolean).join(" ");

  return (
    <div className={shellClass}>
      <header className="topbar">
        <a className="brand" href="#sort" onClick={(event) => { event.preventDefault(); setView("sort"); }} aria-label="Sift home">
          <img src="/assets/brand-mark.png" alt="" /> <span>Sift</span>
        </a>
        <span className="topbar__divider" />
        <nav className="primary-nav" aria-label="Main navigation">
          {navLink("collections", "Collections", ListBullets)}
          {navLink("history", "History", ClockCounterClockwise)}
          {apiBaseUrl ? navLink("api-keys", "API keys", Key) : null}
        </nav>
        <div className="topbar__right">
          <div className={`connection-status ${isOffline ? "connection-status--offline" : ""}`} role="status" aria-label={statusLabel}>
            <span className="connection-status__dot" aria-hidden="true" />
            <span>{busy ? "Saving…" : isOffline ? "Offline · read-only" : "Saved to your library"}</span>
          </div>
          {!standalone && (installPrompt || iosDevice) ? (
            <button className="install-button" type="button" onClick={installApp} aria-label="Install app" title="Install app"><DownloadSimple /> <span>Install app</span></button>
          ) : null}
        </div>
      </header>

      {isOffline ? <div className="offline-banner" role="status"><Info /> {workspace?.connectionMessage || "You’re offline. Reconnect to keep sorting and save changes."}</div> : null}

      <main className="main-content">
        {view === "sort" ? (
          <SortView
            run={run} activeCard={activeCard} ratingMode={ratingMode} selectedCollection={selectedCollection}
            decisions={decisions} decisionsByCard={decisionsByCard} pendingCards={pendingCards}
            keptCards={keptCards} discardedCards={discardedCards} keepLabel={keepLabel} discardLabel={discardLabel}
            busy={busy} isOffline={isOffline} canUndo={canUndo} hasLaterResults={hasLaterResults} dialogOpen={dialogOpen}
            ratingOrder={ratingSort} onToggleRatingOrder={() => setRatingSort((value) => value === "high" ? "low" : "high")}
            onDecide={decide} onUndo={undo} onSkip={skipCurrent} onReview={showReview} onRefine={showRefine}
            onRoundPlan={showRoundPlan} onStartRound={showStartRound} onNewCollection={showNewCollection}
            onChooseCollection={() => setView("collections")} onHistory={() => setView("history")}
          />
        ) : null}

        {view === "collections" ? (
          <CollectionsView
            collections={collections} runs={runs} isOffline={isOffline} busy={busy}
            onImported={() => refresh(true)} onNewCollection={showNewCollection} onEditCollection={showEditCollection}
            onStartRound={showStartRound} onOpenRun={switchToRun} onSelectCollection={setCollectionId} onError={setToast}
          />
        ) : null}

        {view === "api-keys" && apiBaseUrl ? <ApiKeysView key="api-keys" apiBaseUrl={apiBaseUrl} /> : null}

        {view === "history" ? (
          <HistoryView
            runs={runs} collections={collections} selectedCollection={selectedCollection}
            onOpenRun={switchToRun} onReview={showReview} onRefine={showRefine} onStartRound={showStartRound}
            onCollections={() => setView("collections")}
          />
        ) : null}
      </main>

      {dialog?.kind === "collection" ? (
        <CollectionDialog collection={dialog.collection} busy={busy} offline={isOffline} onDismiss={() => setDialog(null)} onSave={applyCollection} />
      ) : null}
      {dialog?.kind === "start" ? (
        <RoundDialog collection={dialog.collection} busy={busy} offline={isOffline} onDismiss={() => setDialog(null)}
          onStart={(keepLimit, rounds) => startRound({ collectionId: dialog.collection.id, keepLimit, rounds })} />
      ) : null}
      {dialog?.kind === "refine" ? (
        <RoundDialog parent={dialog.parent} collection={dialog.collection || collectionForRun(dialog.parent, collections)} busy={busy} offline={isOffline}
          onDismiss={() => setDialog(null)} onAdjustPlan={() => showRoundPlan(dialog.parent, "refine")}
          onStart={(input) => startRound({ parentRunId: dialog.parent.id, ...input })} />
      ) : null}
      {dialog?.kind === "plan" ? (
        <RoundPlanDialog run={dialog.run} startedRoundCount={dialog.startedRoundCount} busy={busy} offline={isOffline}
          onDismiss={() => setDialog(null)} onSave={(rounds) => savePlan(dialog.run, rounds, dialog.afterSave)} />
      ) : null}
      {reviewRun ? <ReviewDialog run={reviewRun} offline={isOffline} busy={busy} onDismiss={() => setReviewRunId("")} onRevise={reviseReviewedChoice} /> : null}
      {installHelpOpen ? (
        <Modal title="Add Sift to your Home Screen" description="Open this page in Safari to install Sift on your iPhone or iPad." onDismiss={() => setInstallHelpOpen(false)} className="install-help-modal">
          <ol className="install-help-steps"><li>Tap Safari’s <strong>Share</strong> button.</li><li>Choose <strong>Add to Home Screen</strong>.</li><li>Tap <strong>Add</strong> to finish.</li></ol>
          <div className="modal__actions"><button className="button button--cyan" type="button" onClick={() => setInstallHelpOpen(false)}>Got it</button></div>
        </Modal>
      ) : null}
      <div className="toast" role="status" aria-live="polite" data-visible={Boolean(toast)}>{toast}</div>
    </div>
  );
}

export { App };
