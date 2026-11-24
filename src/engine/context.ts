import { Graph } from "./graph";
import { type RawTouchpoint, credentialLabel, findTouchpoints } from "./quickbooks";
import type { CredentialRef, Manifest, Workflow } from "./types";

export interface Resolved extends RawTouchpoint {
  credTenants: string[];
  realmTenants: string[];
  tenants: string[];
}

/** Identifies a credential by id when the export has one, so two "QuickBooks Online account"s stay apart. */
export const credentialKey = (ref: CredentialRef) => (ref.id ? `id:${ref.id}` : `name:${ref.name ?? ""}`);

/**
 * Maps credentials and realm IDs to clients. Without a manifest each credential or company ID
 * stands in for a client, and a credential used with exactly one company ID joins that
 * company's client, so flows between companies still show up without inventing ones that
 * aren't there. A credential seen with two company IDs never merges them: the company ID is
 * the client, and Intuit tokens are issued per company.
 */
export class Tenancy {
  readonly names = new Map<string, string>();
  private readonly order: string[] = [];
  private readonly parent = new Map<string, string>();
  /** Every name a credential id goes by in this export. Some references drop the name. */
  private readonly aliases = new Map<string, Set<string>>();

  constructor(readonly manifest: Manifest | undefined) {
    for (const t of manifest?.tenants ?? []) this.add(t.id, t.name);
  }

  alias(ref: CredentialRef) {
    if (!ref.id || !ref.name) return;
    const set = this.aliases.get(ref.id) ?? new Set<string>();
    set.add(ref.name.trim().toLowerCase());
    this.aliases.set(ref.id, set);
  }

  private add(id: string, name: string) {
    if (!this.names.has(id)) {
      this.names.set(id, name);
      this.order.push(id);
    }
  }

  private root(id: string): string {
    let r = id;
    while (this.parent.has(r)) r = this.parent.get(r) as string;
    return r;
  }

  private pseudoCredential(ref: CredentialRef) {
    const id = `credential ${credentialKey(ref)}`;
    this.add(id, credentialLabel(ref));
    return id;
  }

  private pseudoRealm(realm: string) {
    const id = `company ${realm}`;
    this.add(id, id);
    return id;
  }

  /** Without a manifest: treat this credential and company ID as one client. */
  link(ref: CredentialRef, realm: string) {
    if (this.manifest) return;
    const a = this.root(this.pseudoCredential(ref));
    const b = this.root(this.pseudoRealm(realm));
    if (a !== b) this.parent.set(b, a);
  }

  credential(ref: CredentialRef | undefined): string[] {
    if (!ref) return [];
    if (!this.manifest) return [this.root(this.pseudoCredential(ref))];
    const names = new Set(ref.id ? this.aliases.get(ref.id) : undefined);
    if (ref.name) names.add(ref.name.trim().toLowerCase());
    return this.manifest.tenants
      .filter((t) => t.credentials.some((c) => (ref.id !== undefined && c === ref.id) || names.has(c.trim().toLowerCase())))
      .map((t) => t.id);
  }

  realm(id: string): string[] {
    if (!this.manifest) return [this.root(this.pseudoRealm(id))];
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
  /** Names of credentials whose id appears under more than one name in the file. */
  credentialNameConflicts: string[][];
}

export function buildContext(workflow: Workflow, manifest: Manifest | undefined): Context {
  const graph = new Graph(workflow);
  const tenancy = new Tenancy(manifest);
  const raw = findTouchpoints(workflow);
  const credOf = (tp: RawTouchpoint) => (tp.auth.kind === "credential" ? tp.auth.credential : undefined);

  // Resolve each credential id's name once, from every node in the file (disabled ones too,
  // since a credential's name doesn't depend on where it's used), so a reference without the
  // name gets the same owner and label as one with it, whichever comes first.
  const nameById = new Map<string, string>();
  const namesById = new Map<string, Map<string, string>>();
  for (const node of workflow.nodes) {
    for (const c of Object.values(node.credentials)) {
      tenancy.alias(c);
      if (!c.id || !c.name) continue;
      if (!nameById.has(c.id)) nameById.set(c.id, c.name);
      const names = namesById.get(c.id) ?? new Map<string, string>();
      if (!names.has(c.name.trim().toLowerCase())) names.set(c.name.trim().toLowerCase(), c.name);
      namesById.set(c.id, names);
    }
  }
  // One id under two names means the nodes were saved at different times, and the manifest
  // can't tell which name is current. That's a gap, not something to guess.
  const usedIds = new Set(raw.flatMap((tp) => credOf(tp)?.id ?? []));
  const credentialNameConflicts = [...namesById].filter(([id, names]) => usedIds.has(id) && names.size > 1).map(([, names]) => [...names.values()]);
  for (const tp of raw) {
    const c = credOf(tp);
    const name = c?.id ? nameById.get(c.id) : undefined;
    if (tp.auth.kind === "credential" && c && !c.name && name) tp.auth = { ...tp.auth, credential: { ...c, name } };
  }

  const realmsByCredential = new Map<string, { ref: CredentialRef; realms: Set<string> }>();
  for (const tp of raw) {
    const c = credOf(tp);
    if (!c || tp.realm.kind !== "literal") continue;
    const entry = realmsByCredential.get(credentialKey(c)) ?? { ref: c, realms: new Set<string>() };
    entry.realms.add(tp.realm.id);
    realmsByCredential.set(credentialKey(c), entry);
  }
  for (const { ref, realms } of realmsByCredential.values()) {
    const [only] = realms;
    if (realms.size === 1 && only !== undefined) tenancy.link(ref, only);
  }
  // Without a manifest, a credential used with several company IDs says nothing about which
  // one a call reaches; the company ID in that call's URL does.
  const ambiguous = (c: CredentialRef | undefined) => !manifest && c !== undefined && (realmsByCredential.get(credentialKey(c))?.realms.size ?? 0) > 1;

  const touchpoints: Resolved[] = raw.map((tp) => {
    const c = credOf(tp);
    const credTenants = tp.auth.kind === "credential" && !(ambiguous(c) && tp.realm.kind === "literal") ? tenancy.credential(c) : [];
    const realmTenants = tp.realm.kind === "literal" ? tenancy.realm(tp.realm.id) : [];
    return { ...tp, credTenants, realmTenants, tenants: tenancy.sort([...credTenants, ...realmTenants]) };
  });

  const touched = new Set(touchpoints.flatMap((t) => t.tenants));
  const dynamicRealm = touchpoints.some((t) => t.realm.kind === "expression" || t.auth.kind === "dynamic-token");
  const scope = new Set(manifest ? manifest.scope : touched);
  // Scope says what's allowed; the steps say what happens. Two clients either way is multi-client.
  const multiClient = manifest ? scope.size >= 2 || touched.size >= 2 : touched.size >= 2 || dynamicRealm;

  return {
    workflow,
    graph,
    manifest,
    tenancy,
    scope,
    multiClient,
    touchpoints,
    byNode: new Map(touchpoints.map((t) => [t.node.name, t])),
    credentialNameConflicts,
  };
}
