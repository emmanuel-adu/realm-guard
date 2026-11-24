import { referencedNodes, stringLeaves } from "./expressions";
import { isAgent, isHitlReview } from "./nodes";
import type { Workflow, WorkflowNode } from "./types";

export interface AgentTool {
  tool: string;
  reviewedBy?: string;
  /** The nested agent the tool belongs to, when it isn't the agent's own. */
  via?: string;
}

interface Out {
  to: string;
  output: number;
}

/** Which outputs of an enabled node a walk may leave by. Undefined means all of them. */
export type OutputFilter = (node: string) => ((output: number) => boolean) | undefined;

/**
 * The workflow as a graph of enabled nodes. n8n passes data straight through a disabled
 * node, so walks step through disabled nodes without stopping or reporting them. Bridging
 * them into direct edges instead would add one edge per (parent, child) pair, which a single
 * disabled node with wide fan-in and fan-out turns into millions.
 */
export class Graph {
  readonly byName = new Map<string, WorkflowNode>();
  private readonly disabled = new Set<string>();
  private readonly outs = new Map<string, Out[]>();
  private readonly ins = new Map<string, string[]>();
  private readonly toolTargets = new Map<string, string[]>();
  private readonly attached = new Map<string, string[]>();
  private readonly refs = new Map<string, string[]>();
  /** Disabled nodes with an enabled node somewhere upstream, and somewhere downstream. */
  private readonly fedByEnabled = new Set<string>();
  private readonly feedsEnabled = new Set<string>();

  constructor(workflow: Workflow) {
    for (const n of workflow.nodes) {
      if (n.disabled) this.disabled.add(n.name);
      else this.byName.set(n.name, n);
    }

    // Sets rather than list lookups: a hub node with thousands of edges made those quadratic.
    const seenOuts = new Set<string>();
    const seenIns = new Set<string>();
    for (const e of workflow.edges) {
      if (!this.known(e.from) || !this.known(e.to)) continue;
      if (e.type === "main") {
        const pair = `${e.from}\u0000${e.to}`;
        const out = `${pair}\u0000${String(e.output)}`;
        if (!seenOuts.has(out)) {
          seenOuts.add(out);
          append(this.outs, e.from, { to: e.to, output: e.output });
        }
        if (!seenIns.has(pair)) {
          seenIns.add(pair);
          append(this.ins, e.to, e.from);
        }
      } else if (this.byName.has(e.from) && this.byName.has(e.to)) {
        // Sub-node edges point from the sub-node (tool, memory, model) to what uses it.
        // n8n leaves disabled sub-nodes out entirely, so those edges are dropped.
        addUnique(this.attached, e.to, e.from);
        if (e.type === "ai_tool") addUnique(this.toolTargets, e.from, e.to);
      }
    }

    this.markPassThrough(this.fedByEnabled, (n) => (this.outs.get(n) ?? []).map((o) => o.to));
    this.markPassThrough(this.feedsEnabled, (n) => this.ins.get(n) ?? []);

    for (const n of this.byName.values()) {
      const names = new Set<string>();
      for (const [, value] of stringLeaves(n.parameters)) for (const r of referencedNodes(value)) if (r !== n.name && this.byName.has(r)) names.add(r);
      if (names.size > 0) this.refs.set(n.name, [...names]);
    }
  }

  private known(name: string) {
    return this.byName.has(name) || this.disabled.has(name);
  }

  /** Marks disabled nodes reachable from an enabled node in the given direction. */
  private markPassThrough(marked: Set<string>, next: (n: string) => string[]) {
    const queue: string[] = [];
    for (const n of this.byName.keys()) for (const m of next(n)) if (this.disabled.has(m)) queue.push(m);
    while (queue.length > 0) {
      const n = queue.pop() as string;
      if (marked.has(n)) continue;
      marked.add(n);
      for (const m of next(n)) if (this.disabled.has(m) && !marked.has(m)) queue.push(m);
    }
  }

  node(name: string) {
    return this.byName.get(name);
  }

  /** Enabled nodes that feed `name` directly or through disabled nodes. */
  mainParents(name: string): string[] {
    return this.through(this.ins.get(name) ?? [], (n) => this.ins.get(n) ?? []);
  }

  /** Enabled nodes `name` feeds directly or through disabled nodes, optionally from some outputs only. */
  mainChildren(name: string, outputs?: (output: number) => boolean): string[] {
    const first = (this.outs.get(name) ?? []).filter((o) => !outputs || outputs(o.output)).map((o) => o.to);
    return this.through(first, (n) => (this.outs.get(n) ?? []).map((o) => o.to));
  }

