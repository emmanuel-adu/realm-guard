import { isExpression } from "./expressions";
import type { CredentialRef, TouchpointKind, Workflow, WorkflowNode } from "./types";

export const QBO_CREDENTIAL_TYPE = "quickBooksOAuth2Api";

const QBO_NODE = "n8n-nodes-base.quickbooks";
const QBO_TOOL = "n8n-nodes-base.quickbooksTool";
const HTTP_NODES = new Set(["n8n-nodes-base.httpRequest"]);
const HTTP_TOOLS = new Set(["n8n-nodes-base.httpRequestTool", "@n8n/n8n-nodes-langchain.toolHttpRequest"]);

// QuickBooks node operations that change the books or send something to a customer.
const WRITE_OPS = new Set(["create", "update", "delete", "send", "void"]);
// QBO API paths that only read, even over POST.
const READ_PATHS = new Set(["query", "reports", "companyinfo", "preferences", "cdc"]);

export type RealmSource =
  | { kind: "from-credential" }
  | { kind: "literal"; id: string }
  | { kind: "expression"; expr: string }
  | { kind: "unknown" };

export type AuthSource =
  | { kind: "credential"; credentialType: string; credential?: CredentialRef }
  | { kind: "dynamic-token"; expr: string }
  | { kind: "pasted-token" }
  | { kind: "none" };

export interface RawTouchpoint {
  node: WorkflowNode;
  kind: TouchpointKind;
  operation: string;
  write: boolean;
  realm: RealmSource;
  auth: AuthSource;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

function qboNodeTouchpoint(node: WorkflowNode): RawTouchpoint {
  const p = node.parameters;
  const resource = str(p.resource) ?? "customer";
  const operation = str(p.operation) ?? (resource === "transaction" ? "getReport" : "get");
  // An operation picked by expression could be anything, so treat it as a write.
  const write = isExpression(operation) || WRITE_OPS.has(operation);
  const credential = node.credentials[QBO_CREDENTIAL_TYPE];
  return {
    node,
    kind: node.type === QBO_TOOL ? "quickbooks-tool" : "quickbooks-node",
    operation: `${resource}: ${isExpression(operation) ? "(set by expression)" : operation}`,
    write,
    realm: { kind: "from-credential" },
    auth: credential ? { kind: "credential", credentialType: QBO_CREDENTIAL_TYPE, credential } : { kind: "none" },
  };
}

/**
 * Splits a QBO API URL into the realm segment and the path after it. `assumeQbo` is set when
 * the node's credential already marks it as a QuickBooks call, so the host can be hidden.
 */
export function parseQboUrl(raw: string, assumeQbo = false): { realm: RealmSource; path: string } | undefined {
  const url = raw.startsWith("=") ? raw.slice(1) : raw;
  if (!assumeQbo && !/intuit|quickbooks|\bqbo/i.test(url)) return undefined;
  const marker = "/v3/company/";
  const at = url.indexOf(marker);
  if (at < 0) return undefined;
  const rest = url.slice(at + marker.length);
  let segment: string;
  if (rest.startsWith("{{")) {
    const end = rest.indexOf("}}");
    segment = end < 0 ? rest : rest.slice(0, end + 2);
  } else {
    segment = /^[^/?#]*/.exec(rest)?.[0] ?? "";
  }
  const after = rest.slice(segment.length).replace(/^\//, "");
  const path = (/^[a-z0-9]*/i.exec(after)?.[0] ?? "").toLowerCase();
  let realm: RealmSource;
  // {{ }} expressions, ${} inside a template literal, and {name} placeholders that an agent
  // fills in on the HTTP Request tool all make the company ID dynamic.
  if (/[{$]/.test(segment)) realm = { kind: "expression", expr: segment };
  else if (/^\d+$/.test(segment)) realm = { kind: "literal", id: segment };
  else realm = { kind: "unknown" };
  return { realm, path };
}

interface Header {
  name: string;
  value: string;
}

function headersOf(p: Record<string, unknown>): Header[] {
  const out: Header[] = [];
  const lists = [
    (p.headerParameters as { parameters?: unknown } | undefined)?.parameters,
    (p.headerParametersUi as { parameter?: unknown } | undefined)?.parameter,
    (p.parametersHeaders as { values?: unknown } | undefined)?.values,
  ];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const h of list as Record<string, unknown>[]) {
      const name = str(h.name);
      const value = str(h.value);
      if (name && value !== undefined) out.push({ name, value });
    }
  }
  for (const key of ["jsonHeaders", "headerParametersJson"]) {
    const raw = str(p[key]);
    if (!raw) continue;
    const m = /"authorization"\s*:\s*"([^"]*)"/i.exec(raw);
    if (m?.[1] !== undefined) out.push({ name: "Authorization", value: raw.startsWith("=") ? `=${m[1]}` : m[1] });
  }
  return out;
}

