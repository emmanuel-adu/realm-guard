import { APPROVAL_LABEL, AUTH_LABEL, CATEGORY_LABEL, SEVERITY_LABEL, VERDICTS } from "../content/verdicts";
import { credentialLabel } from "./quickbooks";
import type { Report } from "./types";

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function reportToMarkdown(report: Report, scannedAt = new Date()): string {
  const v = VERDICTS[report.verdict];
  const name = (id: string) => report.tenantNames[id] ?? id;
  const lines = [
    `# Realm Guard report: ${report.workflowName}`,
    "",
    `**${v.label}.** ${v.summary}`,
    "",
    `Scanned ${scannedAt.toISOString().slice(0, 10)}. ${String(report.coverage.nodes)} nodes, ${String(report.touchpoints.length)} QuickBooks steps, ${String(report.findings.length)} findings.`,
  ];
  if (report.hasManifest) lines.push(`Scope: ${report.scope.map(name).join(", ")}.`);

  if (report.findings.length > 0) {
    lines.push("", "## Findings");
    for (const f of report.findings) {
      lines.push(
        "",
        `### ${SEVERITY_LABEL[f.severity]}: ${f.title} (${f.ruleId})`,
        `${CATEGORY_LABEL[f.category]} · ${f.nodes.map((n) => `\`${n}\``).join(", ")}`,
        "",
        f.detail,
        "",
        `**Why it matters:** ${f.why}`,
        "",
        `**Fix:** ${f.fix}`,
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
    for (const g of report.coverage.gaps) lines.push(`- ${g}`);
  }
  lines.push("", "Realm Guard reads the exported file only. It doesn't run the workflow or call QuickBooks.", "");
  return lines.join("\n");
}
