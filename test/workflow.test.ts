import { describe, expect, it } from "vitest";
import { MAX_INPUT_BYTES, parseWorkflow } from "../src/engine/workflow";
import { T, qboCred, wf } from "./helpers";

const ok = (text: string) => {
  const r = parseWorkflow(text);
  if (!r.ok) throw new Error(`expected ok, got ${r.errors.join("; ")}`);
  return r.value;
};

const fail = (text: string) => {
  const r = parseWorkflow(text);
  if (r.ok) throw new Error("expected a parse error");
  return r.errors.join(" ");
};

describe("parseWorkflow", () => {
  it("reads nodes and main connections as edges", () => {
    const w = ok(wf("Invoices").node({ name: "Start", type: T.manual }).node({ name: "Get", type: T.qbo }).chain("Start", "Get").text());
    expect(w.name).toBe("Invoices");
    expect(w.nodes.map((n) => n.name)).toEqual(["Start", "Get"]);
    expect(w.edges).toEqual([{ from: "Start", to: "Get", type: "main", output: 0 }]);
  });

  it("keeps ai_tool edges with their type", () => {
    const w = ok(wf().node({ name: "Tool", type: T.qboTool }).node({ name: "Agent", type: T.agent }).connect("Tool", "Agent", "ai_tool").text());
    expect(w.edges).toEqual([{ from: "Tool", to: "Agent", type: "ai_tool", output: 0 }]);
  });

  it("normalizes all three credential shapes found in real exports", () => {
    const text = wf()
      .node({ name: "A", type: T.qbo, credentials: qboCred("7", "QBO Harbor") })
      .node({ name: "B", type: T.qbo, credentials: { quickBooksOAuth2Api: "QBO Pine" } })
      .node({ name: "C", type: T.qbo, credentials: { quickBooksOAuth2Api: { name: "QBO Oak" } } })
      .text();
    const [a, b, c] = ok(text).nodes;
    expect(a?.credentials.quickBooksOAuth2Api).toEqual({ id: "7", name: "QBO Harbor" });
    expect(b?.credentials.quickBooksOAuth2Api).toEqual({ name: "QBO Pine" });
    expect(c?.credentials.quickBooksOAuth2Api).toEqual({ name: "QBO Oak" });
  });

  it("names a canvas copy that has no workflow name", () => {
    expect(ok(JSON.stringify({ nodes: [], connections: {} })).name).toBe("Untitled workflow");
  });

  it("accepts a CLI export holding exactly one workflow", () => {
    expect(ok(`[${wf("One").text()}]`).name).toBe("One");
  });

  it("refuses a CLI export holding several workflows", () => {
    expect(fail(`[${wf("One").text()},${wf("Two").text()}]`)).toMatch(/2 workflows/);
  });

  it("explains invalid JSON", () => {
    expect(fail("{ nodes: [")).toMatch(/isn't valid JSON/);
  });

  it("explains JSON that isn't a workflow", () => {
    expect(fail(JSON.stringify({ hello: "world" }))).toMatch(/doesn't look like an n8n workflow/);
  });

  it("records pinned data and disabled nodes", () => {
    const w = ok(wf().node({ name: "Get", type: T.qbo }).node({ name: "Off", type: T.qbo, disabled: true }).pin("Get", [{ Id: "1" }]).text());
    expect(w.pinnedNodes).toEqual(["Get"]);
    expect(w.nodes.find((n) => n.name === "Off")?.disabled).toBe(true);
  });

  it("refuses files over the size cap", () => {
    expect(fail(" ".repeat(MAX_INPUT_BYTES + 1))).toMatch(/too large/);
  });

  it("ignores connections to nodes that don't exist", () => {
    const w = ok(wf().node({ name: "A", type: T.manual }).connect("A", "Ghost").text());
    expect(w.edges).toEqual([]);
  });
});
