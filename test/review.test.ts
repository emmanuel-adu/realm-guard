// Regression tests for the fresh-eyes review of v1 (see DECISIONS.md). Each one reproduced
// a wrong verdict or a crash on the first build.
import { describe, expect, it } from "vitest";
import { scanText } from "../src/engine";
import { draftManifest, parseManifest } from "../src/engine/manifest";
import { parseWorkflow } from "../src/engine/workflow";
import { reportToMarkdown } from "../src/engine/markdown";
import type { Report } from "../src/engine/types";
import { T, type WorkflowBuilder, manifestYaml, qboCred, wf } from "./helpers";

const A = { id: "a", credentials: ["QBO A"], realmIds: ["111"] };
const B = { id: "b", credentials: ["QBO B"], realmIds: ["222"] };
const both = manifestYaml([A, B]);
const onlyA = manifestYaml([A, B], ["a"]);
const credA = qboCred("ca", "QBO A");
const credB = qboCred("cb", "QBO B");
const create = { resource: "invoice", operation: "create" };
const read = { resource: "invoice", operation: "getAll" };
const slackApproval = { operation: "sendAndWait", message: "Post it?" };
const approvedCheck = { conditions: { conditions: [{ leftValue: "={{ $json.data.approved }}", operator: { type: "boolean", operation: "true" } }] } };

function report(b: WorkflowBuilder, manifest = ""): Report {
  const r = scanText(b.text(), manifest);
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join("; "));
  return r.report;
}
const ids = (r: Report) => r.findings.map((f) => f.ruleId);

/** Schedule -> ... -> Approve -> Approved? -> write, so only the rule under test fires. */
const approvedPath = (b: WorkflowBuilder, from: string, write: string) =>
  b
    .node({ name: "Approve", type: T.slack, typeVersion: 2.3, parameters: slackApproval })
    .node({ name: "Approved?", type: "n8n-nodes-base.if", typeVersion: 2.2, parameters: approvedCheck })
    .chain(from, "Approve", "Approved?", write);

describe("cross-client flows the first build missed", () => {
  it("follows data through a disabled node, which n8n passes straight through", () => {
    const b = wf()
      .node({ name: "Daily", type: T.schedule })
      .node({ name: "Read A", type: T.qbo, parameters: read, credentials: credA })
      .node({ name: "Tidy", type: T.set, disabled: true })
      .node({ name: "Create B", type: T.qbo, parameters: create, credentials: credB })
      .chain("Daily", "Read A", "Tidy");
    approvedPath(b, "Tidy", "Create B");
    expect(ids(report(b, both))).toContain("RG301");
  });

  it("treats a write behind a disabled node as reachable from its trigger", () => {
    const b = wf()
      .node({ name: "Daily", type: T.schedule })
      .node({ name: "Tidy", type: T.set, disabled: true })
      .node({ name: "Create A", type: T.qbo, parameters: create, credentials: credA })
      .chain("Daily", "Tidy", "Create A");
    expect(report(b, onlyA).findings.find((f) => f.ruleId === "RG401")?.severity).toBe("high");
  });

  it("follows $('Node') references from a sibling branch", () => {
    const b = wf()
      .node({ name: "Daily", type: T.schedule })
      .node({ name: "Read A", type: T.qbo, parameters: read, credentials: credA })
      .node({ name: "Create B", type: T.qbo, parameters: { ...create, CustomerRef: "={{ $('Read A').first().json.Id }}" }, credentials: credB })
      .connect("Daily", "Read A");
    approvedPath(b, "Daily", "Create B");
    const f = report(b, both).findings.find((x) => x.ruleId === "RG301");
    expect(f?.nodes).toEqual(["Create B", "Read A"]);
  });

  it("follows a reference made by an upstream helper node", () => {
    const b = wf()
      .node({ name: "Daily", type: T.schedule })
      .node({ name: "Read A", type: T.qbo, parameters: read, credentials: credA })
      .node({ name: "Shape", type: T.set, parameters: { value: "={{ $node[\"Read A\"].json.Id }}" } })
      .node({ name: "Create B", type: T.qbo, parameters: create, credentials: credB })
      .connect("Daily", "Read A")
      .connect("Daily", "Shape");
    approvedPath(b, "Shape", "Create B");
    expect(ids(report(b, both))).toContain("RG301");
  });

  it("counts tools of a nested agent toward its parent agent", () => {
    const b = wf()
      .node({ name: "Chat", type: T.chat })
      .node({ name: "AP agent", type: T.agent })
      .node({ name: "Research agent", type: "@n8n/n8n-nodes-langchain.agentTool" })
      .node({ name: "A invoices", type: T.qboTool, parameters: read, credentials: credA })
      .node({ name: "Review", type: T.slackHitl })
      .node({ name: "B bill", type: T.qboTool, parameters: { resource: "bill", operation: "create" }, credentials: credB })
      .connect("Chat", "AP agent")
      .connect("Research agent", "AP agent", "ai_tool")
      .connect("A invoices", "Research agent", "ai_tool")
      .connect("B bill", "Review", "ai_tool")
      .connect("Review", "AP agent", "ai_tool");
    const f = report(b, both).findings.find((x) => x.ruleId === "RG302" && x.nodes[0] === "AP agent");
    expect(f?.severity).toBe("critical");
  });
});

describe("credentials matched by id", () => {
  it("catches another client's credential when two credentials share a display name", () => {
    const m = "scope: [a]\ntenants:\n  - id: a\n    credentials: [credA1]\n  - id: b\n    credentials: [credB2]\n";
    const b = wf()
      .node({ name: "Read A", type: T.qbo, parameters: read, credentials: qboCred("credA1", "QuickBooks Online account") })
      .node({ name: "Create bill", type: T.qbo, parameters: { resource: "bill", operation: "create" }, credentials: qboCred("credB2", "QuickBooks Online account") });
    const f = report(b, m).findings.find((x) => x.ruleId === "RG102");
    expect(f?.nodes).toEqual(["Create bill"]);
  });

  it("without a manifest, ties a company ID to the credential used with it", () => {
    const b = wf()
      .node({ name: "Start", type: T.manual })
      .node({ name: "Get customer", type: T.qbo, parameters: { operation: "get" }, credentials: qboCred("c1", "QBO A") })
      .node({
        name: "Post JE",
        type: T.http,
        typeVersion: 4.2,
        parameters: { method: "POST", url: "https://quickbooks.api.intuit.com/v3/company/111/journalentry", authentication: "predefinedCredentialType", nodeCredentialType: "quickBooksOAuth2Api" },
        credentials: qboCred("c1", "QBO A"),
      })
      .connect("Start", "Get customer");
    approvedPath(b, "Get customer", "Post JE");
    const r = report(b);
    expect(ids(r)).not.toContain("RG301");
    expect(r.tenantsTouched).toHaveLength(1);
  });
});

