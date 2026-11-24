import { describe, expect, it } from "vitest";
import { scanText } from "../src/engine";
import { SAMPLES } from "../src/samples";

const result = (id: string) => {
  const s = SAMPLES.find((x) => x.id === id);
  if (!s) throw new Error(`no sample ${id}`);
  const r = scanText(s.workflow, s.manifest);
  if (!r.ok) throw new Error(r.errors.map((e) => `${e.source}: ${e.message}`).join("; "));
  return r.report;
};

describe("samples", () => {
  it("copied invoices: catches the wrong client's credential and the leak it causes", () => {
    const r = result("copied-invoices");
    expect(r.verdict).toBe("fix");
    expect(r.findings.map((f) => f.ruleId)).toEqual(["RG102", "RG301", "RG401", "RG401"]);
  });

  it("shared AP agent: flags every category", () => {
    const r = result("shared-ap-agent");
    expect(r.verdict).toBe("fix");
    expect(new Set(r.findings.map((f) => f.category))).toEqual(new Set(["credentials", "client-ids", "cross-client", "approvals", "export"]));
    expect(r.findings.map((f) => f.ruleId)).toEqual(expect.arrayContaining(["RG105", "RG201", "RG302", "RG303", "RG304", "RG401", "RG402", "RG501"]));
  });

  it("reviewed bills: passes clean", () => {
    const r = result("reviewed-bills");
    expect(r.findings).toEqual([]);
    expect(r.verdict).toBe("clear");
  });
});

describe("scanText", () => {
  it("scans without a manifest", () => {
    const s = SAMPLES[0];
    if (!s) throw new Error("no samples");
    const r = scanText(s.workflow, "");
    expect(r.ok && r.report.hasManifest).toBe(false);
  });

  it("labels which input an error came from", () => {
    const r = scanText("{}", "tenants: [");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]?.source).toBe("workflow");
      expect(r.errors[1]?.source).toBe("manifest");
    }
  });
});
