import { useEffect, useState } from "react";
import { numericValueError } from "../../shared/numeric-scale.js";

const numberOrBlank = (text) => text === "" ? "" : Number(text);

/** Edits a numeric scale definition: name, range, step and optional unit. */
export function NumericScaleEditor({ scale, onChange, disabled = false }) {
  const field = (key) => (event) => onChange({ ...scale, [key]: event.target.value });
  const numberField = (key) => (event) => onChange({ ...scale, [key]: numberOrBlank(event.target.value) });
  return (
    <div className="numeric-scale-editor">
      <label>Value name<input aria-label="Value name" value={scale.name} onChange={field("name")} disabled={disabled} /></label>
      <div className="numeric-scale-editor__range">
        <label>Minimum<input aria-label="Minimum value" type="number" step="any" value={scale.minimum} onChange={numberField("minimum")} disabled={disabled} /></label>
        <label>Maximum<input aria-label="Maximum value" type="number" step="any" value={scale.maximum} onChange={numberField("maximum")} disabled={disabled} /></label>
        <label>Step<input aria-label="Value step" type="number" min="0.000001" step="any" value={scale.step} onChange={numberField("step")} disabled={disabled} /></label>
        <label>Unit<input aria-label="Value unit" placeholder="Optional" value={scale.unit} onChange={field("unit")} disabled={disabled} /></label>
      </div>
    </div>
  );
}

/** A slider plus exact number entry. Blank stays unanswered; zero is a valid value. */
export function NumericValueControl({ scale, value, onChange, id, compact = false }) {
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setDraft(value == null ? "" : String(value));
    setTouched(false);
    setError("");
  }, [id]);

  const minimum = Number(scale.minimum);
  const maximum = Number(scale.maximum);
  const step = Number(scale.step);
  const current = draft !== "" && Number.isFinite(Number(draft))
    ? Math.min(maximum, Math.max(minimum, Number(draft)))
    : minimum;

  const commit = (next) => {
    setDraft(String(next));
    setTouched(true);
    const problem = numericValueError(next, scale);
    setError(problem);
    if (!problem) onChange(next);
  };
  const onEntryChange = (event) => {
    const text = event.target.value;
    setDraft(text);
    setTouched(true);
    if (text === "") {
      setError("");
      onChange(null);
    } else if (Number.isFinite(Number(text))) {
      setError(numericValueError(Number(text), scale));
      onChange(Number(text));
    }
  };
  const onEntryBlur = () => {
    if (draft !== "" && Number.isFinite(Number(draft))) commit(Number(draft));
  };

  return (
    <div className={`numeric-value${compact ? " numeric-value--compact" : ""}`}>
      <label className="numeric-value__label" htmlFor={`numeric-value-${id}`}>{scale.name}</label>
      <div className="numeric-value__control">
        <input aria-label={`${scale.name} slider`} type="range" min={minimum} max={maximum} step={step} value={current}
          onChange={(event) => commit(Number(event.target.value))} />
        <input id={`numeric-value-${id}`} className="numeric-value__entry"
          aria-label={`${scale.name}${scale.unit ? ` in ${scale.unit}` : ""}`}
          type="number" min={minimum} max={maximum} step={step} value={draft} placeholder="—"
          aria-invalid={Boolean(error)} onChange={onEntryChange} onBlur={onEntryBlur} />
        {scale.unit ? <span className="numeric-value__unit">{scale.unit}</span> : null}
      </div>
      {(!compact || error) ? (
        <small className={error ? "numeric-value__error" : ""} role={error ? "alert" : undefined}>
          {error || (touched ? "Ready to save" : "Set a value, then save when you’re ready.")}
        </small>
      ) : null}
    </div>
  );
}
