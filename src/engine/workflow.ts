import type { CredentialRef, Edge, ParseResult, Workflow, WorkflowNode } from "./types";

export const MAX_INPUT_BYTES = 5 * 1024 * 1024;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export function jsonErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^JSON\.parse: /, "");
}

// Real exports store credentials three ways: `{id, name}` (current editor), a bare name
// string (older exports), and `{name}` (some template sites strip the id).
function normalizeCredential(raw: unknown): CredentialRef | undefined {
  if (typeof raw === "string") return raw.trim() ? { name: raw } : undefined;
  if (!isObj(raw)) return undefined;
  const ref: CredentialRef = {};
  if (typeof raw.id === "string" && raw.id.trim()) ref.id = raw.id;
  else if (typeof raw.id === "number") ref.id = String(raw.id);
  if (typeof raw.name === "string" && raw.name.trim()) ref.name = raw.name;
  return ref.id ?? ref.name ? ref : undefined;
}

function normalizeNode(raw: unknown, index: number): WorkflowNode | string {
  if (!isObj(raw)) return `Node ${String(index + 1)} isn't an object.`;
  const name = typeof raw.name === "string" ? raw.name : undefined;
  const type = typeof raw.type === "string" ? raw.type : undefined;
  if (!name || !type) return `Node ${String(index + 1)} is missing its name or type.`;
  const credentials: Record<string, CredentialRef> = {};
  if (isObj(raw.credentials)) {
    for (const [key, value] of Object.entries(raw.credentials)) {
      const ref = normalizeCredential(value);
      if (ref) credentials[key] = ref;
    }
  }
  return {
    name,
    type,
    typeVersion: typeof raw.typeVersion === "number" ? raw.typeVersion : 1,
    parameters: isObj(raw.parameters) ? raw.parameters : {},
    credentials,
    disabled: raw.disabled === true,
  };
}

/** Edges between known nodes, plus how many connection ends named no node in the file. */
function normalizeEdges(raw: unknown, known: Set<string>): { edges: Edge[]; unresolved: number } {
  const edges: Edge[] = [];
  let unresolved = 0;
  if (!isObj(raw)) return { edges, unresolved };
  for (const [from, byType] of Object.entries(raw)) {
    if (!isObj(byType)) continue;
    for (const [type, outputs] of Object.entries(byType)) {
      if (!Array.isArray(outputs)) continue;
      for (const output of outputs) {
        if (!Array.isArray(output)) continue;
        for (const target of output) {
          if (!isObj(target) || typeof target.node !== "string") continue;
          if (known.has(from) && known.has(target.node)) edges.push({ from, to: target.node, type });
          else unresolved++;
        }
      }
    }
  }
  return { edges, unresolved };
}

export function parseWorkflow(text: string): ParseResult<Workflow> {
  if (new TextEncoder().encode(text).length > MAX_INPUT_BYTES) {
    return { ok: false, errors: ["This file is too large. Realm Guard reads workflow exports up to 5 MB."] };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { ok: false, errors: [`This file isn't valid JSON (${jsonErrorMessage(err)}). Export the workflow again from n8n with Download.`] };
  }

  // `n8n export:workflow` writes an array; the public API wraps it in `data`.
  if (isObj(data) && Array.isArray(data.data) && !("nodes" in data)) data = data.data;
  if (Array.isArray(data)) {
    if (data.length !== 1) {
      return { ok: false, errors: [`This file holds ${String(data.length)} workflows. Scan them one at a time.`] };
    }
    data = data[0];
  }

  if (!isObj(data) || !Array.isArray(data.nodes)) {
    return { ok: false, errors: ["This doesn't look like an n8n workflow export. It needs a \"nodes\" list. In n8n, open the workflow and use Download, or select all nodes and copy."] };
  }

  const nodes: WorkflowNode[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  data.nodes.forEach((raw, i) => {
    const n = normalizeNode(raw, i);
    if (typeof n === "string") warnings.push(`${n} It was skipped.`);
    else if (seen.has(n.name)) warnings.push(`Two nodes are named "${n.name}". Only the first was scanned.`);
    else {
      seen.add(n.name);
      nodes.push(n);
    }
  });

  const pinData = isObj(data.pinData) ? data.pinData : {};
  const pinned = Object.entries(pinData)
    .filter(([, items]) => (Array.isArray(items) ? items.length > 0 : items != null))
    .map(([node]) => node);

  const { edges, unresolved } = normalizeEdges(data.connections, seen);
  if (unresolved > 0) warnings.push(`${String(unresolved)} ${unresolved === 1 ? "connection points" : "connections point"} to nodes that aren't in this file, so the order of some steps couldn't be read.`);

  return {
    ok: true,
    warnings,
    value: {
      name: typeof data.name === "string" && data.name.trim() ? data.name : "Untitled workflow",
      nodes,
      edges,
      pinnedNodes: pinned,
      unresolvedConnections: unresolved,
    },
  };
}
