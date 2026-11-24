import { isHitlReview } from "./nodes";
import type { Workflow, WorkflowNode } from "./types";

export class Graph {
  readonly byName = new Map<string, WorkflowNode>();
  private readonly children = new Map<string, string[]>();
  private readonly parents = new Map<string, string[]>();
  private readonly toolTargets = new Map<string, string[]>();
  private readonly attached = new Map<string, string[]>();

  constructor(workflow: Workflow) {
    for (const n of workflow.nodes) if (!n.disabled) this.byName.set(n.name, n);
    for (const e of workflow.edges) {
      if (!this.byName.has(e.from) || !this.byName.has(e.to)) continue;
      if (e.type === "main") {
        push(this.children, e.from, e.to);
        push(this.parents, e.to, e.from);
      } else {
        // Sub-node edges point from the sub-node (tool, memory, model) to what uses it.
        push(this.attached, e.to, e.from);
        if (e.type === "ai_tool") push(this.toolTargets, e.from, e.to);
      }
    }
  }

  node(name: string) {
    return this.byName.get(name);
  }

  mainParents(name: string) {
    return this.parents.get(name) ?? [];
  }

  hasMainEdges(name: string) {
    return this.parents.has(name) || this.children.has(name);
  }

  /** Nodes a tool hands its results to: an agent, or a human review step in front of one. */
  toolConsumers(name: string) {
    return this.toolTargets.get(name) ?? [];
  }

  /** Tools an agent can call, looking through human review steps to the tools behind them. */
  agentTools(agent: string): { tool: string; reviewedBy?: string }[] {
    const out: { tool: string; reviewedBy?: string }[] = [];
    for (const sub of this.attached.get(agent) ?? []) {
      const node = this.byName.get(sub);
      if (!node) continue;
      if (isHitlReview(node.type)) {
        for (const gated of this.attached.get(sub) ?? []) out.push({ tool: gated, reviewedBy: sub });
      } else if ((this.toolTargets.get(sub) ?? []).includes(agent)) {
        out.push({ tool: sub });
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

  /** Main-edge descendants of `start`, never entering `blocked`. Includes `start`. */
  reach(start: Iterable<string>, blocked: ReadonlySet<string> = new Set()): Set<string> {
    const seen = new Set<string>();
    const queue = [...start].filter((n) => !blocked.has(n));
    while (queue.length > 0) {
      const n = queue.pop() as string;
      if (seen.has(n)) continue;
      seen.add(n);
      for (const c of this.children.get(n) ?? []) if (!blocked.has(c) && !seen.has(c)) queue.push(c);
    }
    return seen;
  }

  /** Main-edge ancestors of `node`, excluding the node itself. */
  ancestors(node: string): Set<string> {
    const seen = new Set<string>();
    const queue = [...this.mainParents(node)];
    while (queue.length > 0) {
      const n = queue.pop() as string;
      if (seen.has(n)) continue;
      seen.add(n);
      queue.push(...this.mainParents(n));
    }
    return seen;
  }
}

function push(map: Map<string, string[]>, key: string, value: string) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
