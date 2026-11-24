import { buildContext } from "./context";
import { stringLeaves } from "./expressions";
import { MENTIONS_QUICKBOOKS, codeOf, isCodeNode, isCommunityNode, isMcpClient, isSticky, isSubWorkflowCall } from "./nodes";
import { approvalRules, clientIdRules, credentialRules, crossClientRules, exportRules } from "./rules";
import type { Category, Finding, Manifest, Report, Severity, Verdict, Workflow } from "./types";

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low"];
export const CATEGORY_ORDER: Category[] = ["credentials", "client-ids", "cross-client", "approvals", "export"];

const byImportance = (a: Finding, b: Finding) =>
  SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
  CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
  a.ruleId.localeCompare(b.ruleId) ||
  (a.nodes[0] ?? "").localeCompare(b.nodes[0] ?? "");

export function scan(workflow: Workflow, manifest?: Manifest): Report {
  const ctx = buildContext(workflow, manifest);
  const { findings: approvalFindings, approvals } = approvalRules(ctx);
  const findings = [...credentialRules(ctx), ...clientIdRules(ctx), ...crossClientRules(ctx), ...approvalFindings, ...exportRules(ctx)].sort(byImportance);

  const active = workflow.nodes.filter((n) => !n.disabled);
  const subWorkflows = active.filter((n) => isSubWorkflowCall(n.type)).map((n) => n.name);
  const gaps: string[] = [];
  if (!manifest && ctx.touchpoints.length > 0) {
    gaps.push("No client manifest, so credentials and company IDs weren't checked against your client list.");
  }
  const noCredential = findings.find((f) => f.ruleId === "RG103");
  if (noCredential) gaps.push(`${noCredential.nodes.join(", ")}: no credential in the export, so the client is unknown.`);
  for (const tp of ctx.touchpoints) {
    if (tp.realm.kind === "unknown") gaps.push(`${tp.node.name}: couldn't read the company ID in the URL.`);
  }
  for (const s of subWorkflows) gaps.push(`${s} calls a separate workflow. This report can't see inside it, so scan that one too.`);
  if (workflow.unresolvedConnections > 0 && ctx.touchpoints.length > 0) {
    gaps.push(`${String(workflow.unresolvedConnections)} ${workflow.unresolvedConnections === 1 ? "connection points" : "connections point"} to nodes that aren't in this file, so the order of some steps couldn't be read.`);
  }

  // Nodes that may reach QuickBooks in ways the export doesn't show.
  const communityNodes = active.filter((n) => isCommunityNode(n.type) && !isSticky(n.type)).map((n) => n.name);
  const mentions = (n: (typeof active)[number]) =>
    MENTIONS_QUICKBOOKS.test(n.name) || MENTIONS_QUICKBOOKS.test(n.type) || [...stringLeaves(n.parameters)].some(([, v]) => MENTIONS_QUICKBOOKS.test(v));
  for (const n of active) {
    if (ctx.byNode.has(n.name)) continue;
    if (isCodeNode(n.type) && MENTIONS_QUICKBOOKS.test(codeOf(n))) gaps.push(`${n.name} is a Code node that mentions QuickBooks. Code isn't analyzed, so check it by hand.`);
    else if (isMcpClient(n.type) && mentions(n)) gaps.push(`${n.name} is an MCP tool that looks like it connects to QuickBooks. Its tools aren't in the export, so check it by hand.`);
    else if (isCommunityNode(n.type) && mentions(n)) gaps.push(`${n.name} is a community node that looks like it talks to QuickBooks. Realm Guard doesn't know its parameters, so check it by hand.`);
  }

  const worst = findings[0]?.severity;
  let verdict: Verdict;
  if (ctx.touchpoints.length === 0 && findings.length === 0) verdict = gaps.length > 0 ? "not-verified" : "nothing-to-check";
  else if (worst === "critical" || worst === "high") verdict = "fix";
  else if (gaps.length > 0) verdict = "not-verified";
  else if (findings.length > 0) verdict = "review";
  else verdict = "clear";

  const touched = ctx.tenancy.sort(ctx.touchpoints.flatMap((t) => t.tenants));
  return {
    workflowName: workflow.name,
    verdict,
    findings,
    touchpoints: ctx.touchpoints.map((tp) => {
      const out: Report["touchpoints"][number] = {
        node: tp.node.name,
        kind: tp.kind,
        operation: tp.operation,
        write: tp.write,
        auth: tp.auth.kind === "credential" && !tp.auth.credential ? "none" : tp.auth.kind,
        realmIsExpression: tp.realm.kind === "expression",
        tenants: tp.tenants,
        approval: approvals.get(tp.node.name) ?? "not-a-write",
      };
      if (tp.auth.kind === "credential" && tp.auth.credential) out.credential = tp.auth.credential;
      if (tp.realm.kind === "literal") out.realmId = tp.realm.id;
      return out;
    }),
    tenantsTouched: touched,
    tenantNames: Object.fromEntries(ctx.tenancy.names),
    scope: manifest ? manifest.scope : [],
    hasManifest: manifest !== undefined,
    coverage: {
      nodes: active.length,
      disabledNodes: workflow.nodes.filter((n) => n.disabled).map((n) => n.name),
      subWorkflows,
      communityNodes,
      gaps,
    },
  };
}