describe("approvals that don't decide anything", () => {
  it("RG403: a Send and Wait with nothing checking the answer still posts on Disapprove", () => {
    const b = wf()
      .node({ name: "Daily", type: T.schedule })
      .node({ name: "Approve", type: T.slack, parameters: slackApproval })
      .node({ name: "Create A", type: T.qbo, parameters: create, credentials: credA })
      .chain("Daily", "Approve", "Create A");
    const r = report(b, onlyA);
    expect(r.findings.find((f) => f.ruleId === "RG403")?.severity).toBe("high");
    expect(r.verdict).toBe("fix");
  });

  it("RG403: an approval's error output wired to the write skips the check", () => {
    const b = wf()
      .node({ name: "Daily", type: T.schedule })
      .node({ name: "Approve", type: T.slack, parameters: slackApproval })
      .node({ name: "Approved?", type: "n8n-nodes-base.if", parameters: approvedCheck })
      .node({ name: "Create A", type: T.qbo, parameters: create, credentials: credA })
      .chain("Daily", "Approve", "Approved?", "Create A")
      .connect("Approve", "Create A", "main", 1);
    expect(ids(report(b, onlyA))).toContain("RG403");
  });

  it("passes when an IF on the answer sits between the approval and the write", () => {
    const b = wf()
      .node({ name: "Daily", type: T.schedule })
      .node({ name: "Create A", type: T.qbo, parameters: create, credentials: credA });
    approvedPath(b, "Daily", "Create A");
    expect(report(b, onlyA).verdict).toBe("clear");
  });
});

describe("manifest safety", () => {
  it("rejects a misspelled top-level key instead of silently widening scope", () => {
    const r = parseManifest("Scope: [a]\ntenants:\n  - id: a\n  - id: b\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/"Scope".*did you mean "scope"/i);
  });

  it("rejects a misspelled tenant key", () => {
    const r = parseManifest("tenants:\n  - id: a\n    realmIDs: ['111']\n");
    expect(!r.ok && r.errors.join(" ")).toMatch(/realmIDs.*realmIds/);
  });

  it("reports an unresolved YAML alias instead of throwing", () => {
    expect(() => parseManifest("tenants:\n  - id: a\n    credentials: *creds\n")).not.toThrow();
    expect(parseManifest("tenants:\n  - id: a\n    credentials: *creds\n").ok).toBe(false);
  });

  it("refuses an alias bomb", () => {
    const bomb = ["a: &a [x, x, x, x, x, x, x, x, x, x]", ...Array.from({ length: 9 }, (_, i) => `${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [*${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}]`), "tenants:\n  - id: a"].join("\n");
    const r = parseManifest(bomb);
    expect(r.ok).toBe(false);
    // The alias limit must be what rejects it, not the unknown top-level keys around it.
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/alias/i);
  });
});

describe("QuickBooks calls the first build didn't recognize", () => {
  it("sees an HTTP call with the QuickBooks credential type even when the URL and credential are hidden", () => {
    const b = wf()
      .node({ name: "Daily", type: T.schedule })
      .node({ name: "Post bill", type: T.http, typeVersion: 4.2, parameters: { method: "POST", url: "={{ $vars.QBO_BASE }}/v3/company/{{ $json.realmId }}/bill", authentication: "predefinedCredentialType", nodeCredentialType: "quickBooksOAuth2Api" } })
      .chain("Daily", "Post bill");
    const r = report(b, onlyA);
    expect(r.touchpoints).toHaveLength(1);
    expect(ids(r)).toEqual(expect.arrayContaining(["RG103", "RG201", "RG401"]));
  });

  it("RG201 critical: the agent fills the company ID of an HTTP tool placeholder", () => {
    const b = wf()
      .node({ name: "Agent", type: T.agent })
      .node({ name: "Query", type: "@n8n/n8n-nodes-langchain.toolHttpRequest", parameters: { url: "https://quickbooks.api.intuit.com/v3/company/{realmId}/query", method: "POST" }, credentials: credA })
      .connect("Query", "Agent", "ai_tool");
    expect(report(b, both).findings.find((f) => f.ruleId === "RG201")?.severity).toBe("critical");
  });

  it("RG201: reads a company ID inside a template literal", () => {
    const b = wf().node({ name: "Q", type: T.http, parameters: { method: "POST", url: "={{ `https://quickbooks.api.intuit.com/v3/company/${$json.realmId}/bill` }}" } });
    const r = report(b, both);
    expect(ids(r)).toContain("RG201");
    expect(r.touchpoints[0]?.operation).toBe("POST bill");
  });

  it("lists Code, community and MCP nodes that mention QuickBooks as gaps", () => {
    const b = wf()
      .node({ name: "Raw call", type: T.code, parameters: { jsCode: "await this.helpers.httpRequestWithAuthentication.call(this, 'quickBooksOAuth2Api', {})" } })
      .node({ name: "QBO Pro", type: "n8n-nodes-qbo-pro.quickbooksPro" })
      .node({ name: "Intuit MCP", type: "@n8n/n8n-nodes-langchain.mcpClientTool", parameters: { endpointUrl: "https://mcp.intuit.com/qbo" } });
    const r = report(b, both);
    expect(r.coverage.gaps.join(" ")).toMatch(/Raw call.*QBO Pro.*Intuit MCP|Raw call[\s\S]*QBO Pro[\s\S]*Intuit MCP/);
    expect(r.verdict).toBe("not-verified");
  });

  it("lists other community nodes without blocking the verdict", () => {
    const b = wf()
      .node({ name: "Daily", type: T.schedule })
      .node({ name: "Q", type: T.qbo, credentials: credA })
      .node({ name: "Fancy", type: "n8n-nodes-fancy.fancy" })
      .chain("Daily", "Q", "Fancy");
    const r = report(b, onlyA);
    expect(r.coverage.communityNodes).toEqual(["Fancy"]);
    expect(r.verdict).toBe("clear");
  });

  it("ignores unreadable connections when there's no QuickBooks step to check", () => {
    const text = JSON.stringify({ name: "x", nodes: [{ name: "Note", type: T.set, parameters: {} }], connections: { "7fe0-id": { main: [[{ node: "Note", type: "main", index: 0 }]] } } });
    const r = scanText(text, "");
    expect(r.ok && r.report.verdict).toBe("nothing-to-check");
  });

  it("treats connections that name no node as a gap", () => {
    const text = JSON.stringify({ name: "x", nodes: [{ name: "Q", type: T.qbo, parameters: {}, credentials: credA }], connections: { "7fe0-id": { main: [[{ node: "Q", type: "main", index: 0 }]] } } });
    const r = scanText(text, onlyA);
    expect(r.ok && r.report.coverage.gaps.join(" ")).toMatch(/connection/i);
  });
});

