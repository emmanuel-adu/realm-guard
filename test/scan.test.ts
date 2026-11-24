import { describe, expect, it } from "vitest";
import { parseManifest } from "../src/engine/manifest";
import { scan } from "../src/engine/scan";
import type { Finding, Report } from "../src/engine/types";
import { parseWorkflow } from "../src/engine/workflow";
import { T, type WorkflowBuilder, manifestYaml, qboCred, wf } from "./helpers";

const HARBOR = { id: "harbor", credentials: ["QBO - Harbor"], realmIds: ["9130354772541234"] };
const PINE = { id: "pine", credentials: ["QBO - Pine"], realmIds: ["4620816365181712"] };
const harborCred = qboCred("11", "QBO - Harbor");
const pineCred = qboCred("12", "QBO - Pine");
const qboUrl = (realm: string, path = "invoice") => `https://quickbooks.api.intuit.com/v3/company/${realm}/${path}`;

function run(b: WorkflowBuilder, manifest?: string): Report {
  const w = parseWorkflow(b.text());
  if (!w.ok) throw new Error(w.errors.join("; "));
  if (manifest === undefined) return scan(w.value);
  const m = parseManifest(manifest);
  if (!m.ok) throw new Error(m.errors.join("; "));
  return scan(w.value, m.value);
}

const ids = (r: Report) => r.findings.map((f) => f.ruleId);
const find = (r: Report, ruleId: string): Finding => {
  const f = r.findings.find((x) => x.ruleId === ruleId);
  if (!f) throw new Error(`no ${ruleId} in ${ids(r).join(", ") || "(none)"}`);
  return f;
};

const both = manifestYaml([HARBOR, PINE]);
const harborOnly = manifestYaml([HARBOR, PINE], ["harbor"]);

