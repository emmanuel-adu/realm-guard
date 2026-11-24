import { describe, expect, it } from "vitest";
import { reportToMarkdown } from "../src/engine/markdown";
import { parseManifest } from "../src/engine/manifest";
import { scan } from "../src/engine/scan";
import { parseWorkflow } from "../src/engine/workflow";
import { T, manifestYaml, qboCred, wf } from "./helpers";

describe("reportToMarkdown", () => {
  const w = parseWorkflow(
    wf("Pine invoices")
      .node({ name: "Nightly", type: T.schedule })
      .node({ name: "Make | invoice", type: T.qbo, parameters: { resource: "invoice", operation: "create" }, credentials: qboCred("12", "QBO - Pine") })
      .chain("Nightly", "Make | invoice")
      .text(),
  );
  const m = parseManifest(manifestYaml([{ id: "harbor", credentials: ["QBO - Harbor"] }, { id: "pine", credentials: ["QBO - Pine"] }], ["harbor"]));
  if (!w.ok || !m.ok) throw new Error("bad fixture");
  const md = reportToMarkdown(scan(w.value, m.value));

  it("leads with the workflow name and verdict", () => {
    expect(md.split("\n")[0]).toBe("# Realm Guard report: Pine invoices");
    expect(md).toMatch(/Fix before running/);
  });

  it("lists each finding with its rule ID and fix", () => {
    expect(md).toMatch(/RG102/);
    expect(md).toMatch(/\*\*Fix:\*\*/);
  });

  it("escapes pipes in node names inside the touchpoint table", () => {
    expect(md).toContain("Make \\| invoice");
  });

  it("never contains an em dash", () => {
    expect(md).not.toMatch(/\u2014/);
  });
});
