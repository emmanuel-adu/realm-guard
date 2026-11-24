import copiedManifest from "./copied-invoices.manifest.yaml?raw";
import copiedWorkflow from "./copied-invoices.json?raw";
import reviewedManifest from "./reviewed-bills.manifest.yaml?raw";
import reviewedWorkflow from "./reviewed-bills.json?raw";
import agentManifest from "./shared-ap-agent.manifest.yaml?raw";
import agentWorkflow from "./shared-ap-agent.json?raw";

export interface Sample {
  id: string;
  label: string;
  blurb: string;
  workflowFile: string;
  manifestFile: string;
  workflow: string;
  manifest: string;
}

// Made-up clients and IDs. None of these companies or realm IDs are real.
export const SAMPLES: Sample[] = [
  {
    id: "copied-invoices",
    label: "Copied invoice run",
    blurb: "Duplicated for Harbor Dental, one node still points at Pine Street's books.",
    workflowFile: "monthly-invoices-harbor.json",
    manifestFile: "clients.yaml",
    workflow: copiedWorkflow,
    manifest: copiedManifest,
  },
  {
    id: "shared-ap-agent",
    label: "Shared AP agent",
    blurb: "One AI agent enters bills for every client.",
    workflowFile: "month-end-ap-agent.json",
    manifestFile: "clients.yaml",
    workflow: agentWorkflow,
    manifest: agentManifest,
  },
  {
    id: "reviewed-bills",
    label: "Reviewed bill entry",
    blurb: "AI reads the bill, a bookkeeper approves in Slack.",
    workflowFile: "bill-entry-harbor.json",
    manifestFile: "clients.yaml",
    workflow: reviewedWorkflow,
    manifest: reviewedManifest,
  },
];
