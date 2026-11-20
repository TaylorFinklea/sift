import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, Check, Copy, Key, Plus, ShieldCheck, Trash, X } from "@phosphor-icons/react";
import { ApiError, createApiKey, getApiKeys, revokeApiKey } from "../lib/api.js";

function dateLabel(value) {
  if (!value) return "Never expires";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Expiry unavailable" : `Expires ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date)}`;
}

function keyStatus(item) {
  if (item.revokedAt) return { label: "Revoked", className: "api-key-status--revoked" };
  if (item.expiresAt && new Date(item.expiresAt).getTime() <= Date.now()) return { label: "Expired", className: "api-key-status--expired" };
  return { label: "Active", className: "api-key-status--active" };
}

function SecretDialog({ token, name, onDismiss }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const dialogRef = useRef(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, []);

  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setCopyError("");
    } catch {
      setCopyError("Clipboard access is unavailable. Reveal the key and copy it manually.");
    }
  };

  return (
    <dialog ref={dialogRef} className="modal api-key-secret-dialog" onClose={onDismiss} onCancel={onDismiss} aria-labelledby="api-key-secret-title">
      <div className="modal__content">
        <div className="modal__heading">
          <div><p className="eyebrow">KEY CREATED</p><h2 id="api-key-secret-title">Copy your key now</h2><p>This key for <strong>{name}</strong> won’t be shown again after you close this window.</p></div>
          <button className="icon-button" type="button" aria-label="Close and clear the new key" onClick={onDismiss}><X weight="bold" /></button>
        </div>
        <label className="api-key-secret-label" htmlFor="api-key-secret">API key</label>
        <div className="api-key-secret-field">
          <input id="api-key-secret" aria-label="New API key, masked by default" type={revealed ? "text" : "password"} value={token} readOnly autoComplete="off" spellCheck="false" />
          <button className="button button--quiet" type="button" onClick={() => { setRevealed((value) => !value); setCopied(false); }}>{revealed ? "Hide" : "Reveal"}</button>
        </div>
        {copyError ? <p className="api-key-error" role="alert">{copyError}</p> : null}
        {copied ? <p className="api-key-copied" role="status"><Check weight="bold" /> Copied to clipboard.</p> : null}
        <div className="api-key-secret-dialog__actions">
          <button className="button button--quiet" type="button" onClick={onDismiss}>Close and clear</button>
          <button className="button button--cyan" type="button" onClick={copyToken}><Copy /> Copy key</button>
        </div>
      </div>
    </dialog>
  );
}

