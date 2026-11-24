import { AlertTriangle, Check, ChevronDown, Copy, Download } from "lucide-react";
import { useMemo, useState } from "react";
import { LIMITS } from "../content/copy";
import { APPROVAL_LABEL, AUTH_LABEL, CATEGORY_LABEL, SEVERITY_LABEL, VERDICTS } from "../content/verdicts";
import { reportToMarkdown } from "../engine/markdown";
import { credentialLabel } from "../engine/quickbooks";
import { SEVERITY_ORDER } from "../engine/scan";
import type { Approval, Finding, Report as ReportData, Severity, Verdict } from "../engine/types";
import { Badge, Button, Eyebrow, NodeChip, Panel, RichText } from "./ui";

const VERDICT_TEXT: Record<Verdict, string> = {
  fix: "text-critical",
  "not-verified": "text-unverified",
  review: "text-medium",
  clear: "text-clear",
  "nothing-to-check": "text-low",
};

const SEVERITY_BG: Record<Severity, string> = {
  critical: "bg-critical",
  high: "bg-high",
  medium: "bg-medium",
  low: "bg-low",
};

const APPROVAL_DOT: Record<Approval, string> = {
  ungated: "bg-high",
  "manual-only": "bg-medium",
  gated: "bg-clear",
  "not-a-write": "bg-rule-strong",
};

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workflow";
}

