import { Graph } from "./graph";
import { type RawTouchpoint, credentialLabel, findTouchpoints } from "./quickbooks";
import type { CredentialRef, Manifest, Workflow } from "./types";

export interface Resolved extends RawTouchpoint {
  credTenants: string[];
  realmTenants: string[];
  tenants: string[];
}

/**
 * Maps credentials and realm IDs to clients. Without a manifest each distinct credential
 * or company ID stands in for a client, so flows between companies still show up.
 */
export class Tenancy {
  readonly names = new Map<string, string>();
  private readonly order: string[] = [];

  constructor(readonly manifest: Manifest | undefined) {
    for (const t of manifest?.tenants ?? []) this.add(t.id, t.name);
  }

  private add(id: string, name: string) {
    if (!this.names.has(id)) {
      this.names.set(id, name);
      this.order.push(id);
    }
  }

  credential(ref: CredentialRef | undefined): string[] {
    if (!ref) return [];
    if (!this.manifest) {
      const label = credentialLabel(ref);
      this.add(label, label);
      return [label];
    }
    const name = ref.name?.trim().toLowerCase();
    return this.manifest.tenants
      .filter((t) => t.credentials.some((c) => (ref.id !== undefined && c === ref.id) || (name !== undefined && c.trim().toLowerCase() === name)))
      .map((t) => t.id);
  }

  realm(id: string): string[] {
    if (!this.manifest) {
      const pseudo = `company ${id}`;
      this.add(pseudo, pseudo);
      return [pseudo];
    }
    return this.manifest.tenants.filter((t) => t.realmIds.includes(id)).map((t) => t.id);
  }

  name(id: string) {
    return this.names.get(id) ?? id;
  }

  list(ids: Iterable<string>) {
    const set = new Set(ids);
    const names = this.order.filter((id) => set.has(id)).map((id) => this.name(id));
    if (names.length <= 2) return names.join(" and ");
    return `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
  }

  sort(ids: Iterable<string>) {
    const set = new Set(ids);
    return this.order.filter((id) => set.has(id));
  }
}

export interface Context {
  workflow: Workflow;
  graph: Graph;
  manifest: Manifest | undefined;
  tenancy: Tenancy;
  scope: Set<string>;
  /** True when this workflow is meant to (or plainly does) touch more than one client. */
  multiClient: boolean;
  touchpoints: Resolved[];
  byNode: Map<string, Resolved>;
}

export function buildContext(workflow: Workflow, manifest: Manifest | undefined): Context {
  const graph = new Graph(workflow);
  const tenancy = new Tenancy(manifest);
  const touchpoints: Resolved[] = findTouchpoints(workflow).map((tp) => {
    const credTenants = tp.auth.kind === "credential" ? tenancy.credential(tp.auth.credential) : [];
    const realmTenants = tp.realm.kind === "literal" ? tenancy.realm(tp.realm.id) : [];
    // Without a manifest a call that pins a realm is identified by that realm, not its credential.
    const tenants = !manifest && realmTenants.length > 0 ? realmTenants : tenancy.sort([...credTenants, ...realmTenants]);
    return { ...tp, credTenants, realmTenants, tenants };
  });

  const touched = new Set(touchpoints.flatMap((t) => t.tenants));
  const dynamicRealm = touchpoints.some((t) => t.realm.kind === "expression" || t.auth.kind === "dynamic-token");
  const scope = new Set(manifest ? manifest.scope : touched);
  const multiClient = manifest ? scope.size >= 2 : touched.size >= 2 || dynamicRealm;

  return {
    workflow,
    graph,
    manifest,
    tenancy,
    scope,
    multiClient,
    touchpoints,
    byNode: new Map(touchpoints.map((t) => [t.node.name, t])),
  };
}
