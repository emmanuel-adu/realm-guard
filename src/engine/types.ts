export type ParseResult<T> =
  | { ok: true; value: T; warnings: string[] }
  | { ok: false; errors: string[] };

export interface CredentialRef {
  id?: string;
  name?: string;
}

export interface WorkflowNode {
  name: string;
  type: string;
  typeVersion: number;
  parameters: Record<string, unknown>;
  /** Keyed by n8n credential type, e.g. `quickBooksOAuth2Api`. */
  credentials: Record<string, CredentialRef>;
  disabled: boolean;
}

export interface Edge {
  from: string;
  to: string;
  /** `main` for data flow; `ai_tool`, `ai_memory` and friends attach sub-nodes to an agent. */
  type: string;
}

export interface Workflow {
  name: string;
  nodes: WorkflowNode[];
  edges: Edge[];
  pinnedNodes: string[];
}

export interface Tenant {
  id: string;
  name: string;
  realmIds: string[];
  /** Credential IDs or names exactly as n8n shows them. */
  credentials: string[];
}

export interface Manifest {
  scope: string[];
  tenants: Tenant[];
  approvalNodes: string[];
}

export type Severity = "critical" | "high" | "medium" | "low";

export type Category = "credentials" | "client-ids" | "cross-client" | "approvals" | "export";

export interface Finding {
  ruleId: string;
  category: Category;
  severity: Severity;
  title: string;
  /** The node the finding is about first, then any related nodes. */
  nodes: string[];
  detail: string;
  why: string;
  fix: string;
}

export type TouchpointKind = "quickbooks-node" | "quickbooks-tool" | "http" | "http-tool";

export type Approval = "gated" | "ungated" | "manual-only" | "not-a-write";

export interface Touchpoint {
  node: string;
  kind: TouchpointKind;
  operation: string;
  write: boolean;
  credential?: CredentialRef;
  /** How the step authenticates: a stored credential, a token built at run time, or a token pasted in. */
  auth: "credential" | "dynamic-token" | "pasted-token" | "none";
  /** Literal realm ID from the URL, if the node pins one. */
  realmId?: string;
  realmIsExpression: boolean;
  tenants: string[];
  approval: Approval;
}

export type Verdict = "fix" | "not-verified" | "review" | "clear" | "nothing-to-check";

export interface Coverage {
  nodes: number;
  disabledNodes: string[];
  subWorkflows: string[];
  /** Things the scan couldn't check, in plain words. Any gap stops a "clear" verdict. */
  gaps: string[];
}

export interface Report {
  workflowName: string;
  verdict: Verdict;
  findings: Finding[];
  touchpoints: Touchpoint[];
  tenantsTouched: string[];
  /** Display names by tenant id. Without a manifest, ids are credential names or "company <realm>". */
  tenantNames: Record<string, string>;
  scope: string[];
  hasManifest: boolean;
  coverage: Coverage;
}