function VerdictPanel({ report }: { report: ReportData }) {
  const v = VERDICTS[report.verdict];
  const counts = SEVERITY_ORDER.map((s) => [s, report.findings.filter((f) => f.severity === s).length] as const);
  const total = report.findings.length;
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const [showRaw, setShowRaw] = useState(false);
  const names = (ids: string[]) => ids.map((id) => report.tenantNames[id] ?? id);

  return (
    <Panel className="p-5 sm:p-6" labelledBy="verdict-heading">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <Eyebrow>Verdict</Eyebrow>
        <p className="max-w-full truncate font-mono text-[12px] text-muted" title={report.workflowName}>
          {report.workflowName}
        </p>
      </div>
      <div className="mt-3 flex items-start gap-3">
        <span className={`tint mt-1.5 inline-flex size-5 shrink-0 items-center justify-center rounded-md ${VERDICT_TEXT[report.verdict]}`} aria-hidden="true">
          <span className="size-2 rounded-[3px] bg-current" />
        </span>
        <div className="min-w-0">
          <h2 id="verdict-heading" className="text-[24px] font-semibold leading-8 tracking-[-0.01em] sm:text-[28px] sm:leading-9" data-testid="verdict">
            {v.label}
          </h2>
          <p className="mt-1 text-[15px] text-body">{v.summary}</p>
        </div>
      </div>

      <div className="mt-5">
        <div className="flex h-2 w-full gap-[3px] overflow-hidden rounded-full" role="img" aria-label={total === 0 ? "No findings" : counts.map(([s, n]) => `${String(n)} ${s}`).join(", ")}>
          {total === 0 ? (
            <span className={`h-full w-full rounded-full ${report.verdict === "clear" ? "bg-clear" : "bg-rule"}`} />
          ) : (
            counts.map(([s, n]) => (n > 0 ? <span key={s} className={`h-full ${SEVERITY_BG[s]}`} style={{ flexGrow: n }} /> : null))
          )}
        </div>
        <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted">
          {counts.map(([s, n]) => (
            <li key={s} className="flex items-center gap-1.5">
              <span className={`size-2 rounded-[2px] ${n > 0 ? SEVERITY_BG[s] : "bg-rule-strong"}`} aria-hidden="true" />
              <span className="font-mono text-ink">{n}</span> {SEVERITY_LABEL[s].toLowerCase()}
            </li>
          ))}
        </ul>
      </div>

      <dl className="mt-5 grid grid-cols-1 gap-x-6 gap-y-3 border-t border-rule pt-4 text-[13px] sm:grid-cols-3">
        <div className="min-w-0">
          <dt className="text-muted">Clients touched</dt>
          <dd className="mt-0.5 text-ink">{report.tenantsTouched.length > 0 ? names(report.tenantsTouched).join(", ") : "None identified"}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted">Allowed scope</dt>
          <dd className="mt-0.5 text-ink">{report.hasManifest ? names(report.scope).join(", ") : "No manifest"}</dd>
        </div>
        <div>
          <dt className="text-muted">Scanned</dt>
          <dd className="mt-0.5 text-ink">
            <span className="font-mono">{report.touchpoints.length}</span> QuickBooks {report.touchpoints.length === 1 ? "step" : "steps"} in <span className="font-mono">{report.coverage.nodes}</span> nodes
          </dd>
        </div>
      </dl>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          onClick={() => {
            void copyText(reportToMarkdown(report)).then((ok) => {
              setCopied(ok ? "copied" : "failed");
              if (ok) {
                setTimeout(() => {
                  setCopied("idle");
                }, 2200);
              } else {
                setShowRaw(true);
              }
            });
          }}
        >
          {copied === "copied" ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
          {copied === "copied" ? "Copied" : "Copy report"}
        </Button>
        <Button
          onClick={() => {
            const blob = new Blob([reportToMarkdown(report)], { type: "text/markdown" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `realm-guard-${slugify(report.workflowName)}.md`;
            a.click();
            setTimeout(() => {
              URL.revokeObjectURL(a.href);
            }, 1000);
          }}
        >
          <Download className="size-4" aria-hidden="true" />
          Download .md
        </Button>
        <span className="sr-only" aria-live="polite">
          {copied === "copied" ? "Report copied as Markdown." : ""}
        </span>
      </div>
      {copied === "failed" || showRaw ? (
        <div className="mt-4">
          <label htmlFor="raw-report" className="text-[13px] text-muted">
            Your browser blocked the clipboard. The report is selected below: press Ctrl+C or Cmd+C.
          </label>
          <textarea
            id="raw-report"
            readOnly
            rows={8}
            value={reportToMarkdown(report)}
            ref={(el) => {
              el?.select();
            }}
            className="mt-1.5 block w-full resize-y rounded-lg border border-rule-strong bg-canvas px-3 py-2.5 font-mono text-[12px] leading-[1.6] text-ink focus:border-focus focus:outline-none"
          />
        </div>
      ) : null}
    </Panel>
  );
}

function FindingRow({ finding, open, onToggle }: { finding: Finding; open: boolean; onToggle: () => void }) {
  const bodyId = `finding-${finding.ruleId}-${finding.nodes[0] ?? ""}`.replace(/[^a-zA-Z0-9-]/g, "-");
  return (
    <li className="border-t border-rule first:border-t-0">
      <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={onToggle} className="group flex w-full items-start gap-3 px-4 py-3.5 text-left hover:bg-wash sm:px-5">
        <Badge severity={finding.severity} className="w-[78px] justify-center">
          {SEVERITY_LABEL[finding.severity]}
        </Badge>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-medium leading-[22px] text-ink">{finding.title}</span>
          <span className="mt-1.5 flex flex-wrap gap-1.5">
            {finding.nodes.slice(0, 4).map((n) => (
              <NodeChip key={n}>{n}</NodeChip>
            ))}
            {finding.nodes.length > 4 ? <span className="text-[12px] text-muted">+{finding.nodes.length - 4} more</span> : null}
          </span>
        </span>
        <span className="hidden pt-0.5 font-mono text-[12px] text-faint sm:block">{finding.ruleId}</span>
        <ChevronDown className={`mt-0.5 size-4 shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      {open ? (
        <div id={bodyId} className="px-4 pb-5 sm:pr-5 sm:pl-[110px]">
          <p className="text-[14px] leading-6 text-body">
            <RichText text={finding.detail} />
          </p>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div className="rounded-lg bg-wash px-3.5 py-3">
              <Eyebrow>Why it matters</Eyebrow>
              <p className="mt-1 text-[14px] leading-6 text-body">{finding.why}</p>
            </div>
            <div className="rounded-lg bg-wash px-3.5 py-3">
              <Eyebrow>Fix</Eyebrow>
              <p className="mt-1 text-[14px] leading-6 text-body">
                <RichText text={finding.fix} />
              </p>
            </div>
          </div>
          <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.06em] text-faint">
            {CATEGORY_LABEL[finding.category]} · {finding.ruleId}
          </p>
        </div>
      ) : null}
    </li>
  );
}

function Findings({ findings }: { findings: Finding[] }) {
  const [filter, setFilter] = useState<Severity | "all">("all");
  const [openKey, setOpenKey] = useState<string | null>(() => (findings[0] ? key(findings[0]) : null));
  const present = SEVERITY_ORDER.filter((s) => findings.some((f) => f.severity === s));
  const shown = filter === "all" ? findings : findings.filter((f) => f.severity === filter);

  return (
    <Panel labelledBy="findings-heading">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule px-4 py-3.5 sm:px-5">
        <h2 id="findings-heading" className="text-[16px] font-semibold">
          Findings <span className="font-mono text-[14px] font-normal text-muted">{findings.length}</span>
        </h2>
        {present.length > 1 ? (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter findings by severity">
            {(["all", ...present] as const).map((s) => {
              const n = s === "all" ? findings.length : findings.filter((f) => f.severity === s).length;
              const active = filter === s;
              return (
                <button
                  key={s}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    setFilter(s);
                  }}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors ${
                    active ? "border-ink bg-ink text-canvas" : "border-rule-strong text-body hover:bg-wash"
                  }`}
                >
                  {s === "all" ? null : <span className={`size-2 rounded-[2px] ${SEVERITY_BG[s]}`} aria-hidden="true" />}
                  {s === "all" ? "All" : SEVERITY_LABEL[s]}
                  <span className={`font-mono text-[12px] ${active ? "opacity-80" : "text-muted"}`}>{n}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
      {findings.length === 0 ? (
        <p className="px-4 py-6 text-[14px] text-muted sm:px-5">No findings. Every rule passed for what the scan could see.</p>
      ) : (
        <ul>
          {shown.map((f) => (
            <FindingRow
              key={key(f)}
              finding={f}
              open={openKey === key(f)}
              onToggle={() => {
                setOpenKey((k) => (k === key(f) ? null : key(f)));
              }}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

const key = (f: Finding) => `${f.ruleId}:${f.nodes.join("|")}`;

function Touchpoints({ report }: { report: ReportData }) {
  const name = (id: string) => report.tenantNames[id] ?? id;
  if (report.touchpoints.length === 0) return null;
  return (
    <Panel labelledBy="steps-heading">
      <div className="border-b border-rule px-4 py-3.5 sm:px-5">
        <h2 id="steps-heading" className="text-[16px] font-semibold">
          QuickBooks steps <span className="font-mono text-[14px] font-normal text-muted">{report.touchpoints.length}</span>
        </h2>
        <p className="mt-0.5 text-[13px] text-muted">Every node that reads or writes a client's books, and whose books they are.</p>
      </div>
      <div className="hidden md:block">
        <table className="w-full text-left text-[13px]">
          <thead className="bg-wash text-muted">
            <tr>
              {["Node", "Operation", "Client", "Credential", "Approval"].map((h) => (
                <th key={h} scope="col" className="px-4 py-2 font-medium first:pl-5 last:pr-5">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.touchpoints.map((t) => (
              <tr key={t.node} className="border-t border-rule align-top">
                <td className="py-2.5 pr-4 pl-5 font-mono text-[12.5px] break-words text-ink">{t.node}</td>
                <td className="px-4 py-2.5 font-mono text-[12.5px] whitespace-nowrap text-body">{t.operation}</td>
                <td className="px-4 py-2.5 break-words text-ink">{t.tenants.length > 0 ? t.tenants.map(name).join(", ") : <span className="text-muted">Unknown</span>}</td>
                <td className="px-4 py-2.5 break-words text-body">{t.credential ? credentialLabel(t.credential) : <span className="text-muted">{AUTH_LABEL[t.auth]}</span>}</td>
                <td className="py-2.5 pr-5 pl-4">
                  <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-body">
                    <span className={`size-2 shrink-0 rounded-full ${APPROVAL_DOT[t.approval]}`} aria-hidden="true" />
                    {APPROVAL_LABEL[t.approval]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="md:hidden">
        {report.touchpoints.map((t) => (
          <li key={t.node} className="border-t border-rule px-4 py-3 first:border-t-0">
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 font-mono text-[13px] break-words text-ink">{t.node}</p>
              <span className="inline-flex shrink-0 items-center gap-1.5 text-[12px] text-body">
                <span className={`size-2 rounded-full ${APPROVAL_DOT[t.approval]}`} aria-hidden="true" />
                {APPROVAL_LABEL[t.approval]}
              </span>
            </div>
            <dl className="mt-1.5 grid grid-cols-[84px_1fr] gap-x-2 gap-y-0.5 text-[13px]">
              <dt className="text-muted">Operation</dt>
              <dd className="font-mono text-[12.5px] break-words text-body">{t.operation}</dd>
              <dt className="text-muted">Client</dt>
              <dd className="text-ink">{t.tenants.length > 0 ? t.tenants.map(name).join(", ") : "Unknown"}</dd>
              <dt className="text-muted">Credential</dt>
              <dd className="break-words text-body">{t.credential ? credentialLabel(t.credential) : AUTH_LABEL[t.auth]}</dd>
            </dl>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function Coverage({ report }: { report: ReportData }) {
  const { gaps, disabledNodes } = report.coverage;
  return (
    <Panel className="px-4 py-4 sm:px-5" labelledBy="coverage-heading">
      <h2 id="coverage-heading" className="text-[16px] font-semibold">
        What this scan couldn't see
      </h2>
      {gaps.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {gaps.map((g) => (
            <li key={g} className="flex gap-2.5 text-[14px] leading-6 text-ink">
              <AlertTriangle className="mt-[5px] size-3.5 shrink-0 text-medium" aria-hidden="true" />
              {g}
            </li>
          ))}
        </ul>
      ) : null}
      <ul className="mt-3 space-y-1.5 text-[13px] leading-5 text-muted">
        {disabledNodes.length > 0 ? <li>Skipped {disabledNodes.length} disabled {disabledNodes.length === 1 ? "node" : "nodes"}: {disabledNodes.join(", ")}.</li> : null}
        {LIMITS.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </Panel>
  );
}

export function Report({ report }: { report: ReportData }) {
  const findingsKey = useMemo(() => report.findings.map(key).join(","), [report]);
  return (
    <div className="space-y-5" data-testid="report">
      <VerdictPanel report={report} />
      <Findings key={findingsKey} findings={report.findings} />
      <Touchpoints report={report} />
      <Coverage report={report} />
    </div>
  );
}
