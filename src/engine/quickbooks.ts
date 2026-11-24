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
  /** A literal bearer token in a header the node doesn't send. It still ships with the file. */
  unusedPastedToken?: boolean;
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
export function parseQboUrl(raw: string, assumeQbo = false): { realm: RealmSource; path: string; pathIsExpression?: true } | undefined {
  const url = raw.startsWith("=") ? raw.slice(1) : raw;
  if (!assumeQbo && !/intuit|quickbooks|\bqbo/i.test(url)) return undefined;
  const marker = "/v3/company/";
  const at = url.indexOf(marker);
  if (at < 0) return undefined;
  // A company ID written inside {{ }} is code, not the URL: `{{ a ? ".../111/..." : ".../222/..." }}`
  // picks the company at run time even though each branch spells out a number.
  if (raw.startsWith("=") && insideExpression(url, at)) {
    // Only an expression that is one template literal spells out the whole URL. A ternary or a
    // variable can return a path that isn't in the text, so the path stays unknown and a POST
    // counts as a write.
    // Interpolations are blanked first, so a path inside `${a || "111/query"}` never counts.
    const raw = /^\s*\{\{\s*`([^`]*)`\s*\}\}\s*$/.exec(url)?.[1];
    const template = raw === undefined ? undefined : maskInterpolations(raw);
    const paths = template === undefined ? [] : [...template.matchAll(/\/v3\/company\/[^/?#]*\/([a-z0-9]+)(?=$|[/?#])/gi)].map((m) => (m[1] ?? "").toLowerCase());
    const realm: RealmSource = { kind: "expression", expr: url };
    return paths.length === 1 && paths[0] ? { realm, path: paths[0] } : { realm, path: "", pathIsExpression: true };
  }
  const rest = url.slice(at + marker.length);
  let segment: string;
  if (rest.startsWith("{{")) {
    const end = rest.indexOf("}}");
    segment = end < 0 ? rest : rest.slice(0, end + 2);
  } else {
    segment = /^[^/?#]*/.exec(rest)?.[0] ?? "";
  }
  const after = rest.slice(segment.length).replace(/^\//, "");
  const word = (/^[a-z0-9]*/i.exec(after)?.[0] ?? "").toLowerCase();
  // `/{{ $json.entity }}` or `/query{{ $json.suffix }}` leaves the path to run time.
  const pathIsExpression = /^[{$]/.test(after.slice(word.length));
  const path = pathIsExpression ? "" : word;
  let realm: RealmSource;
  // {{ }} expressions, ${} inside a template literal, and {name} placeholders that an agent
  // fills in on the HTTP Request tool all make the company ID dynamic.
  if (/[{$]/.test(segment)) realm = { kind: "expression", expr: segment };
  else if (/^\d+$/.test(segment)) realm = { kind: "literal", id: segment };
  else realm = { kind: "unknown" };
  return pathIsExpression ? { realm, path, pathIsExpression } : { realm, path };
}

/**
 * Replaces each `${...}` in a template literal with one NUL. Counts braces and skips quoted
 * strings, so `${({}).a || "111/query"}` is masked whole. An unclosed one masks to the end.
 */
function maskInterpolations(template: string): string {
  let out = "";
  let i = 0;
  while (i < template.length) {
    if (!template.startsWith("${", i)) {
      out += template.charAt(i);
      i++;
      continue;
    }
    let depth = 0;
    let quote: string | undefined;
    let j = i + 1;
    for (; j < template.length; j++) {
      const ch = template.charAt(j);
      if (quote) {
        if (ch === "\\") j++;
        else if (ch === quote) quote = undefined;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) break;
    }
    out += "\u0000";
    i = j + 1;
  }
  return out;
}

function insideExpression(url: string, at: number): boolean {
  for (const m of url.matchAll(/\{\{[\s\S]*?(\}\}|$)/g)) if (at >= m.index && at < m.index + m[0].length) return true;
  return false;
}

interface Header {
  name: string;
  value: string;
  /** The AI HTTP tool lets the model supply a header, or a {placeholder} in it. */
  fromModel?: boolean;
}

const TOOL_HTTP = "@n8n/n8n-nodes-langchain.toolHttpRequest";
const PLACEHOLDER = /\{[^{}$]+\}/;

type HeaderSource = "keypair" | "legacy-list" | "tool-list" | "json" | "legacy-json";

function headerList(node: WorkflowNode, source: HeaderSource): Header[] {
  const p = node.parameters;
  const tool = node.type === TOOL_HTTP;
  if (source === "json" || source === "legacy-json") {
    const raw = str(p[source === "json" ? "jsonHeaders" : "headerParametersJson"]);
    if (!raw) return [];
    // Static JSON is parsed, so escapes like "Authoriz\u0061tion" decode the way n8n's will.
    // JSON with {{ }} can't be parsed before run time, so a pattern reads it instead.
    let found: string | undefined;
    if (!raw.includes("{{")) {
      try {
        const parsed: unknown = JSON.parse(raw.replace(/^=/, ""));
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          const entry = Object.entries(parsed).find(([k, v]) => k.toLowerCase() === "authorization" && typeof v === "string");
          found = entry?.[1] as string | undefined;
        }
      } catch {
        // Not valid JSON on its own; fall through to the pattern.
      }
    }
    found ??= /"authorization"\s*:\s*"([^"]*)"/i.exec(raw)?.[1];
    if (found === undefined) return [];
    const value = raw.startsWith("=") ? `=${found}` : found;
    return [tool && PLACEHOLDER.test(found) ? { name: "Authorization", value, fromModel: true } : { name: "Authorization", value }];
  }
  const list =
    source === "keypair"
      ? (p.headerParameters as { parameters?: unknown } | undefined)?.parameters
      : source === "legacy-list"
        ? (p.headerParametersUi as { parameter?: unknown } | undefined)?.parameter
        : (p.parametersHeaders as { values?: unknown } | undefined)?.values;
  if (!Array.isArray(list)) return [];
  const out: Header[] = [];
  for (const h of list as unknown[]) {
    // Exports can carry null or junk entries; one bad entry mustn't stop the whole scan.
    if (typeof h !== "object" || h === null) continue;
    const entry = h as Record<string, unknown>;
    const name = str(entry.name);
    const value = str(entry.value);
    if (!name) continue;
    if (source === "tool-list") {
      // n8n 2.48 defaults the provider to modelRequired, and only reads `value` for fieldValue.
      const provider = str(entry.valueProvider) ?? "modelRequired";
      const fromModel = provider.includes("model") || PLACEHOLDER.test(value ?? "");
      out.push(fromModel ? { name, value: value ?? "", fromModel } : { name, value: value ?? "" });
    } else if (value !== undefined) out.push({ name, value });
  }
  return out;
}

const ALL_SOURCES: HeaderSource[] = ["keypair", "legacy-list", "tool-list", "json", "legacy-json"];

/**
 * The header list the node actually sends. A node switched from one mode to another can keep
 * the old list in its parameters, and reading that one hides the auth the node really uses.
 */
function activeHeaderSources(node: WorkflowNode): HeaderSource[] {
  const p = node.parameters;
  // HTTP Request v1 and v2 had no on/off switch: a toggle picked the list or the JSON field.
  if (node.type === "n8n-nodes-base.httpRequest" && node.typeVersion < 3 && !("sendHeaders" in p)) return [p.jsonParameters === true ? "legacy-json" : "legacy-list"];
  if (p.sendHeaders !== true) return [];
  if (p.specifyHeaders === "json") return ["json"];
  // The AI HTTP tool keeps its list in its own field; HTTP Request (and its tool form) doesn't read it.
  return [node.type === TOOL_HTTP ? "tool-list" : "keypair"];
}

// A bearer token typed in, even inside an expression (`{{ "Bearer sk_live_..." }}`). Stops at
// `{`, `$`, quotes and `+`, so `Bearer {{ $json.token }}` and `"Bearer " + token` don't count.
// Adjacent string literals are joined first: `"Bearer " + "sk_live_..."` is one pasted token.
const LITERAL_BEARER = /bearer\s+[\w.~/=-]{10,}/i;
const hasLiteralBearer = (value: string) => LITERAL_BEARER.test(value.replace(/(['"`])\s*\+\s*(['"`])/g, ""));

const authHeader = (headers: Header[]) => headers.find((h) => h.name.toLowerCase() === "authorization");

function httpAuth(node: WorkflowNode): AuthSource {
  const p = node.parameters;
  const auth = authHeader(activeHeaderSources(node).flatMap((src) => headerList(node, src)));
  if (auth) {
    // Stands in for the model's argument so the report can say where the token comes from.
    if (auth.fromModel) return { kind: "dynamic-token", expr: "={{ $fromAI('Authorization') }}" };
    if (hasLiteralBearer(auth.value)) return { kind: "pasted-token" };
    if (isExpression(auth.value)) return { kind: "dynamic-token", expr: auth.value };
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
  const auth = httpAuth(node);
  const tp: RawTouchpoint = {
    node,
    kind: HTTP_TOOLS.has(node.type) ? "http-tool" : "http",
    operation: `${dynamicMethod ? "(method set by expression)" : method.toUpperCase()} ${parsed.path || ("pathIsExpression" in parsed ? "(path set by expression)" : "(company)")}`,
    write,
    realm: parsed.realm,
    auth,
  };
  if (auth.kind !== "pasted-token" && ALL_SOURCES.some((src) => hasLiteralBearer(authHeader(headerList(node, src))?.value ?? ""))) tp.unusedPastedToken = true;
  return tp;
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
