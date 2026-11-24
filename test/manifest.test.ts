import { describe, expect, it } from "vitest";
import { draftManifest, parseManifest } from "../src/engine/manifest";
import { parseWorkflow } from "../src/engine/workflow";
import { T, qboCred, wf } from "./helpers";

const ok = (text: string) => {
  const r = parseManifest(text);
  if (!r.ok) throw new Error(`expected ok, got ${r.errors.join("; ")}`);
  return r;
};

const fail = (text: string) => {
  const r = parseManifest(text);
  if (r.ok) throw new Error("expected a manifest error");
  return r.errors.join(" ");
};

const two = `
version: 1
tenants:
  - id: harbor
    name: Harbor Dental
    credentials: ["QBO - Harbor"]
    realmIds: ["9130354772541234"]
  - id: pine
    name: Pine Street Bakery
    credentials: ["QBO - Pine"]
    realmIds: ["4620816365181712"]
`;

describe("parseManifest", () => {
  it("reads YAML tenants", () => {
    const m = ok(two).value;
    expect(m.tenants.map((t) => t.id)).toEqual(["harbor", "pine"]);
    expect(m.tenants[0]?.credentials).toEqual(["QBO - Harbor"]);
  });

  it("reads the same manifest written as JSON", () => {
    const json = JSON.stringify({ version: 1, tenants: [{ id: "harbor", name: "Harbor", credentials: [], realmIds: [] }] });
    expect(ok(json).value.tenants).toHaveLength(1);
  });

  it("puts every tenant in scope when scope is left out", () => {
    expect(ok(two).value.scope).toEqual(["harbor", "pine"]);
  });

  it("keeps every digit of an unquoted realm ID", () => {
    const m = ok("tenants:\n  - id: a\n    realmIds: [9130354772541234567]\n").value;
    expect(m.tenants[0]?.realmIds).toEqual(["9130354772541234567"]);
  });

  it("uses the id as the name when name is missing", () => {
    expect(ok("tenants:\n  - id: harbor\n").value.tenants[0]?.name).toBe("harbor");
  });

  it("rejects a scope that names an unknown tenant", () => {
    expect(fail(`${two}scope: [harbor, oak]\n`)).toMatch(/scope.*oak/);
  });

  it("rejects duplicate tenant ids", () => {
    expect(fail("tenants:\n  - id: a\n  - id: a\n")).toMatch(/twice/);
  });

  it("rejects a realm ID listed under two tenants", () => {
    expect(fail("tenants:\n  - id: a\n    realmIds: ['1']\n  - id: b\n    realmIds: ['1']\n")).toMatch(/realm ID 1/);
  });

  it("gives the line number of a YAML syntax error", () => {
    expect(fail("tenants:\n  - id: a\n    credentials: [oops\n")).toMatch(/line \d/);
  });

  it("rejects a manifest with no tenants", () => {
    expect(fail("version: 1\ntenants: []\n")).toMatch(/at least one tenant/);
  });

  it("warns, rather than fails, when one credential is mapped to two tenants", () => {
    const r = ok("tenants:\n  - id: a\n    credentials: [shared]\n  - id: b\n    credentials: [shared]\n");
    expect(r.warnings.join(" ")).toMatch(/shared/);
  });

  it("rejects approvalNodes that isn't a list of names", () => {
    expect(fail("approvalNodes: 3\ntenants:\n  - id: a\n")).toMatch(/approvalNodes/);
  });
});

describe("draftManifest", () => {
  const workflow = () => {
    const r = parseWorkflow(
      wf()
        .node({ name: "Harbor invoices", type: T.qbo, credentials: qboCred("11", "QBO - Harbor") })
        .node({ name: "Pine invoices", type: T.qbo, credentials: qboCred("12", "QBO - Pine") })
        .node({ name: "Raw call", type: T.http, parameters: { url: "https://quickbooks.api.intuit.com/v3/company/4620816365181712/query" } })
        .text(),
    );
    if (!r.ok) throw new Error("bad fixture");
    return r.value;
  };

  it("drafts one tenant per QuickBooks credential and round-trips", () => {
    const m = ok(draftManifest(workflow())).value;
    expect(m.tenants.flatMap((t) => t.credentials)).toEqual(["QBO - Harbor", "QBO - Pine"]);
  });

  it("lists literal realm IDs it found so the user can assign them", () => {
    expect(draftManifest(workflow())).toContain("4620816365181712");
  });
});
