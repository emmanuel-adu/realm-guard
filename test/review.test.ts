// Regression tests for the fresh-eyes review of v1 (see DECISIONS.md). Each one reproduced
// a wrong verdict or a crash on the first build.
import { describe, expect, it } from "vitest";
import { scanText } from "../src/engine";
import { parseManifest } from "../src/engine/manifest";
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
    expect(parseManifest(bomb).ok).toBe(false);
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
