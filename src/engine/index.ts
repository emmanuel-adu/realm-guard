import { parseManifest } from "./manifest";
import { scan } from "./scan";
import type { Report } from "./types";
import { parseWorkflow } from "./workflow";

export { draftManifest, parseManifest } from "./manifest";
export { reportToMarkdown } from "./markdown";
export { scan } from "./scan";
export type * from "./types";
export { parseWorkflow } from "./workflow";

export interface InputError {
  source: "workflow" | "manifest";
  message: string;
}

export type ScanTextResult = { ok: true; report: Report; warnings: string[] } | { ok: false; errors: InputError[] };

/** Parses both inputs and scans. A blank manifest means "scan without one". */
export function scanText(workflowText: string, manifestText: string): ScanTextResult {
  const errors: InputError[] = [];
  const w = parseWorkflow(workflowText);
  if (!w.ok) errors.push(...w.errors.map((message) => ({ source: "workflow" as const, message })));
  const m = manifestText.trim() ? parseManifest(manifestText) : undefined;
  if (m && !m.ok) errors.push(...m.errors.map((message) => ({ source: "manifest" as const, message })));
  if (!w.ok || (m && !m.ok)) return { ok: false, errors };
  return { ok: true, report: scan(w.value, m?.value), warnings: [...w.warnings, ...(m?.warnings ?? [])] };
}