export default function ApiKeys({ apiBaseUrl }) {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [scope, setScope] = useState("read");
  const [expiresInDays, setExpiresInDays] = useState("90");
  const [token, setToken] = useState("");
  const [createdName, setCreatedName] = useState("");
  const [revokeId, setRevokeId] = useState("");

  const refresh = async () => {
    setLoading(true);
    setError("");
    try {
      const response = await getApiKeys();
      if (!Array.isArray(response?.keys)) throw new ApiError("The server returned an unexpected API key list.");
      setKeys(response.keys);
    } catch (requestError) {
      setError(requestError instanceof ApiError && requestError.status === 404
        ? "Key management isn’t available on this server yet."
        : requestError.message || "Couldn’t load API keys. Try again.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  const submit = async (event) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await createApiKey({ name: trimmedName, scope, expiresInDays: expiresInDays === "never" ? null : Number(expiresInDays) });
      if (typeof response?.token !== "string" || !response.token) throw new Error("The server didn’t return the new key. It may not be shown again; refresh the key list before trying again.");
      setKeys((current) => [response.key, ...current.filter((item) => item.id !== response.key?.id)].filter(Boolean));
      setCreatedName(trimmedName);
      setToken(response.token);
      setName("");
      setScope("read");
      setExpiresInDays("90");
    } catch (requestError) {
      setError(requestError.message || "Couldn’t create the key. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id) => {
    setBusy(true);
    setError("");
    try {
      const response = await revokeApiKey(id);
      setKeys((current) => current.map((item) => item.id === id ? (response?.key || { ...item, revokedAt: new Date().toISOString() }) : item));
      setRevokeId("");
    } catch (requestError) {
      setError(requestError.message || "Couldn’t revoke this key. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="library-view api-keys-view" aria-labelledby="api-keys-title">
        <div className="page-heading"><div><p className="eyebrow">PRIVATE API ACCESS</p><h1 id="api-keys-title">API keys</h1><p className="page-heading__sub">Create credentials for apps that need to work with your Sift data.</p></div></div>
        <div className="api-key-endpoint"><span className="api-key-endpoint__icon"><ShieldCheck weight="duotone" /></span><div><strong>API endpoint</strong><a href={apiBaseUrl} target="_blank" rel="noreferrer">{apiBaseUrl}</a></div></div>

        <form className="api-key-create" onSubmit={submit}>
          <div className="api-key-create__heading"><div><span className="api-key-create__icon"><Plus /></span><div><h2>Make a new key</h2><p>Choose a name so you can recognize it later.</p></div></div></div>
          <div className="api-key-create__fields">
            <label className="api-key-field api-key-field--name">Key name<input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="Home dashboard" autoComplete="off" /></label>
            <label className="api-key-field">Permission<select value={scope} onChange={(event) => setScope(event.target.value)}><option value="read">Read only</option><option value="read_write">Read and write</option></select></label>
            <label className="api-key-field">Expires<select value={expiresInDays} onChange={(event) => setExpiresInDays(event.target.value)}><option value="90">In 90 days</option><option value="30">In 30 days</option><option value="never">Never</option></select></label>
            <button className="button button--cyan api-key-create__submit" type="submit" disabled={busy || !name.trim()}><Key /> {busy ? "Working…" : "Generate key"}</button>
          </div>
          <p className="api-key-create__note">Read only is the safest choice for most integrations. Read and write allows changes to your collections and sort history.</p>
        </form>

        <div className="api-key-list-heading"><div><h2>Your keys</h2><span>{keys.length} {keys.length === 1 ? "key" : "keys"}</span></div><button className="text-button" type="button" onClick={refresh} disabled={loading || busy}><ArrowClockwise /> Refresh</button></div>
        {error ? <div className="api-key-error api-key-error--box" role="alert">{error}<button className="text-button" type="button" onClick={refresh} disabled={loading}>Try again</button></div> : null}
        {loading ? <p className="api-key-list-state" role="status">Loading your keys…</p> : keys.length ? <div className="api-key-list">
          {keys.map((item) => {
            const status = keyStatus(item);
            return <article className="api-key-row" key={item.id}>
              <div className="api-key-row__mark"><Key weight="duotone" /></div>
              <div className="api-key-row__main"><strong>{item.name}</strong><span><code>{item.prefix || "Key prefix unavailable"}…</code><i aria-hidden="true">·</i>{item.scope === "read_write" ? "Read and write" : "Read only"}<i aria-hidden="true">·</i>{dateLabel(item.expiresAt)}</span></div>
              <span className={`api-key-status ${status.className}`}><i />{status.label}</span>
              {status.label === "Active" ? revokeId === item.id ? <div className="api-key-revoke-confirm" role="group" aria-label={`Confirm revoke ${item.name}`}><span>Stop access for <strong>{item.name}</strong>?</span><button className="button button--danger" type="button" disabled={busy} onClick={() => revoke(item.id)}>Revoke key</button><button className="text-button" type="button" disabled={busy} onClick={() => setRevokeId("")}>Cancel</button></div> : <button className="api-key-revoke" type="button" disabled={busy} aria-label={`Revoke ${item.name}`} onClick={() => setRevokeId(item.id)}><Trash /> Revoke</button> : null}
            </article>;
          })}
        </div> : !error ? <div className="api-key-empty"><div><Key weight="duotone" /></div><h3>No API keys yet</h3><p>Generate a key when you’re ready to connect an app to Sift.</p></div> : null}
        <p className="api-key-safety"><ShieldCheck /> Treat keys like passwords. The full value is only shown once and is never saved in your browser’s library.</p>
      </section>
      {token ? <SecretDialog token={token} name={createdName} onDismiss={() => { setToken(""); setCreatedName(""); }} /> : null}
    </>
  );
}