  hasMainParent(name: string) {
    return (this.ins.get(name) ?? []).some((p) => this.byName.has(p) || this.fedByEnabled.has(p));
  }

  hasMainEdges(name: string) {
    return this.hasMainParent(name) || (this.outs.get(name) ?? []).some((o) => this.byName.has(o.to) || this.feedsEnabled.has(o.to));
  }

  private through(first: string[], next: (n: string) => string[]): string[] {
    const out = new Set<string>();
    const seen = new Set<string>();
    const stack = [...first];
    while (stack.length > 0) {
      const n = stack.pop() as string;
      if (seen.has(n)) continue;
      seen.add(n);
      if (this.byName.has(n)) out.add(n);
      else stack.push(...next(n));
    }
    return [...out];
  }

  /** Nodes a tool hands its results to: an agent, or a human review step in front of one. */
  toolConsumers(name: string) {
    return this.toolTargets.get(name) ?? [];
  }

  /**
   * Tools an agent can call, looking through human review steps to the tools behind them and
   * into nested agents (an agent used as another agent's tool).
   */
  agentTools(agent: string, seen = new Set<string>()): AgentTool[] {
    if (seen.has(agent)) return [];
    seen.add(agent);
    const out: AgentTool[] = [];
    const add = (tool: string, reviewedBy?: string) => {
      const entry: AgentTool = { tool };
      if (reviewedBy) entry.reviewedBy = reviewedBy;
      out.push(entry);
      if (isAgent(this.byName.get(tool)?.type ?? "")) {
        for (const nested of this.agentTools(tool, seen)) out.push({ ...nested, via: nested.via ?? tool });
      }
    };
    for (const sub of this.attached.get(agent) ?? []) {
      const node = this.byName.get(sub);
      if (!node) continue;
      if (isHitlReview(node.type)) {
        for (const gated of this.attached.get(sub) ?? []) add(gated, sub);
      } else if ((this.toolTargets.get(sub) ?? []).includes(agent)) {
        add(sub);
      }
    }
    return out;
  }

  /** Agents (or review steps) a sub-node such as a memory is attached to. */
  attachedTo(sub: string): string[] {
    const out: string[] = [];
    for (const [owner, subs] of this.attached) if (subs.includes(sub)) out.push(owner);
    return out;
  }

  /**
   * Enabled main-edge descendants of `start`, never entering `blocked`. Includes `start`.
   * `follow` limits which outputs of a node the walk leaves by, so a check can stop one
   * branch of an IF and not the other.
   */
  reach(start: Iterable<string>, blocked: ReadonlySet<string> = new Set(), follow?: OutputFilter): Set<string> {
    const result = new Set<string>();
    const seen = new Set<string>();
    const queue = [...start].filter((n) => !blocked.has(n));
    while (queue.length > 0) {
      const n = queue.pop() as string;
      if (seen.has(n)) continue;
      seen.add(n);
      const enabled = this.byName.has(n);
      if (enabled) result.add(n);
      const allowed = enabled ? follow?.(n) : undefined;
      for (const o of this.outs.get(n) ?? []) {
        if (allowed && !allowed(o.output)) continue;
        if (!blocked.has(o.to) && !seen.has(o.to)) queue.push(o.to);
      }
    }
    return result;
  }

  /**
   * Every node whose output can end up in `node`: main-edge ancestors plus nodes named in
   * expressions such as $('Read A'), followed transitively.
   */
  dataSources(node: string): Set<string> {
    return this.walkBack(node, (n) => [...(this.ins.get(n) ?? []), ...(this.refs.get(n) ?? [])]);
  }

  private walkBack(node: string, next: (n: string) => string[]): Set<string> {
    const result = new Set<string>();
    const seen = new Set<string>();
    const queue = [...next(node)];
    while (queue.length > 0) {
      const n = queue.pop() as string;
      if (seen.has(n) || n === node) continue;
      seen.add(n);
      if (this.byName.has(n)) result.add(n);
      queue.push(...next(n));
    }
    return result;
  }
}


function append<T>(map: Map<string, T[]>, key: string, value: T) {
  const list = map.get(key);
  if (!list) map.set(key, [value]);
  else list.push(value);
}

function addUnique(map: Map<string, string[]>, key: string, value: string) {
  const list = map.get(key);
  if (!list) map.set(key, [value]);
  else if (!list.includes(value)) list.push(value);
}
