import type { ReactNode } from "react";
import type { Severity } from "../engine/types";

const SEVERITY_TEXT: Record<Severity, string> = {
  critical: "text-critical",
  high: "text-high",
  medium: "text-medium",
  low: "text-low",
};

export function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted ${className}`}>{children}</p>;
}

export function Badge({ severity, children, className = "" }: { severity: Severity; children: ReactNode; className?: string }) {
  return (
    <span className={`tint inline-flex h-[22px] shrink-0 items-center rounded-md px-2 font-mono text-[11px] font-semibold uppercase tracking-[0.06em] ${SEVERITY_TEXT[severity]} ${className}`}>
      {children}
    </span>
  );
}

export function NodeChip({ children }: { children: ReactNode }) {
  return (
    <code className="inline-block max-w-full truncate rounded-md border border-rule bg-wash px-1.5 py-px align-middle font-mono text-[12px] text-ink">
      {children}
    </code>
  );
}

type ButtonProps = {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "quiet";
  disabled?: boolean;
  type?: "button" | "submit";
  ariaLabel?: string;
  ariaPressed?: boolean;
  className?: string;
};

export function Button({ children, onClick, variant = "secondary", disabled, type = "button", ariaLabel, ariaPressed, className = "" }: ButtonProps) {
  const look = {
    primary: "bg-action text-action-ink hover:opacity-90 border border-transparent",
    secondary: "bg-panel text-ink border border-rule-strong hover:bg-wash",
    quiet: "text-ink hover:bg-wash border border-transparent",
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      className={`inline-flex h-9 items-center justify-center gap-1.5 rounded-lg px-3 text-[14px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${look} ${className}`}
    >
      {children}
    </button>
  );
}

export function Panel({ children, className = "", as: Tag = "section", labelledBy }: { children: ReactNode; className?: string; as?: "section" | "div"; labelledBy?: string }) {
  return (
    <Tag aria-labelledby={labelledBy} className={`rounded-xl border border-rule bg-panel shadow-[0_1px_2px_rgba(16,24,40,0.05)] ${className}`}>
      {children}
    </Tag>
  );
}

/** Two separated halves: the Realm Guard mark. */
export function Mark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <rect x="3" y="3" width="26" height="26" rx="6" fill="var(--ink)" />
      <rect x="17" y="7" width="8" height="18" rx="2" fill="var(--canvas)" />
    </svg>
  );
}

/** Renders `backtick` spans as inline code. Finding text uses them for expressions. */
export function RichText({ text }: { text: string }) {
  const parts = text.split(/`([^`]+)`/);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="rounded border border-rule bg-wash px-1 py-px font-mono text-[12.5px] break-words text-ink">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}
