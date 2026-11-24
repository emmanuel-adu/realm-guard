import { type Context, type Resolved, credentialKey } from "./context";
import { answerKeys, approvedOutputs } from "./decisions";
import { isExpression, itemSelections, referencedNodes, usesFromAI, usesIncomingItem } from "./expressions";
import { approvalKind, codeOf, isAgent, isAiNode, isCodeNode, isDecision, isHitlReview, isSticky, memoryKind, triggerKind } from "./nodes";
import { credentialLabel } from "./quickbooks";
import type { Approval, Finding } from "./types";

const quote = (s: string) => `"${s}"`;
const clip = (s: string, n = 90) => {
  const t = s.startsWith("=") ? s.slice(1) : s;
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const TRIGGER_LABEL = { manual: "manual run", scheduled: "schedule", external: "outside event", subworkflow: "called by another workflow" } as const;
const verb = (tp: Resolved) => (/: send$/.test(tp.operation) ? "sends from" : "writes to");
const plural = (n: number, one: string, many = `${one}s`) => `${String(n)} ${n === 1 ? one : many}`;

function groupBy<T>(items: T[], key: (t: T) => string | undefined): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (k === undefined) continue;
    const bucket = out.get(k);
    if (bucket) bucket.push(item);
    else out.set(k, [item]);
  }
  return out;
}

/**
 * Where a run-time value comes from, in words. Never the expression itself, which can hold a
 * real token, and never text from `$('...')` unless it's the name of a node in this file.
 */
