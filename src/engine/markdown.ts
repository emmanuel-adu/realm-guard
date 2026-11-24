import { APPROVAL_LABEL, AUTH_LABEL, CATEGORY_LABEL, SEVERITY_LABEL, VERDICTS } from "../content/verdicts";
import { credentialLabel } from "./quickbooks";
import type { Report } from "./types";

// Names and text come from the uploaded files, so they can't be allowed to start a new
// paragraph, open an HTML comment or close a code span: that would let a workflow name forge
// a verdict in the rendered report.
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const html = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const text = (s: string) => html(oneLine(s)).replace(/([\\`*_[\]#|])/g, "\\$1");
const prose = (s: string) => html(oneLine(s));
const code = (s: string) => `\`${oneLine(s).replace(/`/g, "'")}\``;
const cell = (s: string) => text(s);

function localDate(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function reportToMarkdown(report: Report, scannedAt = new Date()): string {
  const v = VERDICTS[report.verdict];
  const name = (id: string) => report.tenantNames[id] ?? id;
  const lines = [
    `# Realm Guard report: ${text(report.workflowName)}`,
    "",
    `**${v.label}.** ${v.summary}`,
    "",
    `Scanned ${localDate(scannedAt)}. ${String(report.coverage.nodes)} nodes, ${String(report.touchpoints.length)} QuickBooks steps, ${String(report.findings.length)} findings.`,
  ];
  if (report.hasManifest) lines.push(`Scope: ${report.scope.map((id) => text(name(id))).join(", ")}.`);

  if (report.findings.length > 0) {
    lines.push("", "## Findings");
    for (const f of report.findings) {
      lines.push(
        "",
        `### ${SEVERITY_LABEL[f.severity]}: ${f.title} (${f.ruleId})`,
        `${CATEGORY_LABEL[f.category]} · ${f.nodes.map(code).join(", ")}`,
        "",
        prose(f.detail),
        "",
        `**Why it matters:** ${prose(f.why)}`,
        "",
        `**Fix:** ${prose(f.fix)}`,
      );
    }
  }

  if (report.touchpoints.length > 0) {
    lines.push("", "## QuickBooks steps", "", "| Node | Operation | Client | Credential | Approval |", "| --- | --- | --- | --- | --- |");
    for (const t of report.touchpoints) {
      const client = t.tenants.length > 0 ? t.tenants.map(name).join(", ") : "unknown";
      const cred = t.credential ? credentialLabel(t.credential) : AUTH_LABEL[t.auth];
      lines.push(`| ${cell(t.node)} | ${cell(t.operation)} | ${cell(client)} | ${cell(cred)} | ${APPROVAL_LABEL[t.approval]} |`);
    }
  }

  if (report.coverage.gaps.length > 0) {
    lines.push("", "## What this scan couldn't check", "");
    for (const g of report.coverage.gaps) lines.push(`- ${prose(g)}`);
  }
  lines.push("", "Realm Guard reads the exported file only. It doesn't run the workflow or call QuickBooks.", "");
  return lines.join("\n");
}
