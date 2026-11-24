// Builds n8n-shaped workflow exports for tests, so each rule test reads as a short story.
type Json = Record<string, unknown>;

interface NodeSpec {
  name: string;
  type: string;
  typeVersion?: number;
  parameters?: Json;
  credentials?: Record<string, unknown>;
  disabled?: boolean;
}

export const T = {
  manual: "n8n-nodes-base.manualTrigger",
  schedule: "n8n-nodes-base.scheduleTrigger",
  webhook: "n8n-nodes-base.webhook",
  chat: "@n8n/n8n-nodes-langchain.chatTrigger",
  qbo: "n8n-nodes-base.quickbooks",
  qboTool: "n8n-nodes-base.quickbooksTool",
  http: "n8n-nodes-base.httpRequest",
  httpTool: "n8n-nodes-base.httpRequestTool",
  set: "n8n-nodes-base.set",
  code: "n8n-nodes-base.code",
  wait: "n8n-nodes-base.wait",
  slack: "n8n-nodes-base.slack",
  slackHitl: "n8n-nodes-base.slackHitlTool",
  agent: "@n8n/n8n-nodes-langchain.agent",
  openAi: "@n8n/n8n-nodes-langchain.openAi",
  lmChat: "@n8n/n8n-nodes-langchain.lmChatOpenAi",
  bufferMemory: "@n8n/n8n-nodes-langchain.memoryBufferWindow",
  postgresMemory: "@n8n/n8n-nodes-langchain.memoryPostgresChat",
  executeWorkflow: "n8n-nodes-base.executeWorkflow",
  sticky: "n8n-nodes-base.stickyNote",
} as const;

export const qboCred = (id: string, name: string) => ({ quickBooksOAuth2Api: { id, name } });

export class WorkflowBuilder {
  private nodes: Json[] = [];
  private connections: Record<string, Record<string, { node: string; type: string; index: number }[][]>> = {};
  private pinData: Record<string, unknown[]> = {};

  constructor(private name = "Test workflow") {}

  node(spec: NodeSpec): this {
    const n: Json = {
      id: `id-${String(this.nodes.length)}`,
      name: spec.name,
      type: spec.type,
      typeVersion: spec.typeVersion ?? 1,
      position: [this.nodes.length * 200, 0],
      parameters: spec.parameters ?? {},
    };
    if (spec.credentials) n.credentials = spec.credentials;
    if (spec.disabled) n.disabled = true;
    this.nodes.push(n);
    return this;
  }

  connect(from: string, to: string, type = "main", output = 0): this {
    const byType = (this.connections[from] ??= {});
    const outputs = (byType[type] ??= []);
    while (outputs.length <= output) outputs.push([]);
    outputs[output]?.push({ node: to, type, index: 0 });
    return this;
  }

  chain(...names: string[]): this {
    for (let i = 0; i < names.length - 1; i++) this.connect(names[i] as string, names[i + 1] as string);
    return this;
  }

  pin(node: string, items: unknown[]): this {
    this.pinData[node] = items;
    return this;
  }

  json(): Json {
    const out: Json = { name: this.name, nodes: this.nodes, connections: this.connections };
    if (Object.keys(this.pinData).length > 0) out.pinData = this.pinData;
    return out;
  }

  text(): string {
    return JSON.stringify(this.json());
  }
}

export const wf = (name?: string) => new WorkflowBuilder(name);

export const manifestYaml = (tenants: { id: string; credentials?: string[]; realmIds?: string[] }[], scope?: string[]) => {
  const lines = ["version: 1"];
  if (scope) lines.push(`scope: [${scope.join(", ")}]`);
  lines.push("tenants:");
  for (const t of tenants) {
    lines.push(`  - id: ${t.id}`, `    name: ${t.id}`);
    lines.push(`    credentials: [${(t.credentials ?? []).map((c) => JSON.stringify(c)).join(", ")}]`);
    lines.push(`    realmIds: [${(t.realmIds ?? []).map((r) => `"${r}"`).join(", ")}]`);
  }
  return lines.join("\n");
};
