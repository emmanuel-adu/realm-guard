import { parseDocument } from "yaml";
import { QBO_CREDENTIAL_TYPE, credentialLabel, findTouchpoints } from "./quickbooks";
import type { Manifest, ParseResult, Tenant, Workflow } from "./types";
import { MAX_INPUT_BYTES } from "./workflow";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

// Realm IDs run to 19 digits, past what a JS number holds exactly, so YAML integers are
// read as BigInt and turned back into strings here.
const scalar = (v: unknown): string | undefined => {
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "bigint" || typeof v === "number") return String(v);
  return undefined;
};

function stringList(v: unknown, where: string, errors: string[]): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    errors.push(`${where} should be a list, like [a, b].`);
    return [];
  }
  const out: string[] = [];
  for (const item of v) {
    const s = scalar(item);
    if (s === undefined) errors.push(`${where} has an entry that isn't text or a number.`);
    else out.push(s);
  }
  return out;
}

export function parseManifest(text: string): ParseResult<Manifest> {
  if (new TextEncoder().encode(text).length > MAX_INPUT_BYTES) {
    return { ok: false, errors: ["This manifest is too large. Keep it under 5 MB."] };
  }
  const doc = parseDocument(text, { intAsBigInt: true, prettyErrors: true });
  const syntax = doc.errors[0];
  if (syntax) {
    const line = syntax.linePos?.[0].line;
    const where = line ? ` on line ${String(line)}` : "";
    const reason = (syntax.message.split("\n")[0] ?? "").replace(/ at line \d+, column \d+:?$/, "");
    return { ok: false, errors: [`The manifest has a syntax error${where}: ${reason}`] };
  }
  let data: unknown;
  try {
    // maxAliasCount stops "billion laughs" alias bombs; an alias that points nowhere throws.
    data = doc.toJS({ maxAliasCount: 50 });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { ok: false, errors: [`The manifest couldn't be read: ${why.split("\n")[0] ?? ""}. Write values out in full instead of using YAML aliases (*name).`] };
  }
  if (!isObj(data)) return { ok: false, errors: ["The manifest should be a YAML or JSON object with a tenants list."] };

  const errors: string[] = [];
  const warnings: string[] = [];
  // A misspelled key must fail loudly: an ignored "Scope" would silently allow every client.
  errors.push(...unknownKeys(data, TOP_KEYS, "The manifest"));
  if (!Array.isArray(data.tenants) || data.tenants.length === 0) {
    return { ok: false, errors: ["The manifest needs at least one tenant under tenants."] };
  }

  const tenants: Tenant[] = [];
  const ids = new Set<string>();
  const realmOwner = new Map<string, string>();
  const credOwners = new Map<string, string[]>();
  data.tenants.forEach((raw, i) => {
    const label = `Tenant ${String(i + 1)}`;
    if (!isObj(raw)) {
      errors.push(`${label} should be an object with an id.`);
      return;
    }
    errors.push(...unknownKeys(raw, TENANT_KEYS, label));
    const id = scalar(raw.id);
    if (!id) {
      errors.push(`${label} has no id.`);
      return;
    }
    if (ids.has(id)) errors.push(`The tenant id "${id}" appears twice.`);
    ids.add(id);
    const realmIds = stringList(raw.realmIds, `${id}.realmIds`, errors);
    const credentials = stringList(raw.credentials, `${id}.credentials`, errors);
    for (const r of realmIds) {
      const owner = realmOwner.get(r);
      if (owner && owner !== id) errors.push(`The realm ID ${r} is listed under both "${owner}" and "${id}". A QuickBooks company belongs to one client.`);
      realmOwner.set(r, id);
    }
    for (const c of credentials) credOwners.set(c, [...(credOwners.get(c) ?? []), id]);
    tenants.push({ id, name: scalar(raw.name) ?? id, realmIds, credentials });
  });

  for (const [cred, owners] of credOwners) {
    if (owners.length > 1) warnings.push(`The credential "${cred}" is listed under ${owners.map((o) => `"${o}"`).join(" and ")}. Any step using it is flagged as shared.`);
  }

  let scope = tenants.map((t) => t.id);
  if (data.scope !== undefined) {
    scope = stringList(data.scope, "scope", errors);
    for (const s of scope) if (!ids.has(s)) errors.push(`scope names "${s}", which isn't a tenant id in this manifest.`);
  }
  const approvalNodes = data.approvalNodes === undefined ? [] : stringList(data.approvalNodes, "approvalNodes", errors);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { tenants, scope, approvalNodes }, warnings };
}

const TOP_KEYS = ["version", "scope", "tenants", "approvalNodes"];
const TENANT_KEYS = ["id", "name", "credentials", "realmIds"];

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) (d[0] as number[])[j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const row = d[i] as number[];
      const prev = d[i - 1] as number[];
      row[j] = Math.min((prev[j] as number) + 1, (row[j - 1] as number) + 1, (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return (d[a.length] as number[])[b.length] as number;
}

function unknownKeys(obj: Obj, known: string[], where: string): string[] {
  return Object.keys(obj)
    .filter((k) => !known.includes(k))
    .map((k) => {
      const close = known.find((n) => n.toLowerCase() === k.toLowerCase()) ?? known.find((n) => distance(n.toLowerCase(), k.toLowerCase()) <= 2);
      return `${where} has an unknown key "${k}".${close ? ` Did you mean "${close}"?` : ` Allowed keys: ${known.join(", ")}.`}`;
    });
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "client";

/** A starting manifest: one tenant per QuickBooks credential the workflow uses. */
export function draftManifest(workflow: Workflow): string {
  const creds = new Map<string, string>();
  const realms = new Map<string, string[]>();
  for (const tp of findTouchpoints(workflow)) {
    if (tp.auth.kind === "credential" && tp.auth.credential && tp.auth.credentialType === QBO_CREDENTIAL_TYPE) {
      const label = credentialLabel(tp.auth.credential);
      creds.set(label, label);
    }
    if (tp.realm.kind === "literal") realms.set(tp.realm.id, [...(realms.get(tp.realm.id) ?? []), tp.node.name]);
  }

  const used = new Set<string>();
  const tenants = [...creds.keys()].map((label) => {
    let id = slug(label);
    for (let n = 2; used.has(id); n++) id = `${slug(label)}-${String(n)}`;
    used.add(id);
    return { id, label };
  });
  if (tenants.length === 0) tenants.push({ id: "client-1", label: "" });

  const q = (s: string) => JSON.stringify(s);
  const lines = [
    `# Realm Guard client manifest, drafted from ${q(workflow.name)}.`,
    "# One tenant per client. List the n8n credentials (name or ID) and the",
    "# QuickBooks company IDs (realm IDs) that belong to each client.",
    "version: 1",
    "# Clients this workflow may touch. Remove the ones it shouldn't.",
    `scope: [${tenants.map((t) => t.id).join(", ")}]`,
    "tenants:",
  ];
  for (const t of tenants) {
    lines.push(`  - id: ${t.id}`);
    lines.push(`    name: ${q(t.label || "Client name")}  # rename to the client's name`);
    lines.push(`    credentials: [${t.label ? q(t.label) : ""}]`);
    lines.push("    realmIds: []");
  }
  if (realms.size > 0) {
    lines.push("# Realm IDs found in HTTP Request URLs. Add each to the right client's realmIds:");
    for (const [id, nodes] of realms) lines.push(`#   ${id}  (${nodes.join(", ")})`);
  }
  lines.push("# Optional: names of custom approval steps, such as an Airtable review queue.");
  lines.push("approvalNodes: []");
  return `${lines.join("\n")}\n`;
}