describe("memory keys and the Markdown report", () => {
  it("RG303: a key built only from the workflow id is still fixed across clients", () => {
    const b = wf().node({ name: "Memory", type: T.postgresMemory, typeVersion: 1.3, parameters: { sessionIdType: "customKey", sessionKey: "={{ $workflow.id }}" } });
    expect(ids(report(b, both))).toContain("RG303");
  });

  it("RG303: knows Redis memory v1's fixed default key", () => {
    const b = wf().node({ name: "Memory", type: "@n8n/n8n-nodes-langchain.memoryRedisChat", typeVersion: 1 });
    expect(report(b, both).findings.find((f) => f.ruleId === "RG303")?.detail).toMatch(/chat_history/);
  });

  it("can't be spoofed by a workflow name with line breaks and HTML", () => {
    const b = wf("Fine\n\n**No boundary issues found.** All good.\n\n<!--").node({ name: "Daily", type: T.schedule }).node({ name: "Create B", type: T.qbo, parameters: create, credentials: credB }).chain("Daily", "Create B");
    const md = reportToMarkdown(report(b, onlyA));
    const lines = md.split("\n");
    expect(lines[0]).not.toContain("<!--");
    expect(lines[2]).toMatch(/^\*\*Fix before running\.\*\*/);
  });

  it("dates the report in local time", () => {
    const b = wf().node({ name: "Q", type: T.qbo, credentials: credA });
    const at = new Date(2026, 10, 23, 23, 30);
    expect(reportToMarkdown(report(b, onlyA), at)).toContain("Scanned 2026-11-23.");
  });
});