function sourceOf(expr: string, isNode: (name: string) => boolean): string {
  const parts = referencedNodes(expr).filter(isNode).map(quote);
  if (usesFromAI(expr)) parts.push("the AI model");
  if (usesIncomingItem(expr)) parts.push("the incoming item");
  if (/\$env\b/.test(expr)) parts.push("an environment variable");
  if (/\$vars\b/.test(expr)) parts.push("a workflow variable");
  if (/\$secrets\b/.test(expr)) parts.push("an external secret");
  if (parts.length === 0) return "an expression";
  return parts.length === 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1) ?? ""}`;
}

const nodeNames = (ctx: Context) => {
  const names = new Set(ctx.workflow.nodes.map((n) => n.name));
  return (name: string) => names.has(name);
};

const credOf = (tp: Resolved) => (tp.auth.kind === "credential" && tp.auth.credential ? tp.auth.credential : undefined);
const credKey = (tp: Resolved) => {
  const c = credOf(tp);
  return c ? credentialKey(c) : undefined;
};

// ---------------------------------------------------------------------------- credentials

export function credentialRules(ctx: Context): Finding[] {
  const out: Finding[] = [];
  const { tenancy, scope, manifest } = ctx;
  const scopeNames = tenancy.list(scope);

  const missing = ctx.touchpoints.filter((tp) => tp.auth.kind === "none" || (tp.auth.kind === "credential" && !tp.auth.credential));
  if (missing.length > 0) {
    out.push({
      ruleId: "RG103",
      category: "credentials",
      severity: "medium",
      title: "No credential in the export",
      nodes: missing.map((tp) => tp.node.name),
      detail: `The export doesn't say which QuickBooks connection ${missing.length === 1 ? "this step uses" : "these steps use"}.`,
      why: "Template downloads and some copies strip credentials. Without one, there's no way to tell whose books the step touches.",
      fix: "Export the workflow from your own n8n with Download (or select all and copy), so each node keeps its credential name.",
    });
  }

  for (const tps of groupBy(ctx.touchpoints, credKey).values()) {
    const refs = tps.flatMap((tp) => credOf(tp) ?? []);
    const ref = refs.find((c) => c.name) ?? refs[0];
    if (!ref) continue;
    const label = credentialLabel(ref);
    const nodes = tps.map((tp) => tp.node.name);
    // Every reference counts, so the verdict doesn't depend on which node comes first.
    const owners = tenancy.sort(tps.flatMap((tp) => tp.credTenants));
    if (manifest && owners.length === 0) {
      out.push({
        ruleId: "RG101",
        category: "credentials",
        severity: "high",
        title: "Credential isn't mapped to a client",
        nodes,
        detail: `${quote(label)} isn't listed under any client in the manifest.`,
        why: "Nobody can tell whose books this step reads or writes, so there's no way to confirm it stays inside this workflow's clients.",
        fix: `Add ${quote(label)} to the right client's credentials in the manifest, or switch the node to that client's credential.`,
      });
      continue;
    }
    if (manifest && owners.length > 0 && owners.every((t) => !scope.has(t))) {
      out.push({
        ruleId: "RG102",
        category: "credentials",
        severity: "critical",
        title: "Uses another client's credential",
        nodes,
        detail: `${quote(label)} belongs to ${tenancy.list(owners)}, but this workflow is scoped to ${scopeNames}.`,
        why: "This is the copied-workflow mistake: entries land in the wrong client's books, and the right client never gets them.",
        fix: `Switch ${nodes.length === 1 ? "this node" : "these nodes"} to the credential for ${scopeNames}. If the workflow really serves ${tenancy.list(owners)}, add it to scope.`,
      });
    }

    const realms = new Set(tps.flatMap((tp) => (tp.realm.kind === "literal" ? [tp.realm.id] : [])));
    const sharedInManifest = manifest !== undefined && owners.length > 1;
    if (sharedInManifest || realms.size > 1) {
      out.push({
        ruleId: "RG104",
        category: "credentials",
        severity: "high",
        title: "One credential serves several clients",
        nodes,
        detail: sharedInManifest
          ? `${quote(label)} is mapped to ${tenancy.list(owners)}.`
          : `${quote(label)} is used with ${String(realms.size)} different company IDs (${[...realms].join(", ")}).`,
        why: "When one token reaches several companies, one wrong ID or one bug reads or writes the wrong client's books, and the audit trail can't tell the clients apart.",
        fix: "Give each client its own QuickBooks connection in n8n, and map each connection to exactly one client.",
      });
    }
  }

  const isNode = nodeNames(ctx);
  for (const tp of ctx.touchpoints) {
    if (tp.auth.kind === "dynamic-token") {
      // Paired only when both read the same item of the same node: first() for the token and
      // last() for the company can be two different clients.
      const tokenPicks = itemSelections(tp.auth.expr);
      const realmPicks = tp.realm.kind === "expression" ? itemSelections(tp.realm.expr) : new Map<string, Set<string>>();
      const pairedBy = [...tokenPicks].find(([node, picks]) => {
        const other = realmPicks.get(node);
        const [pick] = picks;
        return isNode(node) && picks.size === 1 && pick !== "?" && other?.size === 1 && other.has(pick ?? "");
      })?.[0];
      out.push({
        ruleId: "RG105",
        category: "credentials",
        severity: pairedBy ? "medium" : "high",
        title: "Token is picked at run time",
        nodes: [tp.node.name],
        // Names the sources only. The expression itself can hold part of a real token.
        detail: pairedBy
          ? `The Authorization header and the company ID both come from ${quote(pairedBy)}, which keeps them paired.`
          : `The Authorization header is built at run time from ${sourceOf(tp.auth.expr, isNode)}.`,
        why: pairedBy
          ? "Nothing in the workflow proves that lookup returns the right client, so a bad client ID still sends the run to the wrong books."
          : "Which client's token gets used depends on each run's data. A bad client ID or a mixed-up lookup sends one client's token, and data, to another client's company.",
        fix: "Look up the token and the company ID in one step keyed by a single client ID, and reference both from that step. A stored n8n credential per client is safer still.",
      });
    }
    if (tp.auth.kind === "pasted-token" || tp.unusedPastedToken) {
      out.push({
        ruleId: "RG106",
        category: "credentials",
        severity: "high",
        title: "Access token pasted into the node",
        nodes: [tp.node.name],
        detail:
          tp.auth.kind === "pasted-token"
            ? "The Authorization header holds a literal bearer token."
            : "A header value the node doesn't send still holds a literal bearer token. It isn't sent, but it ships with every copy of the file.",
        why: "The token travels with every copy and export of this workflow, so anyone holding the file can call that client's QuickBooks.",
        fix: "Revoke the token in the Intuit developer portal, then use a stored QuickBooks credential instead.",
      });
    }
  }
  return out;
}

