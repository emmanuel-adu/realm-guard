import type { WorkflowNode } from "./types";

// Node-type knowledge, checked against n8n-nodes-base 2.48 and @n8n/n8n-nodes-langchain 2.48.

const LANGCHAIN = "@n8n/n8n-nodes-langchain.";

export type TriggerKind = "manual" | "scheduled" | "external" | "subworkflow";

const MANUAL = new Set(["n8n-nodes-base.manualTrigger", "n8n-nodes-base.start"]);
const SCHEDULED = new Set(["n8n-nodes-base.scheduleTrigger", "n8n-nodes-base.cron", "n8n-nodes-base.interval"]);
const SUBWORKFLOW_TRIGGERS = new Set(["n8n-nodes-base.executeWorkflowTrigger"]);
const OTHER_TRIGGERS = new Set(["n8n-nodes-base.webhook", "n8n-nodes-base.emailReadImap", "n8n-nodes-base.formTrigger"]);

export function triggerKind(type: string): TriggerKind | undefined {
  if (MANUAL.has(type)) return "manual";
  if (SCHEDULED.has(type)) return "scheduled";
  if (SUBWORKFLOW_TRIGGERS.has(type)) return "subworkflow";
  if (OTHER_TRIGGERS.has(type) || /Trigger$/.test(type)) return "external";
  return undefined;
}

export const isSticky = (type: string) => type === "n8n-nodes-base.stickyNote";

/** Human review nodes for agent tools (n8n 2.6+). Tools wired through one need approval. */
export const isHitlReview = (type: string) => type.endsWith("HitlTool");

// Langchain-package nodes that don't produce model-written output on the main flow:
// model, memory, tool and retrieval sub-nodes, triggers, and the Chat reply node.
const LANGCHAIN_SUBNODE = /^(lmChat|lm[A-Z]|modelSelector|embeddings|memory|tool|vectorStore|outputParser|textSplitter|document|retriever|reranker|mcpClient|chatTrigger|manualChatTrigger|mcpTrigger|chat$|code$)/;

/** Nodes whose output is written by a model. */
export function isAiNode(type: string): boolean {
  if (type === "n8n-nodes-base.openAi") return true;
  if (!type.startsWith(LANGCHAIN)) return false;
  const local = type.slice(LANGCHAIN.length);
  return !LANGCHAIN_SUBNODE.test(local);
}

export const isAgent = (type: string) => type === `${LANGCHAIN}agent` || type === `${LANGCHAIN}agentTool` || type === `${LANGCHAIN}openAiAssistant`;

const EXTERNAL_MEMORY = new Set(["memoryPostgresChat", "memoryRedisChat", "memoryMongoDbChat", "memoryXata", "memoryZep", "memoryMotorhead", "memoryLakebaseChat"]);

export function memoryKind(type: string): "in-workflow" | "external" | undefined {
  if (!type.startsWith(`${LANGCHAIN}memory`)) return undefined;
  const local = type.slice(LANGCHAIN.length);
  if (local === "memoryBufferWindow") return "in-workflow";
  return EXTERNAL_MEMORY.has(local) ? "external" : undefined;
}

export const isSubWorkflowCall = (type: string) => type === "n8n-nodes-base.executeWorkflow" || type === `${LANGCHAIN}toolWorkflow`;

export const isCodeNode = (type: string) => ["n8n-nodes-base.code", "n8n-nodes-base.function", "n8n-nodes-base.functionItem"].includes(type);

export function codeOf(node: WorkflowNode): string {
  const p = node.parameters;
  return [p.jsCode, p.pythonCode, p.functionCode].filter((v): v is string => typeof v === "string").join("\n");
}

/**
 * A step that stops the run until a person responds. n8n carries on to the next node whatever
 * the answer (Disapprove arrives as approved: false), so these only count as approval when a
 * decision node checks the answer before the write. Steps named in the manifest are trusted
 * as complete review steps.
 */
export function approvalKind(node: WorkflowNode, trusted: ReadonlySet<string>): "trusted" | "needs-check" | undefined {
  if (trusted.has(node.name)) return "trusted";
  const p = node.parameters;
  if (p.operation === "sendAndWait") return "needs-check";
  if (node.type === "n8n-nodes-base.wait" && (p.resume === "webhook" || p.resume === "form")) return "needs-check";
  if (/gotohuman/i.test(node.type)) return "needs-check";
  return undefined;
}

export const isDecision = (type: string) => ["n8n-nodes-base.if", "n8n-nodes-base.switch", "n8n-nodes-base.filter"].includes(type);

export const isCommunityNode = (type: string) => !type.startsWith("n8n-nodes-base.") && !type.startsWith("@n8n/");

export const isMcpClient = (type: string) => /\.mcpClient(Tool)?$/.test(type);

/** Words that suggest a node talks to QuickBooks even when Realm Guard can't read how. */
export const MENTIONS_QUICKBOOKS = /quickbooks|intuit|\bqbo\b|quickBooksOAuth2Api/i;
