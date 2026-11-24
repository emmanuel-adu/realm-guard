import type { Approval, Category, Severity, Touchpoint, Verdict } from "../engine/types";

export const VERDICTS: Record<Verdict, { label: string; summary: string }> = {
  fix: {
    label: "Fix before running",
    summary: "This workflow can touch the wrong client's books or post without anyone checking.",
  },
  "not-verified": {
    label: "Not verified",
    summary: "Nothing failed, but parts of the workflow couldn't be checked. See what the scan couldn't see.",
  },
  review: {
    label: "Review before running",
    summary: "No boundary breaks, but a few things deserve a second look.",
  },
  clear: {
    label: "No boundary issues found",
    summary: "Every QuickBooks step stays inside this workflow's clients, and every write waits for a person.",
  },
  "nothing-to-check": {
    label: "Nothing to check",
    summary: "This workflow has no QuickBooks steps that Realm Guard recognizes.",
  },
};

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const CATEGORY_LABEL: Record<Category, string> = {
  credentials: "Shared credentials",
  "client-ids": "Unpinned client IDs",
  "cross-client": "Cross-client state",
  approvals: "Writes without approval",
  export: "Export hygiene",
};

export const APPROVAL_LABEL: Record<Approval, string> = {
  gated: "Waits for a person",
  unchecked: "Approval not checked",
  ungated: "No approval",
  "manual-only": "Manual run only",
  "not-a-write": "Read only",
};

export const AUTH_LABEL: Record<Touchpoint["auth"], string> = {
  credential: "stored credential",
  "dynamic-token": "token built at run time",
  "pasted-token": "token pasted in node",
  none: "none in export",
};