// ----------------------------------------------------------------------------- client IDs

export function clientIdRules(ctx: Context): Finding[] {
  const out: Finding[] = [];
  const { tenancy, scope, manifest, graph } = ctx;
  const isNode = nodeNames(ctx);
  for (const tp of ctx.touchpoints) {
    const name = tp.node.name;
    if (tp.realm.kind === "expression") {
      const expr = tp.realm.expr;
      const aiRef = referencedNodes(expr).find((r) => {
        const n = graph.node(r);
        return n !== undefined && isAiNode(n.type);
      });
      const aiParent = usesIncomingItem(expr) ? graph.mainParents(name).find((p) => isAiNode(graph.node(p)?.type ?? "")) : undefined;
      // The HTTP Request tool fills {placeholders} from the model's own arguments.
      const placeholder = tp.kind === "http-tool" && /^\{[^{}$]+\}$/.test(expr);
      const aiSource = usesFromAI(expr) || placeholder ? "the AI model" : (aiRef ?? aiParent);
      out.push({
        ruleId: "RG201",
        category: "client-ids",
        severity: aiSource ? "critical" : "high",
        title: aiSource ? "AI picks which company to call" : "Company ID comes from data",
        nodes: [name],
        // Sources only: a URL expression can carry a token in its query string.
        detail: aiSource
          ? `The company (realm) ID in the URL is filled in by ${aiSource === "the AI model" ? aiSource : quote(aiSource)}.`
          : `The company (realm) ID in the URL is picked at run time from ${sourceOf(expr, isNode)}.`,
        why: aiSource
          ? "A language model decides whose books this call reaches. A prompt injection or a plain mistake points it at another client."
          : "Whatever is in the incoming data decides whose books this call reaches. A wrong row, a typo or a crafted request sends it to another client.",
        fix: "Pin the realm ID in single-client workflows. In multi-client runs, look it up from your client list by a trusted client ID and check it against the allowed list before the call.",
      });
    }
    if (!manifest || tp.realm.kind !== "literal") continue;
    const realm = tp.realm.id;
    if (tp.realmTenants.length === 0) {
      out.push({
        ruleId: "RG203",
        category: "client-ids",
        severity: "high",
        title: "Company ID isn't mapped to a client",
        nodes: [name],
        detail: `Realm ID ${realm} isn't listed under any client in the manifest.`,
        why: "There's no way to tell whose books this is. A leftover ID from testing or from another client looks exactly like this.",
        fix: `Add ${realm} to the right client's realmIds, or replace it with the correct client's ID.`,
      });
      continue;
    }
    if (tp.realmTenants.every((t) => !scope.has(t))) {
      out.push({
        ruleId: "RG202",
        category: "client-ids",
        severity: "critical",
        title: "Calls another client's company",
        nodes: [name],
        detail: `Realm ID ${realm} belongs to ${tenancy.list(tp.realmTenants)}, which is outside this workflow's scope (${tenancy.list(scope)}).`,
        why: "This step reads or writes books this workflow isn't meant to touch.",
        fix: `Change the realm ID to the right client's, or add ${tenancy.list(tp.realmTenants)} to scope if that's intended.`,
      });
    }
    const cred = credOf(tp);
    if (cred && tp.credTenants.length > 0 && !tp.credTenants.some((t) => tp.realmTenants.includes(t))) {
      out.push({
        ruleId: "RG204",
        category: "client-ids",
        severity: "high",
        title: "Company ID and credential belong to different clients",
        nodes: [name],
        detail: `The URL targets ${tenancy.list(tp.realmTenants)} (realm ${realm}), but ${quote(credentialLabel(cred))} belongs to ${tenancy.list(tp.credTenants)}.`,
        why: "Intuit issues tokens per company, so this call usually fails. If it goes through, it lands in a different client's books than the credential suggests.",
        fix: "Use the credential and the realm ID of the same client.",
      });
    }
  }
  return out;
}