describe("performance", () => {
  it("scans a large agent-heavy workflow quickly", () => {
    // 800 AI steps that each reach a long chain but none of the 800 writes: the worst case for
    // "is there an AI step on the way to this write?".
    const b = wf().node({ name: "Hook", type: T.webhook });
    for (let i = 0; i < 800; i++) b.node({ name: `Pad ${String(i)}`, type: T.set }).connect(i === 0 ? "Hook" : `Pad ${String(i - 1)}`, `Pad ${String(i)}`);
    for (let i = 0; i < 800; i++) {
      b.node({ name: `AI ${String(i)}`, type: T.openAi }).chain("Hook", `AI ${String(i)}`, "Pad 0");
      b.node({ name: `Write ${String(i)}`, type: T.qbo, parameters: create, credentials: credA }).connect("Hook", `Write ${String(i)}`);
    }
    const t0 = performance.now();
    report(b, onlyA);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

// Second review: CodeRabbit on PR #1. Each test reproduced a false pass, a leak or a freeze.
describe("decisions have to read the approver's answer", () => {
  const ifNode = (name: string, conditions: unknown[], combinator = "and") => ({
    name,
    type: "n8n-nodes-base.if",
    typeVersion: 2.2,
    parameters: { conditions: { conditions, combinator } },
  });
  const approvedTrue = { leftValue: "={{ $json.data.approved }}", operator: { type: "boolean", operation: "true" } };
  const approvedFalse = { leftValue: "={{ $json.data.approved }}", operator: { type: "boolean", operation: "false" } };
  const bigAmount = { leftValue: "={{ $json.amount }}", rightValue: 1000, operator: { type: "number", operation: "gt" } };
  const gated = (decision: { name: string; type: string; typeVersion: number; parameters: Record<string, unknown> }, output: number) =>
    wf()
      .node({ name: "Daily", type: T.schedule })
      .node({ name: "Approve", type: T.slack, typeVersion: 2.3, parameters: slackApproval })
      .node(decision)
      .node({ name: "Create A", type: T.qbo, parameters: create, credentials: credA })
      .chain("Daily", "Approve", decision.name)
      .connect(decision.name, "Create A", "main", output);

  it("RG403: an IF that checks something else doesn't stand in for the answer", () => {
    const r = report(gated(ifNode("Big?", [bigAmount]), 0), onlyA);
    expect(r.findings.find((f) => f.ruleId === "RG403")?.detail).toMatch(/nothing checks the answer/);
  });

  it("RG403: a write on the false branch of the approval check runs when the approver says no", () => {
    const r = report(gated(ifNode("Approved?", [approvedTrue]), 1), onlyA);
    const f = r.findings.find((x) => x.ruleId === "RG403");
    expect(f?.nodes).toEqual(["Create A", "Approve", "Approved?"]);
    expect(f?.title).toMatch(/declined/i);
  });

  it("passes a write on the false branch of a check for a decline", () => {
    expect(report(gated(ifNode("Declined?", [approvedFalse]), 1), onlyA).verdict).toBe("clear");
  });

  it("RG403: an OR with an unrelated condition can let a declined run through the true branch", () => {
    expect(ids(report(gated(ifNode("Approved or big?", [approvedTrue, bigAmount], "or"), 0), onlyA))).toContain("RG403");
  });

  it("passes an AND that also checks the answer", () => {
    expect(report(gated(ifNode("Approved and big?", [approvedTrue, bigAmount]), 0), onlyA).verdict).toBe("clear");
  });

  it("reads the version 1 IF format", () => {
    const v1 = { name: "Approved?", type: "n8n-nodes-base.if", typeVersion: 1, parameters: { conditions: { boolean: [{ value1: "={{ $json.data.approved }}", value2: true }] } } };
    expect(report(gated(v1, 0), onlyA).verdict).toBe("clear");
    expect(ids(report(gated(v1, 1), onlyA))).toContain("RG403");
  });

  it("routes a form answer through a Switch by output", () => {
    const rule = (value: string) => ({ conditions: { conditions: [{ leftValue: "={{ $json.Decision }}", rightValue: value, operator: { type: "string", operation: "equals" } }], combinator: "and" } });
    const build = (output: number) =>
      wf()
        .node({ name: "Daily", type: T.schedule })
        .node({ name: "Ask", type: T.wait, typeVersion: 1.1, parameters: { resume: "form", formFields: { values: [{ fieldLabel: "Decision", fieldType: "dropdown" }] } } })
        .node({ name: "Route", type: "n8n-nodes-base.switch", typeVersion: 3.2, parameters: { rules: { values: [rule("Approve"), rule("Reject")] } } })
        .node({ name: "Create A", type: T.qbo, parameters: create, credentials: credA })
        .chain("Daily", "Ask", "Route")
        .connect("Route", "Create A", "main", output);
    expect(report(build(0), onlyA).verdict).toBe("clear");
    expect(ids(report(build(1), onlyA))).toContain("RG403");
  });
});

describe("tokens stay out of the report", () => {
  const httpWithAuth = (headers: Record<string, unknown>) =>
    wf().node({
      name: "Post",
      type: T.http,
      typeVersion: 4.2,
      parameters: { method: "POST", url: "https://quickbooks.api.intuit.com/v3/company/111/bill", ...headers },
    });
  const header = (value: string) => ({ sendHeaders: true, headerParameters: { parameters: [{ name: "Authorization", value }] } });

  it("RG105 names where the token comes from without printing the expression", () => {
    const b = httpWithAuth(header("=Bearer {{ $('Get token').item.json.access_token }}"));
    const r = report(b.node({ name: "Get token", type: T.http, parameters: { url: "https://vault.example.com/token" } }).chain("Get token", "Post"), onlyA);
    const f = r.findings.find((x) => x.ruleId === "RG105");
    expect(f?.detail).toContain('"Get token"');
    expect(f?.detail).not.toMatch(/access_token|\{\{/);
  });

  it("RG106: a literal token inside an expression is still a pasted token, and never printed", () => {
    const r = report(httpWithAuth(header('={{ "Bearer sk_live_abcdef123456" + "" }}')), onlyA);
    expect(ids(r)).toContain("RG106");
    expect(ids(r)).not.toContain("RG105");
    expect(JSON.stringify(r)).not.toContain("sk_live");
    expect(reportToMarkdown(r)).not.toContain("sk_live");
  });
});

describe("company IDs and credentials", () => {
  const http = (name: string, method: string, url: string, extra: Record<string, unknown> = {}) => ({
    name,
    type: T.http,
    typeVersion: 4.2,
    parameters: { method, url, authentication: "predefinedCredentialType", nodeCredentialType: "quickBooksOAuth2Api", ...extra },
    credentials: qboCred("c1", "QBO shared"),
  });

  it("RG301 without a manifest: one credential used with two company IDs doesn't merge them", () => {
    const b = wf()
      .node({ name: "Daily", type: T.schedule })
      .node(http("Read 111", "GET", "https://quickbooks.api.intuit.com/v3/company/111/invoice/9"))
      .node(http("Post 222", "POST", "https://quickbooks.api.intuit.com/v3/company/222/invoice"))
      .connect("Daily", "Read 111");
    approvedPath(b, "Read 111", "Post 222");
    const r = report(b);
    expect(ids(r)).toEqual(expect.arrayContaining(["RG104", "RG301"]));
    expect(r.tenantsTouched).toHaveLength(2);
  });

  it("RG201: a URL expression that picks between companies isn't a fixed company ID", () => {
    const url = '={{ $json.client === "a" ? "https://quickbooks.api.intuit.com/v3/company/111/invoice" : "https://quickbooks.api.intuit.com/v3/company/222/invoice" }}';
    const r = report(wf().node(http("Post", "POST", url)), both);
    expect(r.touchpoints[0]?.realmId).toBeUndefined();
    expect(r.touchpoints[0]?.realmIsExpression).toBe(true);
    expect(ids(r)).toContain("RG201");
  });

  it("keeps a literal company ID when only a later part of the URL is an expression", () => {
    const r = report(wf().node(http("Get", "GET", "=https://quickbooks.api.intuit.com/v3/company/111/invoice/{{ $json.id }}")), both);
    expect(r.touchpoints[0]?.realmId).toBe("111");
  });

  it("reads only the header mode the node sends", () => {
    const stale = { sendHeaders: true, headerParameters: { parameters: [{ name: "Accept", value: "application/json" }] }, jsonHeaders: '={"Authorization": "Bearer {{ $json.token }}"}' };
    const off = { sendHeaders: false, headerParameters: { parameters: [{ name: "Authorization", value: "=Bearer {{ $json.token }}" }] } };
    const legacy = { jsonParameters: true, headerParametersJson: '{"Accept": "application/json"}', headerParametersUi: { parameter: [{ name: "Authorization", value: "=Bearer {{ $json.token }}" }] } };
    for (const extra of [stale, off]) {
      const r = report(wf().node(http("Get", "GET", "https://quickbooks.api.intuit.com/v3/company/111/invoice/1", extra)), both);
      expect(r.touchpoints[0]?.auth).toBe("credential");
      expect(ids(r)).not.toContain("RG105");
    }
    const old = report(wf().node({ ...http("Get", "GET", "https://quickbooks.api.intuit.com/v3/company/111/invoice/1", legacy), typeVersion: 2 }), both);
    expect(old.touchpoints[0]?.auth).toBe("credential");
  });

  it("RG106 still flags a pasted token left in a header the node no longer sends", () => {
    const off = { sendHeaders: false, headerParameters: { parameters: [{ name: "Authorization", value: "Bearer abcdefghijklmnop" }] } };
    const r = report(wf().node(http("Get", "GET", "https://quickbooks.api.intuit.com/v3/company/111/invoice/1", off)), both);
    expect(r.touchpoints[0]?.auth).toBe("credential");
    expect(r.findings.find((f) => f.ruleId === "RG106")?.detail).toMatch(/isn't sent/);
  });

  it("resolves a credential's owner the same way whichever reference comes first", () => {
    const m = manifestYaml([A, { id: "b", credentials: ["QBO B"], realmIds: ["222"] }], ["a"]);
    const bare = { quickBooksOAuth2Api: { id: "cb" } };
    const named = { quickBooksOAuth2Api: { id: "cb", name: "QBO B" } };
    for (const order of [[bare, named], [named, bare]] as const) {
      const b = wf()
        .node({ name: "Read", type: T.qbo, parameters: read, credentials: order[0] })
        .node({ name: "Read again", type: T.qbo, parameters: read, credentials: order[1] });
      const r = report(b, m);
      expect(ids(r)).toContain("RG102");
      expect(ids(r)).not.toContain("RG101");
    }
  });
});

describe("agents and skipped nodes", () => {
  it("RG301: an agent fed one client's data can write it into another client's books with a tool", () => {
    const b = wf()
      .node({ name: "Daily", type: T.schedule })
      .node({ name: "Read A", type: T.qbo, parameters: read, credentials: credA })
      .node({ name: "Agent", type: T.agent })
      .node({ name: "Review", type: T.slackHitl })
      .node({ name: "Create B", type: T.qboTool, parameters: create, credentials: credB })
      .chain("Daily", "Read A", "Agent")
      .connect("Create B", "Review", "ai_tool")
      .connect("Review", "Agent", "ai_tool");
    const f = report(b, both).findings.find((x) => x.ruleId === "RG301");
    expect(f?.nodes).toEqual(["Create B", "Read A"]);
    expect(f?.detail).toContain('"Agent"');
  });

  it("lists nodes the parser skipped as gaps, so the verdict can't be clear", () => {
    const text = JSON.stringify({
      name: "x",
      nodes: [
        { name: "Q", type: T.qbo, parameters: read, credentials: credA },
        { name: "Q", type: T.qbo, parameters: create, credentials: credB },
        { type: T.qbo, parameters: create },
      ],
      connections: {},
    });
    const r = scanText(text, onlyA);
    if (!r.ok) throw new Error("parse failed");
    expect(r.report.verdict).toBe("not-verified");
    const md = reportToMarkdown(r.report);
    expect(md).toMatch(/Two nodes are named "Q"/);
    expect(md).toMatch(/Node 3 is missing its name or type/);
  });
});

describe("performance with disabled nodes and many approvals", () => {
  it("scans a long chain of approvals and checks quickly", () => {
    // 600 approve, check, write rounds in a row: every gate's walk covers the rest of the chain.
    const b = wf().node({ name: "Hook", type: T.webhook });
    let prev = "Hook";
    for (let i = 0; i < 600; i++) {
      const n = String(i);
      b.node({ name: `Approve ${n}`, type: T.slack, typeVersion: 2.3, parameters: slackApproval })
        .node({ name: `Approved ${n}?`, type: "n8n-nodes-base.if", typeVersion: 2.2, parameters: approvedCheck })
        .node({ name: `Write ${n}`, type: T.qbo, parameters: create, credentials: credA })
        .chain(prev, `Approve ${n}`, `Approved ${n}?`, `Write ${n}`);
      prev = `Write ${n}`;
    }
    const t0 = performance.now();
    const r = report(b, onlyA);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(r.verdict).toBe("clear");
  });

  it("doesn't fan out every pair across a disabled node", () => {
    const b = wf().node({ name: "Hook", type: T.webhook }).node({ name: "Hub", type: T.set, disabled: true });
    for (let i = 0; i < 1500; i++) b.node({ name: `In ${String(i)}`, type: T.set }).chain("Hook", `In ${String(i)}`, "Hub");
    for (let i = 0; i < 1500; i++) b.node({ name: `Out ${String(i)}`, type: T.set }).connect("Hub", `Out ${String(i)}`);
    b.node({ name: "Create A", type: T.qbo, parameters: create, credentials: credA }).connect("Out 0", "Create A");
    const t0 = performance.now();
    const r = report(b, onlyA);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(r.findings.find((f) => f.ruleId === "RG401")?.severity).toBe("high");
  });
});

// Third round: CodeRabbit's re-review of the fixes, plus error routing found while checking
// the Switch source.
describe("approval checks, round two", () => {
  const ifOn = (conditions: unknown[], extra: Record<string, unknown> = {}) => ({ name: "Check", type: "n8n-nodes-base.if", typeVersion: 2.2, parameters: { conditions: { conditions } }, ...extra });
  const after = (decision: { name: string; type: string; typeVersion: number; parameters: Record<string, unknown> }, output: number, raw: Record<string, unknown> = {}) => {
    const b = wf()
      .node({ name: "Daily", type: T.schedule })
      .node({ name: "Approve", type: T.slack, typeVersion: 2.3, parameters: slackApproval })
      .node({ name: "Policy", type: T.set })
      .node(decision)
      .node({ name: "Create A", type: T.qbo, parameters: create, credentials: credA })
      .chain("Daily", "Policy", "Approve", decision.name)
      .connect(decision.name, "Create A", "main", output);
    const json = b.json() as { nodes: Record<string, unknown>[] };
    Object.assign(json.nodes.find((n) => n.name === decision.name) ?? {}, raw);
    const r = scanText(JSON.stringify(json), onlyA);
    if (!r.ok) throw new Error("parse failed");
    return r.report;
  };
  const cond = (leftValue: string, operation: string, rightValue?: unknown) => ({ leftValue, rightValue, operator: { type: "boolean", operation } });

  it("RG403: checking that the answer exists isn't checking that it's yes", () => {
    expect(ids(after(ifOn([cond("={{ $json.data.approved }}", "exists")]), 0))).toContain("RG403");
  });

  it("RG403: an IF on another node's approved field doesn't check the person's answer", () => {
    expect(ids(after(ifOn([cond("={{ $('Policy').item.json.approved }}", "true")]), 0))).toContain("RG403");
  });

  it("RG403: the word approved as a literal value isn't the answer either", () => {
    const status = { leftValue: "={{ $json.status }}", rightValue: "approved", operator: { type: "string", operation: "equals" } };
    expect(ids(after(ifOn([status]), 0))).toContain("RG403");
  });

  it("still passes a check that names the approval node", () => {
    expect(after(ifOn([cond("={{ $('Approve').item.json.data.approved }}", "true")]), 0).verdict).toBe("clear");
  });

  it("RG403: an IF set to continue on error sends failed items down the false branch", () => {
    const declined = ifOn([cond("={{ $json.data.approved }}", "false")]);
    expect(after(declined, 1).verdict).toBe("clear");
    expect(ids(after(declined, 1, { onError: "continueRegularOutput" }))).toContain("RG403");
  });

  it("Switch v2 routes each rule to its position, v1 to its output field", () => {
    const rules = (v: number) => ({
      name: "Route",
      type: "n8n-nodes-base.switch",
      typeVersion: v,
      parameters: { dataType: "boolean", value1: "={{ $json.data.approved }}", rules: { rules: [{ value2: false }, { value2: true, ...(v === 1 ? { output: 2 } : {}) }] } },
    });
    expect(after(rules(2), 1).verdict).toBe("clear");
    expect(ids(after(rules(2), 0))).toContain("RG403");
    expect(after(rules(1), 2).verdict).toBe("clear");
  });

  it("RG403: a Switch whose fallback or errors land on the yes output", () => {
    const yes = { conditions: { conditions: [cond("={{ $json.data.approved }}", "true")], combinator: "and" } };
    const sw = (options: Record<string, unknown>) => ({ name: "Route", type: "n8n-nodes-base.switch", typeVersion: 3.2, parameters: { rules: { values: [yes] }, options } });
    expect(after(sw({}), 0).verdict).toBe("clear");
    expect(ids(after(sw({ fallbackOutput: 0 }), 0))).toContain("RG403");
    expect(ids(after(sw({}), 0, { onError: "continueRegularOutput" }))).toContain("RG403");
  });
});

describe("graph and parsing, round two", () => {
  it("RG401: a write fed only by a disabled node is its own entry point", () => {
    const b = wf()
      .node({ name: "Old trigger", type: T.set, disabled: true })
      .node({ name: "Create A", type: T.qbo, parameters: create, credentials: credA })
      .connect("Old trigger", "Create A");
    expect(report(b, onlyA).findings.find((f) => f.ruleId === "RG401")?.severity).toBe("medium");
  });

  it("treats a POST as a write when the URL expression can return a path it can't read", () => {
    const url = '={{ $json.lookup ? "https://quickbooks.api.intuit.com/v3/company/111/query" : $json.url }}';
    const b = wf()
      .node({ name: "Daily", type: T.schedule })
      .node({ name: "Call", type: T.http, typeVersion: 4.2, parameters: { method: "POST", url }, credentials: credA })
      .chain("Daily", "Call");
    const r = report(b, onlyA);
    expect(r.touchpoints[0]?.write).toBe(true);
    expect(ids(r)).toContain("RG401");
  });

  it("an HTTP Request node doesn't read the AI tool's header field", () => {
    const b = wf().node({
      name: "Get",
      type: T.http,
      typeVersion: 4.2,
      parameters: { method: "GET", url: "https://quickbooks.api.intuit.com/v3/company/111/invoice/1", sendHeaders: true, parametersHeaders: { values: [{ name: "Authorization", value: "=Bearer {{ $json.token }}" }] } },
      credentials: credA,
    });
    expect(report(b, both).touchpoints[0]?.auth).toBe("credential");
  });

  it("RG105 quotes only real node names", () => {
    const b = wf().node({
      name: "Post",
      type: T.http,
      typeVersion: 4.2,
      parameters: {
        method: "POST",
        url: "=https://quickbooks.api.intuit.com/v3/company/{{ $('sk_live_abcdef123456').item.json.realm }}/bill",
        sendHeaders: true,
        headerParameters: { parameters: [{ name: "Authorization", value: "={{ 'Bearer ' + $('sk_live_abcdef123456').item.json.t }}" }] },
      },
    });
    const r = report(b, onlyA);
    expect(ids(r)).toContain("RG105");
    expect(JSON.stringify(r.findings)).not.toContain("sk_live");
  });

  it("resolves a credential name given only on a disabled node", () => {
    const m = manifestYaml([A, { id: "b", credentials: ["QBO B"], realmIds: ["222"] }], ["a"]);
    const b = wf()
      .node({ name: "Read", type: T.qbo, parameters: read, credentials: { quickBooksOAuth2Api: { id: "cb" } } })
      .node({ name: "Old read", type: T.qbo, parameters: read, credentials: { quickBooksOAuth2Api: { id: "cb", name: "QBO B" } }, disabled: true });
    const r = report(b, m);
    expect(ids(r)).toContain("RG102");
    expect(ids(r)).not.toContain("RG101");
  });
});

// Round three: CodeRabbit's follow-ups in the threads and on the round-two commit.
describe("round three", () => {
  const approvalThen = (b: WorkflowBuilder, decision: Record<string, unknown>, output: number) =>
    b
      .node({ name: "Daily", type: T.schedule })
      .node({ name: "Approve", type: T.slack, typeVersion: 2.3, parameters: slackApproval })
      .node({ name: "Check", type: "n8n-nodes-base.if", typeVersion: 2.2, parameters: decision })
      .node({ name: "Create A", type: T.qbo, parameters: create, credentials: credA })
      .chain("Daily", "Approve", "Check")
      .connect("Check", "Create A", "main", output);

  it("RG403: a negated answer inside the expression doesn't sign as yes", () => {
    const negated = { conditions: { conditions: [{ leftValue: "={{ !$json.data.approved }}", operator: { type: "boolean", operation: "true" } }] } };
    expect(ids(report(approvalThen(wf(), negated, 0), onlyA))).toContain("RG403");
  });

  it("RG403: a second approval after an earlier yes is checked on its own", () => {
    const b = wf()
      .node({ name: "Daily", type: T.schedule })
      .node({ name: "Approve A", type: T.slack, typeVersion: 2.3, parameters: slackApproval })
      .node({ name: "A approved?", type: "n8n-nodes-base.if", typeVersion: 2.2, parameters: approvedCheck })
      .node({ name: "Approve B", type: T.slack, typeVersion: 2.3, parameters: slackApproval })
      .node({ name: "Create A", type: T.qbo, parameters: create, credentials: credA })
      .chain("Daily", "Approve A", "A approved?", "Approve B", "Create A");
    expect(report(b, onlyA).findings.find((f) => f.ruleId === "RG403")?.nodes).toEqual(["Create A", "Approve B"]);
  });

  it("treats a POST as a write when the template's path sits inside interpolation code", () => {
    const url = '={{ `https://quickbooks.api.intuit.com/v3/company/${$json.endpoint || "111/query"}` }}';
    const b = wf().node({ name: "Call", type: T.http, typeVersion: 4.2, parameters: { method: "POST", url }, credentials: credA });
    expect(report(b, onlyA).touchpoints[0]?.write).toBe(true);
  });

  it("RG106: a bearer token split across string literals is still pasted", () => {
    const b = wf().node({
      name: "Post",
      type: T.http,
      typeVersion: 4.2,
      parameters: { method: "POST", url: "https://quickbooks.api.intuit.com/v3/company/111/bill", sendHeaders: true, headerParameters: { parameters: [{ name: "Authorization", value: '={{ "Bearer " + "sk_live_abcdef123456" }}' }] } },
    });
    const r = report(b, onlyA);
    expect(ids(r)).toContain("RG106");
    expect(ids(r)).not.toContain("RG105");
  });

  it("the AI HTTP tool's header is filled by the model unless it's set to a fixed value", () => {
    const tool = (header: Record<string, unknown>) =>
      wf()
        .node({ name: "Agent", type: T.agent })
        .node({
          name: "Query",
          type: "@n8n/n8n-nodes-langchain.toolHttpRequest",
          typeVersion: 1.1,
          parameters: { method: "GET", url: "https://quickbooks.api.intuit.com/v3/company/111/query", sendHeaders: true, parametersHeaders: { values: [{ name: "Authorization", ...header }] } },
          credentials: credA,
        })
        .connect("Query", "Agent", "ai_tool");
    const byModel = report(tool({ value: "Bearer abcdefghijklmnop" }), both);
    expect(byModel.touchpoints[0]?.auth).toBe("dynamic-token");
    expect(byModel.findings.find((f) => f.ruleId === "RG105")?.detail).toContain("the AI model");
    expect(ids(byModel)).toContain("RG106");
    const placeholder = report(tool({ valueProvider: "fieldValue", value: "Bearer {token}" }), both);
    expect(placeholder.findings.find((f) => f.ruleId === "RG105")?.detail).toContain("the AI model");
    const fixed = report(tool({ valueProvider: "fieldValue", value: "Bearer abcdefghijklmnop" }), both);
    expect(fixed.touchpoints[0]?.auth).toBe("pasted-token");
  });

  it("a credential id that goes by two names is a gap, not a guess", () => {
    const b = wf()
      .node({ name: "Daily", type: T.schedule })
      .node({ name: "Read", type: T.qbo, parameters: read, credentials: qboCred("ca", "QBO A") })
      .node({ name: "Read again", type: T.qbo, parameters: read, credentials: qboCred("ca", "QBO Zed") })
      .chain("Daily", "Read", "Read again");
    const r = report(b, onlyA);
    expect(r.verdict).toBe("not-verified");
    expect(r.coverage.gaps.join(" ")).toMatch(/QBO A.*QBO Zed/);
  });
});

describe("round four", () => {
  const gatedBy = (decision: Record<string, unknown>, typeVersion = 2.2) =>
    wf()
      .node({ name: "Daily", type: T.schedule })
      .node({ name: "Approve", type: T.slack, typeVersion: 2.3, parameters: slackApproval })
      .node({ name: "Check", type: "n8n-nodes-base.if", typeVersion, parameters: decision })
      .node({ name: "Create A", type: T.qbo, parameters: create, credentials: credA })
      .chain("Daily", "Approve", "Check", "Create A");

  it("RG403: comparing the answer with another run-time value doesn't sign it", () => {
    const v2 = { conditions: { conditions: [{ leftValue: "={{ $json.data.approved }}", rightValue: "={{ $json.expectedApproval }}", operator: { type: "boolean", operation: "equals" } }] } };
    const v1 = { conditions: { boolean: [{ value1: "={{ $json.data.approved }}", value2: "={{ $('Daily').item.json.expected }}" }] } };
    expect(ids(report(gatedBy(v2), onlyA))).toContain("RG403");
    expect(ids(report(gatedBy(v1, 1), onlyA))).toContain("RG403");
  });

  it("still signs a comparison with a fixed value written as an expression", () => {
    const v2 = { conditions: { conditions: [{ leftValue: "={{ $json.data.approved }}", rightValue: "={{ true }}", operator: { type: "boolean", operation: "equals" } }] } };
    expect(report(gatedBy(v2), onlyA).verdict).toBe("clear");
  });

  it("masks interpolation code with nested braces before reading a template path", () => {
    const url = '={{ `https://quickbooks.api.intuit.com/v3/company/${({}).a || $json.endpoint || "111/query/x"}` }}';
    const b = wf().node({ name: "Call", type: T.http, typeVersion: 4.2, parameters: { method: "POST", url }, credentials: credA });
    expect(report(b, onlyA).touchpoints[0]?.write).toBe(true);
    const fixed = wf().node({ name: "Call", type: T.http, typeVersion: 4.2, parameters: { method: "POST", url: "={{ `https://quickbooks.api.intuit.com/v3/company/${$json.realm}/query` }}" }, credentials: credA });
    expect(report(fixed, onlyA).touchpoints[0]?.write).toBe(false);
  });
});

// The first review's 19 minor comments, which sat in the review body rather than in threads.
describe("first review, minor comments", () => {
  it("survives deeply nested parameters", () => {
    // Built as text: JSON.stringify itself runs out of stack on a tree this deep.
    const deep = `${"[".repeat(20000)}"x"${"]".repeat(20000)}`;
    const text = `{"name":"x","nodes":[{"name":"Deep","type":"${T.set}","parameters":{"v":${deep}}},{"name":"Q","type":"${T.qbo}","credentials":${JSON.stringify(credA)}}],"connections":{}}`;
    const r = scanText(text, onlyA);
    expect(r.ok).toBe(true);
  });

  it("reads $('...') names with escaped quotes", () => {
    const b = wf()
      .node({ name: "Daily", type: T.schedule })
      .node({ name: "Client's data", type: T.qbo, parameters: read, credentials: credA })
      .node({ name: "Create B", type: T.qbo, parameters: { ...create, CustomerRef: "={{ $('Client\\'s data').first().json.Id }}" }, credentials: credB })
      .connect("Daily", "Client's data");
    approvedPath(b, "Daily", "Create B");
    expect(ids(report(b, both))).toContain("RG301");
  });

  it("drafts a manifest that parses back for any credential name, and matches id-only credentials", () => {
    const b = wf()
      .node({ name: "A", type: T.qbo, credentials: qboCred("c1", "true") })
      .node({ name: "B", type: T.qbo, credentials: { quickBooksOAuth2Api: { id: "11" } } });
    const w = parseWorkflow(b.text());
    if (!w.ok) throw new Error("parse failed");
    const draft = draftManifest(w.value);
    const m = parseManifest(draft);
    expect(m.ok).toBe(true);
    const r = scanText(b.text(), draft);
    expect(r.ok && r.report.findings.map((f) => f.ruleId)).not.toContain("RG101");
  });

  it("RG303: shared in-workflow memory counts when the steps touch two clients, whatever the scope says", () => {
    const b = wf()
      .node({ name: "Read A", type: T.qbo, parameters: read, credentials: credA })
      .node({ name: "Read B", type: T.qbo, parameters: read, credentials: credB })
      .node({ name: "Memory", type: T.bufferMemory, typeVersion: 1.3, parameters: { sessionIdType: "customKey", sessionKey: "ap" } });
    expect(ids(report(b, onlyA))).toContain("RG303");
  });

  it("skips a malformed header entry instead of crashing the scan", () => {
    const b = wf().node({
      name: "Post",
      type: T.http,
      typeVersion: 4.2,
      parameters: { method: "POST", url: "https://quickbooks.api.intuit.com/v3/company/111/bill", sendHeaders: true, headerParameters: { parameters: [null, { name: "Authorization", value: "Bearer abcdefghijklmnop" }] } },
    });
    expect(ids(report(b, onlyA))).toContain("RG106");
  });

  it("RG106: decodes JSON escapes in a static JSON header", () => {
    const b = wf().node({
      name: "Post",
      type: T.http,
      typeVersion: 4.2,
      parameters: { method: "POST", url: "https://quickbooks.api.intuit.com/v3/company/111/bill", sendHeaders: true, specifyHeaders: "json", jsonHeaders: '{"Authoriz\\u0061tion": "\\u0042earer abcdefghijklmnop"}' },
    });
    expect(ids(report(b, onlyA))).toContain("RG106");
  });

  it("marks a write tool no agent uses as not connected, not as approved", () => {
    const b = wf().node({ name: "Loose tool", type: T.qboTool, parameters: create, credentials: credA });
    expect(report(b, onlyA).touchpoints[0]?.approval).toBe("unattached");
  });

  it("RG105: a shared lookup node pairs token and company only when both read the same item", () => {
    const build = (realmPick: string) =>
      wf()
        .node({ name: "Tenant lookup", type: T.http, parameters: { url: "https://vault.example.com/tenant" } })
        .node({
          name: "Post bill",
          type: T.http,
          typeVersion: 4.2,
          parameters: {
            method: "POST",
            url: `=https://quickbooks.api.intuit.com/v3/company/{{ $('Tenant lookup').${realmPick}.json.realmId }}/bill`,
            sendHeaders: true,
            headerParameters: { parameters: [{ name: "Authorization", value: "=Bearer {{ $('Tenant lookup').first().json.token }}" }] },
          },
        })
        .chain("Tenant lookup", "Post bill");
    expect(report(build("first()"), both).findings.find((f) => f.ruleId === "RG105")?.severity).toBe("medium");
    expect(report(build("last()"), both).findings.find((f) => f.ruleId === "RG105")?.severity).toBe("high");
  });

  it("signs a fixed string written as an expression", () => {
    const rule = { conditions: { conditions: [{ leftValue: "={{ $json.Decision }}", rightValue: "={{ 'Send it' }}", operator: { type: "string", operation: "equals" } }], combinator: "and" } };
    const b = wf()
      .node({ name: "Daily", type: T.schedule })
      .node({ name: "Ask", type: T.wait, typeVersion: 1.1, parameters: { resume: "form", formFields: { values: [{ fieldLabel: "Decision" }] } } })
      .node({ name: "Route", type: "n8n-nodes-base.switch", typeVersion: 3.2, parameters: { rules: { values: [rule] } } })
      .node({ name: "Create A", type: T.qbo, parameters: create, credentials: credA })
      .chain("Daily", "Ask", "Route", "Create A");
    expect(report(b, onlyA).verdict).toBe("clear");
  });
});
