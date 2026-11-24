import type { Category } from "../engine/types";

export const REPO_URL = "https://github.com/emmanuel-adu/realm-guard";

export const INTRO = {
  eyebrow: "n8n + QuickBooks preflight",
  title: "Check a workflow stays inside each client's books",
  lead: "Drop an exported n8n workflow and your client list. Realm Guard flags shared credentials, unpinned company IDs, cross-client state and writes nobody approves.",
  privacy: "Runs in this page. Your files never leave your browser.",
};

export const INPUTS = {
  workflow: {
    label: "Workflow export",
    hint: "In n8n, open the workflow, then ... menu > Download. Copying all nodes works too.",
    drop: "Drop the workflow .json here",
    accept: ".json,application/json",
    pastePlaceholder: "Paste the workflow JSON here",
  },
  manifest: {
    label: "Client manifest",
    optional: "optional",
    hint: "Which n8n credentials and QuickBooks company IDs belong to which client.",
    drop: "Drop a .yaml or .json manifest here",
    accept: ".yaml,.yml,.json,application/json,text/yaml",
    pastePlaceholder: "Paste or write the manifest here",
    draft: "Draft from this workflow",
    without: "No manifest? You'll still get the agent, approval and state checks. Client checks need one.",
  },
};

export const CHECKS: { category: Category; title: string; body: string }[] = [
  {
    category: "credentials",
    title: "Shared credentials",
    body: "A copied workflow still pointing at another client's QuickBooks, one connection serving several clients, or a token built from run data.",
  },
  {
    category: "client-ids",
    title: "Unpinned client IDs",
    body: "Company (realm) IDs that come from data or an AI model instead of your client list.",
  },
  {
    category: "cross-client",
    title: "Cross-client state",
    body: "One client's records flowing into another's books, agents holding several clients' tools, and memory or saved state shared across clients.",
  },
  {
    category: "approvals",
    title: "Writes without approval",
    body: "Creates, updates, sends and voids that reach the books with no person in the loop, including AI agent tools without a review step.",
  },
];

export const LIMITS = [
  "It reads the exported file. It doesn't run the workflow or call QuickBooks.",
  "It checks the QuickBooks node and HTTP Request calls to the QuickBooks API. Xero, Make and Zapier aren't covered yet.",
  "Sub-workflows are listed, not opened. Code, community and MCP nodes that mention QuickBooks are flagged for a manual check.",
  "An approval counts only when an IF, Switch or Filter checks the answer. Realm Guard checks that one is there, not what its condition says.",
];