// --------------------------------------------------------------------------- cross-client

// An expression that reads nothing from the run ($workflow.id, $vars.x) is the same for every
// client, so it's as fixed as a typed-in key.
const fixedKey = (key: string) =>
  !isExpression(key) || !/\$json|\$input|\$\(|\$node|\$items|\$fromAI|\$execution|\$item\b|\$binary|\$now|\$today|\$runIndex|Math\.random/.test(key);

function memoryKey(node: { typeVersion: number; parameters: Record<string, unknown>; type: string }): string | undefined {
  const p = node.parameters;
  const key = typeof p.sessionKey === "string" ? p.sessionKey : undefined;
  if (p.sessionIdType === "customKey") return key !== undefined && fixedKey(key) ? key : undefined;
  if (p.sessionIdType === "fromInput") return undefined;
  // Before version 1.2 there was no "Session ID" choice, only the key field.
  if (node.typeVersion < 1.2) {
    if (key !== undefined) return fixedKey(key) ? key : undefined;
    // Buffer and Redis memory v1 defaulted to one fixed key for every conversation.
    if (node.typeVersion < 1.1 && /memoryBufferWindow$|memoryRedisChat$/.test(node.type)) return "chat_history";
  }
  return undefined;
}

export function crossClientRules(ctx: Context): Finding[] {
  const out: Finding[] = [];
  const { graph, tenancy, byNode } = ctx;

  // Agents whose tools touch several clients mix those clients in one context window.
  const agents = new Set<string>();
  for (const n of graph.byName.values()) if (isAgent(n.type) || graph.agentTools(n.name).length > 0) agents.add(n.name);
  const agentTenants = new Map<string, Resolved[]>();
  const callers = new Map<string, string[]>();
  for (const agent of agents) {
    const tools = graph.agentTools(agent).flatMap(({ tool }) => {
      const tp = byNode.get(tool);
      return tp ? [tp] : [];
    });
    agentTenants.set(agent, tools);
    for (const t of tools) callers.set(t.node.name, [...(callers.get(t.node.name) ?? []), agent]);
    const tenants = new Set(tools.flatMap((t) => t.tenants));
    if (tenants.size < 2) continue;
    const writes = tools.some((t) => t.write);
    out.push({
      ruleId: "RG302",
      category: "cross-client",
      severity: writes ? "critical" : "high",
      title: "One AI agent can reach several clients' books",
      nodes: [agent, ...tools.map((t) => t.node.name).sort()],
      detail: `${quote(agent)} has tools for ${tenancy.list(tenants)}${writes ? ", and at least one of them writes" : ""}.`,
      why: "Everything the agent reads stays in its context. It can copy one client's records into another client's books, or answer one client with another's numbers.",
      fix: "Give each client its own agent, or build the agent per run with only that client's tools.",
    });
  }

  // Data read from one client's books reaching a write into another's. A tool write gets
  // whatever its agent was handed, so the agent's own inputs count as the tool's.
  const sourcesOf = (start: string): Resolved[] => {
    const sources: Resolved[] = [];
    for (const anc of graph.dataSources(start)) {
      const tp = byNode.get(anc);
      if (tp) sources.push(tp);
      sources.push(...(agentTenants.get(anc) ?? []));
    }
    return sources;
  };
  // One agent can hold many write tools, so walk each agent's inputs once.
  const agentSources = new Map<string, Resolved[]>();
  const foreignTo = (w: Resolved, sources: Resolved[]) => sources.filter((s) => s !== w && s.tenants.some((t) => !w.tenants.includes(t)));
  for (const w of ctx.touchpoints) {
    if (!w.write || w.tenants.length === 0) continue;
    const isTool = w.kind === "quickbooks-tool" || w.kind === "http-tool";
    let foreign = foreignTo(w, sourcesOf(w.node.name));
    let agent: string | undefined;
    if (isTool) {
      for (const a of callers.get(w.node.name) ?? []) {
        let upstream = agentSources.get(a);
        if (!upstream) {
          upstream = sourcesOf(a);
          agentSources.set(a, upstream);
        }
        const viaAgent = foreignTo(w, upstream);
        if (viaAgent.length === 0) continue;
        agent ??= a;
        foreign = [...foreign, ...viaAgent];
      }
    }
    foreign = [...new Set(foreign)];
    if (foreign.length === 0) continue;
    const from = new Set(foreign.flatMap((s) => s.tenants.filter((t) => !w.tenants.includes(t))));
    const through = `${foreign.map((s) => quote(s.node.name)).join(", ")} (${tenancy.list(from)})`;
    out.push({
      ruleId: "RG301",
      category: "cross-client",
      severity: "critical",
      title: "One client's data flows into another client's books",
      nodes: [w.node.name, ...[...new Set(foreign.map((s) => s.node.name))]],
      detail: agent
        ? `${quote(agent)} can call ${quote(w.node.name)}, which ${verb(w)} ${tenancy.list(w.tenants)}'s books, and the agent is handed data that passed through ${through}.`
        : `${quote(w.node.name)} ${verb(w)} ${tenancy.list(w.tenants)}'s books using data that passed through ${through}.`,
      why: "Records from one client end up in another client's ledger: customer names, amounts, memos. That's a data leak and a bookkeeping error at once.",
      fix: "Split the flow so each run reads and writes one client's company, or filter by client ID before the write.",
    });
  }

  for (const n of graph.byName.values()) {
    const kind = memoryKind(n.type);
    if (!kind) continue;
    const key = memoryKey(n);
    if (key === undefined) continue;
    if (!ctx.multiClient && kind === "in-workflow") continue;
    out.push({
      ruleId: "RG303",
      category: "cross-client",
      severity: ctx.multiClient ? "high" : "medium",
      title: "AI memory shared across runs",
      nodes: [n.name, ...graph.attachedTo(n.name)],
      detail: isExpression(key)
        ? `${quote(n.name)} stores chat history under \`${clip(key)}\`, which is the same on every run.`
        : `${quote(n.name)} stores chat history under the fixed key ${quote(key)}.`,
      why: ctx.multiClient
        ? "Every client's run reads and writes the same history, so the agent sees earlier clients' data."
        : "If another client's copy of this workflow uses the same memory store and key, the two share history. Copied workflows usually keep the key.",
      fix: "Build the session key from the client ID, for example `={{ $json.clientId }}-{{ $json.sessionId }}`.",
    });
  }

  if (ctx.multiClient) {
    for (const n of graph.byName.values()) {
      if (!isCodeNode(n.type) || !/getWorkflowStaticData\s*\(/.test(codeOf(n))) continue;
      out.push({
        ruleId: "RG304",
        category: "cross-client",
        severity: "high",
        title: "State kept across every client's runs",
        nodes: [n.name],
        detail: `${quote(n.name)} reads or writes workflow static data.`,
        why: "Static data survives between executions, so whatever one client's run saves is visible to the next client's run.",
        fix: "Key anything you store by client ID, or keep per-client state in a store that's scoped per client.",
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------ approvals

export function approvalRules(ctx: Context): { findings: Finding[]; approvals: Map<string, Approval> } {
  const findings: Finding[] = [];
  const approvals = new Map<string, Approval>();
  const { graph } = ctx;
  const trusted = new Set(ctx.manifest?.approvalNodes ?? []);
  const nodes = [...graph.byName.values()];
  const kinds = new Map<string, "trusted" | "needs-check">();
  for (const n of nodes) {
    const k = approvalKind(n, trusted);
    if (k) kinds.set(n.name, k);
  }
  const gates = new Set(kinds.keys());
  const trustedGates = new Set([...kinds].filter(([, k]) => k === "trusted").map(([n]) => n));
  const decisions = new Map(nodes.filter((n) => isDecision(n.type)).map((n) => [n.name, n]));

  // Entry points: triggers, plus main-flow nodes nothing feeds (a canvas copy or a
  // half-built workflow run with "Execute step").
  const entries = new Map<string, "manual" | "scheduled" | "external" | "subworkflow">();
  for (const n of nodes) {
    const kind = triggerKind(n.type);
    if (kind) entries.set(n.name, kind);
  }
  for (const n of nodes) {
    if (entries.has(n.name) || isSticky(n.type) || graph.hasMainParent(n.name)) continue;
    const tp = ctx.byNode.get(n.name);
    const isTool = tp?.kind === "quickbooks-tool" || tp?.kind === "http-tool";
    if (!isTool && (graph.hasMainEdges(n.name) || tp)) entries.set(n.name, "manual");
  }

  // Everything below is computed once per entry, gate and AI step, not once per write: the
  // per-write version was cubic and froze the tab on large exports.
  const open = new Map<string, Set<string>>();
  for (const e of entries.keys()) open.set(e, graph.reach([e], gates));
  const openAll = new Set<string>();
  for (const set of open.values()) for (const n of set) openAll.add(n);

  // n8n continues past an approval step whatever the answer, so what follows a gate counts
  // as approved only past an IF, Filter or Switch that reads the answer, on a branch that
  // means yes. A check on anything else (the amount, the vendor) protects nothing.
  const undecided = new Map<string, { gate: string; decision?: string }>();
  // Every gate a run can reach, including ones behind an earlier approval: a second approval
  // whose answer nothing checks stops nothing either.
  const runnable = graph.reach(entries.keys());
  for (const [gate, kind] of kinds) {
    if (kind !== "needs-check" || !runnable.has(gate)) continue;
    const gateNode = graph.node(gate);
    if (!gateNode) continue;
    // Whether an IF checks this gate depends on the gate (`$('Approve')`), so read only the
    // decisions this gate can reach.
    const keys = answerKeys(gateNode);
    const start = graph.mainChildren(gate);
    const checks = new Map<string, Set<number>>();
    for (const n of graph.reach(start, trustedGates)) {
      const d = decisions.get(n);
      const approved = d ? approvedOutputs(d, keys, gate) : undefined;
      if (approved) checks.set(n, approved);
    }
    const notYes = (d: string) => {
      const approved = checks.get(d);
      return approved ? (o: number) => !approved.has(o) : undefined;
    };
    const unchecked = graph.reach(start, new Set([...trustedGates, ...checks.keys()]));
    const anyBranch = graph.reach(start, trustedGates, notYes);
    for (const n of unchecked) {
      if (undecided.get(n)?.decision !== undefined || !undecided.has(n)) undecided.set(n, { gate });
    }
    // Name the check whose "no" branch reaches each remaining node. The stop set grows as
    // nodes get a name, so the walks together visit each node once.
    const named = new Set([...trustedGates, ...unchecked]);
    for (const d of checks.keys()) {
      if (!anyBranch.has(d)) continue;
      for (const n of graph.reach(graph.mainChildren(d, notYes(d)), named, notYes)) {
        named.add(n);
        if (!undecided.has(n)) undecided.set(n, { gate, decision: d });
      }
    }
  }

  const aiOpen = nodes.filter((n) => isAiNode(n.type) && openAll.has(n.name));
  const aiReach = new Map(aiOpen.map((a) => [a.name, graph.reach([a.name], gates)]));

  for (const tp of ctx.touchpoints) {
    const name = tp.node.name;
    if (!tp.write) {
      approvals.set(name, "not-a-write");
      continue;
    }
    if (tp.kind === "quickbooks-tool" || tp.kind === "http-tool") {
      const consumers = graph.toolConsumers(name);
      const direct = consumers.filter((c) => !isHitlReview(graph.node(c)?.type ?? ""));
      // A tool no agent can call never runs; calling that "waits for a person" would be wrong.
      approvals.set(name, consumers.length === 0 ? "unattached" : direct.length === 0 ? "gated" : "ungated");
      for (const agent of direct) {
        findings.push({
          ruleId: "RG402",
          category: "approvals",
          severity: "critical",
          title: "AI agent can write to the books without review",
          nodes: [name, agent],
          detail: `${quote(agent)} can call ${quote(name)} (${tp.operation}) with no human review step.`,
          why: "The model decides when to create, change or send records. One misread document or injected instruction becomes a real entry.",
          fix: "In n8n 2.6 or later, click + on the connector between the agent and this tool and add a human review step.",
        });
      }
      continue;
    }

    if (openAll.has(name)) {
      const reaching = [...entries].filter(([e]) => open.get(e)?.has(name) === true);
      const ai = aiOpen.find((a) => aiReach.get(a.name)?.has(name) === true);
      const automatic = reaching.some(([, kind]) => kind !== "manual");
      approvals.set(name, automatic || ai ? "ungated" : "manual-only");
      const how = reaching.map(([e, kind]) => (e === name ? "a manual run of this step" : `${quote(e)} (${TRIGGER_LABEL[kind]})`)).join(", ");
      findings.push({
        ruleId: "RG401",
        category: "approvals",
        severity: ai ? "critical" : automatic ? "high" : "medium",
        title: ai ? "AI output posts to the books unreviewed" : "Writes to the books with no approval step",
        nodes: ai ? [name, ai.name] : [name],
        detail: `${quote(name)} (${tp.operation}) runs from ${how}${ai ? ` after ${quote(ai.name)} decides what to write` : ""}, and nothing on the way waits for a person.`,
        why: ai
          ? "A model's output becomes a ledger entry with no one looking. Confidence scores don't catch a wrong vendor or a wrong amount."
          : automatic
            ? "Mistakes post straight to the client's books. They usually surface at month-end close, after reports went out."
            : "Someone has to click Execute, but nothing shows them what will be posted before it is.",
        fix: "Add an approval step before this node (Send and Wait in Slack, Gmail or Teams, or a Wait node that resumes on a form) and an IF after it that continues only when the answer is yes. If you use your own review queue, list that node under approvalNodes in the manifest.",
      });
      continue;
    }

    const pending = undecided.get(name);
    if (pending) {
      const { gate, decision } = pending;
      approvals.set(name, "unchecked");
      findings.push({
        ruleId: "RG403",
        category: "approvals",
        severity: "high",
        title: decision ? "Write can run when the approval is declined" : "Approval answer is never checked",
        nodes: decision ? [name, gate, decision] : [name, gate],
        detail: decision
          ? `${quote(gate)} asks a person and ${quote(decision)} checks the answer, but ${quote(name)} (${tp.operation}) is on a branch that doesn't mean yes.`
          : `${quote(gate)} asks a person, but nothing checks the answer before ${quote(name)} (${tp.operation}).`,
        why: "n8n moves on to the next step whatever the person clicks, including Disapprove, a timeout or an error. The approval looks like a safeguard and stops nothing.",
        fix: decision
          ? `Connect ${quote(name)} to the output of ${quote(decision)} that continues only when the answer is yes.`
          : "Add an IF after the approval that continues only when it was approved (for Send and Wait, `{{ $json.data.approved }}` is true), and don't wire the approval's error output to the write.",
      });
      continue;
    }
    approvals.set(name, "gated");
  }
  return { findings, approvals };
}

// --------------------------------------------------------------------------------- export

export function exportRules(ctx: Context): Finding[] {
  const pinned = ctx.workflow.pinnedNodes;
  if (pinned.length === 0) return [];
  return [
    {
      ruleId: "RG501",
      category: "export",
      severity: "low",
      title: "Export includes pinned data",
      nodes: pinned,
      detail: `Pinned output is saved on ${plural(pinned.length, "node")}.`,
      why: "Pinned data is real output from earlier runs. Sharing this file can share client records.",
      fix: "Unpin the data in n8n before you download, or delete the pinData section from the file.",
    },
  ];
}
