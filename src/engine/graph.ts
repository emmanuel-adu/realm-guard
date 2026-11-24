import { referencedNodes, stringLeaves } from "./expressions";
import { isAgent, isHitlReview } from "./nodes";
import type { Workflow, WorkflowNode } from "./types";

export interface AgentTool {
  tool: string;
  reviewedBy?: string;
  /** The nested agent the tool belongs to, when it isn't the agent's own. */
  via?: string;
}

export class Graph {
  readonly byName = new Map<string, WorkflowNode>();
  private readonly children = new Map<string, string[]>();
  private readonly parents = new Map<string, string[]>();
  private readonly toolTargets = new Map<string, string[]>();
  private readonly attached = new Map<string, string[]>();
  private readonly refs = new Map<string, string[]>();

  constructor(workflow: Workflow) {
    const all = new Map(workflow.nodes.map((n) => [n.name, n]));
    for (const n of workflow.nodes) if (!n.disabled) this.byName.set(n.name, n);

    const rawChildren = new Map<string, string[]>();
    for (const e of workflow.edges) {
      if (!all.has(e.from) || !all.has(e.to)) continue;
      if (e.type === "main") {
        push(rawChildren, e.from, e.to);
      } else if (this.byName.has(e.from) && this.byName.has(e.to)) {
        // Sub-node edges point from the sub-node (tool, memory, model) to what uses it.
        // n8n leaves disabled sub-nodes out entirely, so those edges are dropped.
        push(this.attached, e.to, e.from);
        if (e.type === "ai_tool") push(this.toolTargets, e.from, e.to);
      }
    }

    // n8n passes data straight through a disabled node, so bridge each one: an enabled node
    // feeds whatever enabled nodes sit beyond any run of disabled ones.
    const enabledBeyond = (start: string): string[] => {
      const out = new Set<string>();
      const seen = new Set<string>();
      const stack = [...(rawChildren.get(start) ?? [])];
      while (stack.length > 0) {
        const n = stack.pop() as string;
        if (seen.has(n)) continue;
        seen.add(n);
        if (this.byName.has(n)) out.add(n);
        else stack.push(...(rawChildren.get(n) ?? []));
      }
      return [...out];
    };
    for (const from of this.byName.keys()) {
      for (const to of enabledBeyond(from)) {
        push(this.children, from, to);
        push(this.parents, to, from);
      }
    }

    for (const n of this.byName.values()) {
      const names = new Set<string>();
      for (const [, value] of stringLeaves(n.parameters)) for (const r of referencedNodes(value)) if (r !== n.name && this.byName.has(r)) names.add(r);
      if (names.size > 0) this.refs.set(n.name, [...names]);
    }
  }

  node(name: string) {
    return this.byName.get(name);
  }

  mainParents(name: string) {
    return this.parents.get(name) ?? [];
  }

  mainChildren(name: string) {
    return this.children.get(name) ?? [];
  }

  hasMainEdges(name: string) {
    return this.parents.has(name) || this.children.has(name);
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
    return this.walkBack(node, (n) => this.mainParents(n));
  }

  /**
   * Every node whose output can end up in `node`: main-edge ancestors plus nodes named in
   * expressions such as $('Read A'), followed transitively.
   */
  dataSources(node: string): Set<string> {
    return this.walkBack(node, (n) => [...this.mainParents(n), ...(this.refs.get(n) ?? [])]);
  }

  private walkBack(node: string, next: (n: string) => string[]): Set<string> {
    const seen = new Set<string>();
    const queue = [...next(node)];
    while (queue.length > 0) {
      const n = queue.pop() as string;
      if (seen.has(n) || n === node) continue;
      seen.add(n);
      queue.push(...next(n));
    }
    return seen;
  }
}

function push(map: Map<string, string[]>, key: string, value: string) {
  const list = map.get(key);
  if (!list) map.set(key, [value]);
  else if (!list.includes(value)) list.push(value);
}