describe("touchpoints", () => {
  it("finds the QuickBooks node with its client, operation and write flag", () => {
    const r = run(wf().node({ name: "Make invoice", type: T.qbo, parameters: { resource: "invoice", operation: "create" }, credentials: harborCred }), harborOnly);
    expect(r.touchpoints).toEqual([
      expect.objectContaining({ node: "Make invoice", operation: "invoice: create", write: true, tenants: ["harbor"] }),
    ]);
  });

  it("uses n8n's defaults when the export omits resource and operation", () => {
    const r = run(wf().node({ name: "Q", type: T.qbo, credentials: harborCred }), harborOnly);
    expect(r.touchpoints[0]).toMatchObject({ operation: "customer: get", write: false });
  });

  it("treats a POST to the QBO query endpoint as a read", () => {
    const r = run(wf().node({ name: "Q", type: T.http, parameters: { method: "POST", url: qboUrl("9130354772541234", "query") } }), harborOnly);
    expect(r.touchpoints[0]).toMatchObject({ kind: "http", write: false, tenants: ["harbor"] });
  });

  it("treats a POST to an entity endpoint as a write", () => {
    const r = run(wf().node({ name: "Q", type: T.http, parameters: { method: "POST", url: qboUrl("9130354772541234") } }), harborOnly);
    expect(r.touchpoints[0]?.write).toBe(true);
  });

  it("catches an HTTP call that carries a QuickBooks credential even when the URL is hidden in an env variable", () => {
    const r = run(
      wf().node({
        name: "POST Sales Receipt",
        type: T.http,
        typeVersion: 4.2,
        parameters: { url: "{{ $env.API_BASE_URL }}", method: "POST", authentication: "{{ $credentials.predefinedCredentialType }}" },
        credentials: { httpCustomAuth: { id: "1", name: "Custom Auth account" }, ...harborCred },
      }),
      harborOnly,
    );
    expect(r.touchpoints[0]).toMatchObject({ node: "POST Sales Receipt", kind: "http", write: true, tenants: ["harbor"] });
    expect(r.coverage.gaps.join(" ")).toMatch(/POST Sales Receipt: couldn't read the company ID/);
  });

  it("skips disabled nodes and says so", () => {
    const r = run(wf().node({ name: "Off", type: T.qbo, credentials: pineCred, disabled: true }), harborOnly);
    expect(r.touchpoints).toEqual([]);
    expect(r.coverage.disabledNodes).toEqual(["Off"]);
  });

  it("returns the nothing-to-check verdict when no QuickBooks step exists", () => {
    const r = run(wf().node({ name: "Start", type: T.manual }), harborOnly);
    expect(r.verdict).toBe("nothing-to-check");
  });
});

describe("credentials", () => {
  it("RG100: without a manifest, client checks are a coverage gap", () => {
    const r = run(wf().node({ name: "Q", type: T.qbo, credentials: harborCred }));
    expect(r.coverage.gaps.join(" ")).toMatch(/manifest/i);
    expect(r.verdict).toBe("not-verified");
  });

  it("RG101: flags a credential the manifest doesn't know", () => {
    const r = run(wf().node({ name: "Q", type: T.qbo, credentials: qboCred("99", "QBO - Oak") }), both);
    expect(find(r, "RG101")).toMatchObject({ severity: "high", nodes: ["Q"] });
  });

  it("RG101: matches credentials by id as well as by name", () => {
    const r = run(wf().node({ name: "Q", type: T.qbo, credentials: qboCred("11", "renamed") }), manifestYaml([{ id: "harbor", credentials: ["11"] }]));
    expect(ids(r)).not.toContain("RG101");
  });

  it("RG102: flags the copied-workflow mistake, another client's credential", () => {
    const r = run(wf().node({ name: "Create invoice", type: T.qbo, parameters: { resource: "invoice", operation: "create" }, credentials: pineCred }), harborOnly);
    const f = find(r, "RG102");
    expect(f.severity).toBe("critical");
    expect(f.detail).toMatch(/pine/);
    expect(r.verdict).toBe("fix");
  });

  it("RG103: a QuickBooks step with no credential in the export is a gap, not a pass", () => {
    const r = run(wf().node({ name: "Q", type: T.qbo }), harborOnly);
    expect(find(r, "RG103").nodes).toEqual(["Q"]);
    expect(r.verdict).toBe("not-verified");
  });

  it("RG104: flags a credential mapped to two clients", () => {
    const m = manifestYaml([{ id: "harbor", credentials: ["shared"] }, { id: "pine", credentials: ["shared"] }]);
    const r = run(wf().node({ name: "Q", type: T.qbo, credentials: qboCred("5", "shared") }), m);
    expect(find(r, "RG104").severity).toBe("high");
  });

  it("RG104: flags one credential used against several realm IDs", () => {
    const cred = { oAuth2Api: { id: "8", name: "Intuit app" } };
    const params = (realm: string) => ({ url: qboUrl(realm, "query"), authentication: "genericCredentialType", genericAuthType: "oAuth2Api" });
    const r = run(
      wf().node({ name: "A", type: T.http, parameters: params("9130354772541234"), credentials: cred }).node({ name: "B", type: T.http, parameters: params("4620816365181712"), credentials: cred }),
      manifestYaml([{ ...HARBOR, credentials: ["Intuit app"] }, PINE]),
    );
    expect(find(r, "RG104").nodes.sort()).toEqual(["A", "B"]);
  });

  it("RG105: flags a bearer token built from workflow data", () => {
    const r = run(
      wf().node({
        name: "Post bill",
        type: T.http,
        parameters: { method: "POST", url: qboUrl("9130354772541234", "bill"), sendHeaders: true, headerParameters: { parameters: [{ name: "Authorization", value: "=Bearer {{ $json.access_token }}" }] } },
      }),
      harborOnly,
    );
    expect(find(r, "RG105").severity).toBe("high");
  });

  it("RG105: reports the touchpoint's auth as a runtime token, not a missing credential", () => {
    const r = run(
      wf().node({ name: "Post bill", type: T.http, parameters: { method: "POST", url: qboUrl("9130354772541234", "bill"), headerParameters: { parameters: [{ name: "Authorization", value: "=Bearer {{ $json.access_token }}" }] } } }),
      harborOnly,
    );
    expect(r.touchpoints[0]?.auth).toBe("dynamic-token");
    expect(find(r, "RG105").detail).toContain("`Bearer {{ $json.access_token }}`");
  });

  it("RG105: lowers to medium when token and realm come from the same lookup node", () => {
    const r = run(
      wf()
        .node({ name: "Tenant lookup", type: T.http, parameters: { url: "https://vault.example.com/tenant" } })
        .node({
          name: "Post bill",
          type: T.http,
          parameters: {
            method: "POST",
            url: "=https://quickbooks.api.intuit.com/v3/company/{{ $('Tenant lookup').item.json.realmId }}/bill",
            headerParameters: { parameters: [{ name: "Authorization", value: "=Bearer {{ $('Tenant lookup').item.json.token }}" }] },
          },
        })
        .chain("Tenant lookup", "Post bill"),
      both,
    );
    expect(find(r, "RG105").severity).toBe("medium");
  });

  it("RG106: flags a token pasted into the node", () => {
    const r = run(
      wf().node({ name: "Q", type: T.http, parameters: { url: qboUrl("9130354772541234", "query"), headerParameters: { parameters: [{ name: "Authorization", value: "Bearer eyJhbGciOiJSUzI1NiJ9.abc" }] } } }),
      harborOnly,
    );
    expect(find(r, "RG106").severity).toBe("high");
  });
});

describe("client IDs", () => {
  it("RG201: flags a realm ID taken from an expression", () => {
    const r = run(wf().node({ name: "Q", type: T.http, parameters: { url: "=https://quickbooks.api.intuit.com/v3/company/{{ $json.realmId }}/query" } }), both);
    expect(find(r, "RG201").severity).toBe("high");
  });

  it("RG201: critical when the AI model picks the realm ID", () => {
    const r = run(
      wf()
        .node({ name: "QBO call", type: T.httpTool, parameters: { url: "=https://quickbooks.api.intuit.com/v3/company/{{ $fromAI('realm') }}/query" } })
        .node({ name: "Agent", type: T.agent })
        .connect("QBO call", "Agent", "ai_tool"),
      both,
    );
    expect(find(r, "RG201").severity).toBe("critical");
  });

  it("RG201: critical when the realm comes straight from an AI node's output", () => {
    const r = run(
      wf()
        .node({ name: "Classify", type: T.openAi })
        .node({ name: "Q", type: T.http, parameters: { url: "=https://quickbooks.api.intuit.com/v3/company/{{ $json.realmId }}/query" } })
        .chain("Classify", "Q"),
      both,
    );
    expect(find(r, "RG201").severity).toBe("critical");
  });

  it("RG202: flags a pinned realm that belongs to an out-of-scope client", () => {
    const r = run(wf().node({ name: "Q", type: T.http, parameters: { url: qboUrl("4620816365181712", "query") } }), harborOnly);
    expect(find(r, "RG202").severity).toBe("critical");
  });

  it("RG203: flags a pinned realm the manifest doesn't know", () => {
    const r = run(wf().node({ name: "Q", type: T.http, parameters: { url: qboUrl("1111", "query") } }), both);
    expect(find(r, "RG203").severity).toBe("high");
  });

  it("RG204: flags a realm and credential that belong to different clients", () => {
    const r = run(
      wf().node({
        name: "Q",
        type: T.http,
        parameters: { url: qboUrl("4620816365181712", "query"), authentication: "predefinedCredentialType", nodeCredentialType: "quickBooksOAuth2Api" },
        credentials: harborCred,
      }),
      both,
    );
    expect(find(r, "RG204").severity).toBe("high");
  });
});

describe("cross-client state", () => {
  it("RG301: flags data read from one client flowing into a write for another", () => {
    const r = run(
      wf()
        .node({ name: "Start", type: T.manual })
        .node({ name: "Harbor invoices", type: T.qbo, parameters: { resource: "invoice", operation: "getAll" }, credentials: harborCred })
        .node({ name: "Map", type: T.set })
        .node({ name: "Pine invoice", type: T.qbo, parameters: { resource: "invoice", operation: "create" }, credentials: pineCred })
        .chain("Start", "Harbor invoices", "Map", "Pine invoice"),
      both,
    );
    const f = find(r, "RG301");
    expect(f.severity).toBe("critical");
    expect(f.nodes).toEqual(["Pine invoice", "Harbor invoices"]);
  });

  it("RG301: says 'sends' for a send operation", () => {
    const r = run(
      wf()
        .node({ name: "Pine invoices", type: T.qbo, parameters: { resource: "invoice", operation: "getAll" }, credentials: pineCred })
        .node({ name: "Email invoice", type: T.qbo, parameters: { resource: "invoice", operation: "send" }, credentials: harborCred })
        .chain("Pine invoices", "Email invoice"),
      both,
    );
    expect(find(r, "RG301").detail).toMatch(/^"Email invoice" sends from harbor's books/);
  });

  it("RG301: stays quiet when the read and the write belong to the same client", () => {
    const r = run(
      wf()
        .node({ name: "Get", type: T.qbo, parameters: { resource: "invoice", operation: "getAll" }, credentials: harborCred })
        .node({ name: "Make", type: T.qbo, parameters: { resource: "invoice", operation: "create" }, credentials: harborCred })
        .chain("Get", "Make"),
      both,
    );
    expect(ids(r)).not.toContain("RG301");
  });

  it("RG302: flags one agent holding tools for two clients", () => {
    const r = run(
      wf()
        .node({ name: "Agent", type: T.agent })
        .node({ name: "Harbor lookup", type: T.qboTool, parameters: { resource: "invoice", operation: "getAll" }, credentials: harborCred })
        .node({ name: "Pine lookup", type: T.qboTool, parameters: { resource: "invoice", operation: "getAll" }, credentials: pineCred })
        .connect("Harbor lookup", "Agent", "ai_tool")
        .connect("Pine lookup", "Agent", "ai_tool"),
      both,
    );
    expect(find(r, "RG302")).toMatchObject({ severity: "high", nodes: ["Agent", "Harbor lookup", "Pine lookup"] });
  });

  it("RG302: critical when one of those tools writes", () => {
    const r = run(
      wf()
        .node({ name: "Agent", type: T.agent })
        .node({ name: "Harbor lookup", type: T.qboTool, parameters: { resource: "invoice", operation: "getAll" }, credentials: harborCred })
        .node({ name: "Pine bill", type: T.qboTool, parameters: { resource: "bill", operation: "create" }, credentials: pineCred })
        .node({ name: "Review", type: T.slackHitl })
        .connect("Harbor lookup", "Agent", "ai_tool")
        .connect("Pine bill", "Review", "ai_tool")
        .connect("Review", "Agent", "ai_tool"),
      both,
    );
    expect(find(r, "RG302").severity).toBe("critical");
  });

  it("RG303: flags a fixed memory key in a multi-client workflow", () => {
    const r = run(
      wf()
        .node({ name: "Agent", type: T.agent })
        .node({ name: "Memory", type: T.postgresMemory, typeVersion: 1.3, parameters: { sessionIdType: "customKey", sessionKey: "bookkeeping-agent" } })
        .connect("Memory", "Agent", "ai_memory"),
      both,
    );
    expect(find(r, "RG303").severity).toBe("high");
  });

  it("RG303: medium for an external store in a single-client workflow", () => {
    const r = run(
      wf()
        .node({ name: "Q", type: T.qbo, credentials: harborCred })
        .node({ name: "Memory", type: T.postgresMemory, typeVersion: 1.3, parameters: { sessionIdType: "customKey", sessionKey: "bookkeeping-agent" } }),
      harborOnly,
    );
    expect(find(r, "RG303").severity).toBe("medium");
  });

  it("RG303: knows the old buffer memory's fixed default key", () => {
    const r = run(wf().node({ name: "Memory", type: T.bufferMemory, typeVersion: 1 }), both);
    expect(find(r, "RG303").detail).toMatch(/chat_history/);
  });

  it("RG303: trusts a key taken from the chat session", () => {
    const r = run(wf().node({ name: "Memory", type: T.postgresMemory, typeVersion: 1.3 }), both);
    expect(ids(r)).not.toContain("RG303");
  });

  it("RG304: flags workflow static data in a multi-client workflow", () => {
    const r = run(wf().node({ name: "Cache", type: T.code, parameters: { jsCode: "const s = $getWorkflowStaticData('global'); s.last = $json;" } }), both);
    expect(find(r, "RG304").severity).toBe("high");
  });

  it("RG304: ignores static data in a single-client workflow", () => {
    const r = run(wf().node({ name: "Cache", type: T.code, parameters: { jsCode: "$getWorkflowStaticData('global')" } }), harborOnly);
    expect(ids(r)).not.toContain("RG304");
  });
});

describe("approvals", () => {
  const create = { resource: "invoice", operation: "create" };

  it("RG401: flags a scheduled write with no approval step", () => {
    const r = run(wf().node({ name: "Nightly", type: T.schedule }).node({ name: "Make", type: T.qbo, parameters: create, credentials: harborCred }).chain("Nightly", "Make"), harborOnly);
    expect(find(r, "RG401")).toMatchObject({ severity: "high", detail: expect.stringContaining('"Nightly" (schedule)') as unknown });
  });

  it("RG401: critical when an AI step decides what gets written", () => {
    const r = run(
      wf()
        .node({ name: "Hook", type: T.webhook })
        .node({ name: "Extract", type: T.openAi })
        .node({ name: "Make", type: T.qbo, parameters: create, credentials: harborCred })
        .chain("Hook", "Extract", "Make"),
      harborOnly,
    );
    expect(find(r, "RG401").severity).toBe("critical");
  });

  it("RG401: medium when only a manual run reaches the write", () => {
    const r = run(wf().node({ name: "Start", type: T.manual }).node({ name: "Make", type: T.qbo, parameters: create, credentials: harborCred }).chain("Start", "Make"), harborOnly);
    expect(find(r, "RG401").severity).toBe("medium");
  });

  it("RG401: passes when every path waits for a person in Slack", () => {
    const r = run(
      wf()
        .node({ name: "Nightly", type: T.schedule })
        .node({ name: "Ask", type: T.slack, parameters: { operation: "sendAndWait" } })
        .node({ name: "Make", type: T.qbo, parameters: create, credentials: harborCred })
        .chain("Nightly", "Ask", "Make"),
      harborOnly,
    );
    expect(ids(r)).not.toContain("RG401");
  });

  it("RG401: still flags the write when one branch skips the approval", () => {
    const r = run(
      wf()
        .node({ name: "Nightly", type: T.schedule })
        .node({ name: "Ask", type: T.wait, parameters: { resume: "webhook" } })
        .node({ name: "Make", type: T.qbo, parameters: create, credentials: harborCred })
        .chain("Nightly", "Ask", "Make")
        .connect("Nightly", "Make"),
      harborOnly,
    );
    expect(ids(r)).toContain("RG401");
  });

  it("RG401: counts nodes the manifest names as approval steps", () => {
    const m = `${harborOnly}\napprovalNodes: ["Airtable approval queue"]`;
    const r = run(
      wf()
        .node({ name: "Nightly", type: T.schedule })
        .node({ name: "Airtable approval queue", type: "n8n-nodes-base.airtable" })
        .node({ name: "Make", type: T.qbo, parameters: create, credentials: harborCred })
        .chain("Nightly", "Airtable approval queue", "Make"),
      m,
    );
    expect(ids(r)).not.toContain("RG401");
  });

  it("RG402: flags an agent write tool wired straight to the agent", () => {
    const r = run(
      wf()
        .node({ name: "Agent", type: T.agent })
        .node({ name: "Create bill", type: T.qboTool, parameters: { resource: "bill", operation: "create" }, credentials: harborCred })
        .connect("Create bill", "Agent", "ai_tool"),
      harborOnly,
    );
    expect(find(r, "RG402").severity).toBe("critical");
  });

  it("RG402: passes a write tool behind a human review step", () => {
    const r = run(
      wf()
        .node({ name: "Agent", type: T.agent })
        .node({ name: "Review", type: T.slackHitl })
        .node({ name: "Create bill", type: T.qboTool, parameters: { resource: "bill", operation: "create" }, credentials: harborCred })
        .connect("Create bill", "Review", "ai_tool")
        .connect("Review", "Agent", "ai_tool"),
      harborOnly,
    );
    expect(ids(r)).not.toContain("RG402");
  });
});

describe("export hygiene and coverage", () => {
  it("RG501: warns that pinned data may hold client records", () => {
    const r = run(wf().node({ name: "Q", type: T.qbo, credentials: harborCred }).pin("Q", [{ Id: "1" }]), harborOnly);
    expect(find(r, "RG501").severity).toBe("low");
  });

  it("lists sub-workflows it can't see into as a gap", () => {
    const r = run(wf().node({ name: "Q", type: T.qbo, credentials: harborCred }).node({ name: "Post entries", type: T.executeWorkflow }), harborOnly);
    expect(r.coverage.gaps.join(" ")).toMatch(/Post entries/);
    expect(r.verdict).toBe("not-verified");
  });

  it("calls a clean, fully covered workflow clear", () => {
    const r = run(wf().node({ name: "Nightly", type: T.schedule }).node({ name: "Q", type: T.qbo, credentials: harborCred }).chain("Nightly", "Q"), harborOnly);
    expect(r.findings).toEqual([]);
    expect(r.verdict).toBe("clear");
  });

  it("orders findings by severity", () => {
    const r = run(
      wf()
        .node({ name: "Nightly", type: T.schedule })
        .node({ name: "Make", type: T.qbo, parameters: { resource: "invoice", operation: "create" }, credentials: pineCred })
        .chain("Nightly", "Make")
        .pin("Make", [{}]),
      harborOnly,
    );
    const order = ["critical", "high", "medium", "low"];
    const sev = r.findings.map((f) => order.indexOf(f.severity));
    expect(sev).toEqual([...sev].sort((a, b) => a - b));
  });
});
