import { ClipboardPaste, FileJson, Upload, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { MAX_INPUT_BYTES } from "../engine/workflow";
import { Button } from "./ui";

export interface Source {
  text: string;
  /** File name, or a label such as "Pasted" for text typed into the page. */
  label: string;
  origin: "file" | "paste" | "sample" | "draft";
}

interface Props {
  id: string;
  label: string;
  optional?: string;
  hint: string;
  drop: string;
  accept: string;
  placeholder: string;
  value: Source | null;
  onChange: (value: Source | null) => void;
  errors: string[];
  /** Shown beside the file name once loaded. */
  summary?: ReactNode;
  /** Keep the text editable once loaded (the manifest is short and often tweaked). */
  editable?: boolean;
  actions?: ReactNode;
  footnote?: ReactNode;
}

export function SourceCard({ id, label, optional, hint, drop, accept, placeholder, value, onChange, errors, summary, editable, actions, footnote }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [pasting, setPasting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const hintId = useId();
  const errorId = useId();

  // Reading a file is async, and the user (or a sample button) can change the source before it
  // finishes. Each read takes a ticket; any newer read or any change to the source voids it.
  const readTicket = useRef(0);
  useEffect(() => {
    readTicket.current++;
  }, [value]);

  async function readFile(file: File | undefined) {
    if (!file) return;
    const ticket = ++readTicket.current;
    if (file.size > MAX_INPUT_BYTES) {
      setReadError(`${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB. Realm Guard reads files up to 5 MB.`);
      return;
    }
    try {
      const text = await file.text();
      if (ticket !== readTicket.current) return;
      setReadError(null);
      setPasting(false);
      onChange({ text, label: file.name, origin: "file" });
    } catch {
      if (ticket === readTicket.current) setReadError(`Couldn't read ${file.name}. Try exporting it again.`);
    }
  }

  const allErrors = readError ? [readError, ...errors] : errors;
  const showText = value !== null && (editable === true || value.origin === "paste");
  const textareaId = `${id}-text`;

  return (
    <div className="space-y-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={showText || (pasting && !value) ? textareaId : `${id}-drop`} className="text-[14px] font-semibold text-ink">
          {label}
          {optional ? <span className="ml-1.5 font-normal text-faint">{optional}</span> : null}
        </label>
        {actions}
      </div>
      <p id={hintId} className="text-[13px] leading-5 text-muted">
        {hint}
      </p>

      <input
        ref={fileInput}
        type="file"
        accept={accept}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          void readFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      {value ? (
        <div className="flex items-center gap-2.5 rounded-lg border border-rule bg-wash px-3 py-2.5">
          <FileJson className="size-4 shrink-0 text-muted" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-[13px] text-ink" data-testid={`${id}-label`}>
              {value.label}
            </p>
            {summary ? <p className="truncate text-[12px] text-muted">{summary}</p> : null}
          </div>
          <Button variant="quiet" className="h-8 px-2 text-[13px]" onClick={() => fileInput.current?.click()}>
            Replace
          </Button>
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setReadError(null);
              setPasting(false);
            }}
            aria-label={`Clear ${label.toLowerCase()}`}
            className="inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-panel hover:text-ink"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      ) : pasting ? null : (
        <button
          id={`${id}-drop`}
          type="button"
          aria-label={`${label}: ${drop}, or press Enter to browse for a file`}
          aria-describedby={hintId}
          onClick={() => fileInput.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => {
            setDragging(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void readFile(e.dataTransfer.files[0]);
          }}
          className={`flex w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 py-6 text-center transition-colors ${
            dragging ? "border-focus bg-wash" : "border-rule-strong hover:bg-wash"
          }`}
        >
          <Upload className="size-5 text-muted" aria-hidden="true" />
          <span className="text-[14px] font-medium text-ink">{drop}</span>
          <span className="text-[13px] text-muted">
            or <span className="text-ink underline underline-offset-2">browse</span>
          </span>
        </button>
      )}

      {showText || (pasting && !value) ? (
        <textarea
          id={textareaId}
          value={value?.text ?? ""}
          placeholder={placeholder}
          spellCheck={false}
          autoFocus={pasting && !value}
          aria-describedby={allErrors.length > 0 ? errorId : hintId}
          aria-invalid={allErrors.length > 0}
          onChange={(e) => {
            const text = e.target.value;
            setReadError(null);
            if (!text && !editable) {
              onChange(null);
              return;
            }
            onChange({ text, label: value?.label ?? "Pasted", origin: value?.origin ?? "paste" });
          }}
          rows={editable ? 12 : 8}
          className="block w-full resize-y rounded-lg border border-rule-strong bg-canvas px-3 py-2.5 font-mono text-[12.5px] leading-[1.6] text-ink placeholder:text-faint focus:border-focus focus:outline-none"
        />
      ) : null}

      {!value ? (
        <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
          <Button
            variant="quiet"
            className="h-8 px-2 text-[13px]"
            onClick={() => {
              setPasting((p) => !p);
            }}
          >
            {pasting ? (
              "Upload a file instead"
            ) : (
              <>
                <ClipboardPaste className="size-3.5" aria-hidden="true" />
                Paste instead
              </>
            )}
          </Button>
        </div>
      ) : null}

      {allErrors.length > 0 ? (
        <div id={errorId} role="alert" className="space-y-1 rounded-lg border border-critical/30 bg-critical/5 px-3 py-2 text-[13px] leading-5 text-critical">
          {allErrors.map((e) => (
            <p key={e}>{e}</p>
          ))}
        </div>
      ) : null}
      {footnote}
    </div>
  );
}