function httpAuth(node: WorkflowNode): AuthSource {
  const p = node.parameters;
  const auth = headersOf(p).find((h) => h.name.toLowerCase() === "authorization");
  if (auth) {
    if (isExpression(auth.value)) return { kind: "dynamic-token", expr: auth.value };
    if (/bearer\s+\S{10,}/i.test(auth.value)) return { kind: "pasted-token" };
  }
  let credentialType: string | undefined;
  if (p.authentication === "predefinedCredentialType") credentialType = str(p.nodeCredentialType);
  else if (p.authentication === "genericCredentialType") credentialType = str(p.genericAuthType);
  // Exported templates sometimes carry placeholder auth settings; the attached QuickBooks
  // credential is the better signal of what the node really uses.
  if (credentialType === undefined || !(credentialType in node.credentials)) {
    credentialType = QBO_CREDENTIAL_TYPE in node.credentials ? QBO_CREDENTIAL_TYPE : (credentialType ?? Object.keys(node.credentials)[0]);
  }
  if (!credentialType) return { kind: "none" };
  const credential = node.credentials[credentialType];
  return credential ? { kind: "credential", credentialType, credential } : { kind: "credential", credentialType };
}

function httpTouchpoint(node: WorkflowNode): RawTouchpoint | undefined {
  const url = str(node.parameters.url) ?? "";
  // A QuickBooks credential on the node, or QuickBooks picked as its credential type, marks it
  // as a QBO call even when the URL is hidden behind a variable or expression.
  const qboSignal = QBO_CREDENTIAL_TYPE in node.credentials || node.parameters.nodeCredentialType === QBO_CREDENTIAL_TYPE;
  const parsed = parseQboUrl(url, qboSignal) ?? (qboSignal ? { realm: { kind: "unknown" } as const, path: "" } : undefined);
  if (!parsed) return undefined;
  const method = str(node.parameters.method) ?? str(node.parameters.requestMethod) ?? "GET";
  const dynamicMethod = isExpression(method);
  const write = dynamicMethod || (method.toUpperCase() !== "GET" && !READ_PATHS.has(parsed.path));
  return {
    node,
    kind: HTTP_TOOLS.has(node.type) ? "http-tool" : "http",
    operation: `${dynamicMethod ? "(method set by expression)" : method.toUpperCase()} ${parsed.path || "(company)"}`,
    write,
    realm: parsed.realm,
    auth: httpAuth(node),
  };
}

export function findTouchpoints(workflow: Workflow): RawTouchpoint[] {
  const out: RawTouchpoint[] = [];
  for (const node of workflow.nodes) {
    if (node.disabled) continue;
    if (node.type === QBO_NODE || node.type === QBO_TOOL) out.push(qboNodeTouchpoint(node));
    else if (HTTP_NODES.has(node.type) || HTTP_TOOLS.has(node.type)) {
      const tp = httpTouchpoint(node);
      if (tp) out.push(tp);
    }
  }
  return out;
}

export const credentialLabel = (c: CredentialRef) => c.name ?? `credential ${c.id ?? "?"}`;
