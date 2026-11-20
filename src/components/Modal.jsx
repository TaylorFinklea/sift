import { useEffect, useRef } from "react";
import { X } from "@phosphor-icons/react";

export default function Modal({ title, description, onDismiss, children, className = "" }) {
  const dialogRef = useRef(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const focusable = dialog.querySelector("input:not([type=hidden]), textarea, button, select");
    focusable?.focus();
    return () => { if (dialog.open) dialog.close(); };
  }, []);

  // Effect cleanup closes the dialog, which queues a `close` event. That event is stale when it
  // arrives after StrictMode's development remount has reopened the dialog, or after the dialog
  // was unmounted (for example, replaced by another dialog), so it must not dismiss anything.
  const handleClose = (event) => {
    const dialog = event.currentTarget;
    if (dialog.open || !dialog.isConnected) return;
    onDismiss();
  };

  return (
    <dialog ref={dialogRef} className={`modal ${className}`} onClose={handleClose} onCancel={onDismiss}>
      <div className="modal__content">
        <div className="modal__heading">
          <div>
            <h2>{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          <button className="icon-button" type="button" aria-label="Close" onClick={onDismiss}><X weight="bold" /></button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
