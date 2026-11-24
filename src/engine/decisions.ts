import { isExpression, referencedNodes, usesIncomingItem } from "./expressions";
import type { WorkflowNode } from "./types";

// An approval step only protects a write when a later IF, Filter or Switch looks at the
// person's answer and the write hangs off the branch that means yes. This module reads those
// nodes' conditions (every format n8n has exported since IF v1) and says which outputs can
// only carry approved items.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** How a check reads the answer. Unknown means it reads it, but not in a way we can sign. */
type Polarity = "approved" | "declined" | "unknown";

interface Condition {
  left: unknown;
  right: unknown;
  op: string;
}

interface Group {
  conditions: Condition[];
  /** OR instead of AND. */
  any: boolean;
}

/**
 * Where an approval step puts the person's answer. Send and Wait returns `data.approved`, or
 * `data.text` for a free-text reply; forms return one field per question, keyed by label or
 * field name. Returns an empty list when the shape isn't knowable from the export.
 */
export function answerKeys(gate: WorkflowNode): string[] {
  const p = gate.parameters;
  const fields = formFieldKeys(p);
  if (p.operation === "sendAndWait") {
    const kind = str(p.responseType) ?? "approval";
    if (kind === "approval") return ["approved"];
    if (kind === "freeText") return ["text"];
    return fields;
  }
  return fields;
}

function formFieldKeys(p: Obj): string[] {
  const values = isObj(p.formFields) ? p.formFields.values : undefined;
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const f of values) {
    if (!isObj(f)) continue;
    for (const k of ["fieldName", "fieldLabel"]) {
      const v = str(f[k])?.trim();
      if (v) out.push(v);
    }
  }
  return out;
}

// Used when the answer's shape can't be read from the export (a webhook resume, gotoHuman).
const GENERIC_ANSWER = /approv|reject|declin|deny|denied|decision/i;

/**
 * True for an expression that reads this gate's answer: it names an answer field, and it reads
 * either the gate by name or the incoming item without naming another node. `$('Policy')
 * .item.json.approved` is some other step's flag, and a literal "approved" is just a value.
 */
function readsAnswer(keys: string[], gate: string): (s: string) => boolean {
  const tests = keys.map((k) => (/^\w+$/.test(k) ? (s: string) => new RegExp(`\\b${k}\\b`).test(s) : (s: string) => s.includes(k)));
  const namesField = keys.length === 0 ? (s: string) => GENERIC_ANSWER.test(s) : (s: string) => tests.some((t) => t(s));
  return (s) => {
    if (!isExpression(s) || !namesField(s)) return false;
    const refs = referencedNodes(s);
    return refs.includes(gate) || (refs.length === 0 && usesIncomingItem(s));
  };
}

const POSITIVE = new Set(["true", "equals", "equal", "exists", "contains", "startsWith", "endsWith", "regex", "notEmpty", "isNotEmpty"]);
const NEGATIVE = new Set(["false", "notEquals", "notEqual", "notExists", "notContains", "notStartsWith", "notEndsWith", "notRegex", "empty", "isEmpty"]);
// Only "is true" and "is false" say which way the answer went. "Exists" and "is empty" hold for
// a no as well as a yes.
const PRESENCE = new Set(["exists", "notExists", "empty", "notEmpty", "isEmpty", "isNotEmpty"]);

function valuePolarity(v: unknown): 1 | -1 | 0 {
  if (typeof v === "boolean") return v ? 1 : -1;
  if (typeof v !== "string") return 0;
  let t = v.trim();
  if (t.startsWith("=")) t = t.slice(1).trim();
  t = (/^\{\{([\s\S]*)\}\}$/.exec(t)?.[1] ?? t).trim();
  t = t.replace(/^(['"`])(.*)\1$/, "$2").trim().toLowerCase();
  if (/^(true|yes|y|approved?|accept(ed)?|ok(ay)?)$/.test(t)) return 1;
  if (/^(false|no|n|reject(ed)?|deny|denied|declined?|disapproved?|cancel(l?ed)?)$/.test(t)) return -1;
  return 0;
}

// A bare property read such as `={{ $json.data.approved }}` or `={{ $('Approve').item.json["Decision"] }}`.
// Anything more (`!x`, `x == false`, a ternary, a function call) can flip the meaning, so a
// condition built on it reads the answer but isn't signed.
const PLAIN_READ =
  /^=\s*\{\{\s*\$(?:json|input\.(?:item|first\(\)|last\(\))\.json|\(\s*(['"`])[^'"`]+\1\s*\)\.(?:item|first\(\)|last\(\))\.json|node\[\s*(['"`])[^'"`]+\2\s*\]\.json)(?:\.[A-Za-z_$][\w$]*|\[\s*(['"`])[^'"`]*\3\s*\]|\[\d+\])*\s*\}\}\s*$/;

/** Undefined when the condition doesn't look at the answer at all. */
function polarity(c: Condition, reads: (s: string) => boolean): Polarity | undefined {
  const leftReads = typeof c.left === "string" && reads(c.left);
  const rightReads = typeof c.right === "string" && reads(c.right);
  if (!leftReads && !rightReads) return undefined;
  const side = leftReads ? c.left : c.right;
  if (typeof side !== "string" || !PLAIN_READ.test(side.trim())) return "unknown";
  const sign = POSITIVE.has(c.op) ? 1 : NEGATIVE.has(c.op) ? -1 : 0;
  if (sign === 0 || PRESENCE.has(c.op)) return "unknown";
  const value = leftReads ? c.right : c.left;
  let vp = c.op === "true" || c.op === "false" ? 1 : valuePolarity(value);
  // "Decision equals Send it" reads as choosing that option; a negated unknown value doesn't.
  if (vp === 0) vp = sign === 1 && typeof value === "string" && value.trim() !== "" ? 1 : 0;
  if (vp === 0) return "unknown";
  return sign * vp > 0 ? "approved" : "declined";
}

/** Outputs of an IF-shaped check that carry only approved items: 0 is true, 1 is false. */
function groupApproved(g: Group, reads: (s: string) => boolean): Set<number> | undefined {
  const pol = g.conditions.map((c) => polarity(c, reads));
  if (pol.every((p) => p === undefined)) return undefined;
  const out = new Set<number>();
  if (g.any) {
    // True when any condition holds, so only an OR made entirely of yes-checks means yes. False
    // means every condition failed, including a check for "declined", which means yes.
    if (pol.every((p) => p === "approved")) out.add(0);
    if (pol.some((p) => p === "declined")) out.add(1);
  } else {
    if (pol.some((p) => p === "approved")) out.add(0);
    if (pol.length === 1 && pol[0] === "declined") out.add(1);
  }
  return out;
}

const V1_DEFAULTS: Record<string, { op: string; value: unknown }> = {
  boolean: { op: "equal", value: false },
  string: { op: "equal", value: "" },
  number: { op: "smaller", value: 0 },
  dateTime: { op: "after", value: "" },
};

/** IF and Filter conditions, version 2 and later (`conditions.conditions`) or version 1 (typed lists). */
function readGroup(conditions: unknown, combineOperation: unknown): Group | undefined {
  if (!isObj(conditions)) return undefined;
  if (Array.isArray(conditions.conditions)) {
    const list = conditions.conditions.filter(isObj).map((c) => ({
      left: c.leftValue,
      right: c.rightValue,
      op: str(isObj(c.operator) ? c.operator.operation : undefined) ?? "equals",
    }));
    return { conditions: list, any: conditions.combinator === "or" };
  }
  const list: Condition[] = [];
  for (const [type, d] of Object.entries(V1_DEFAULTS)) {
    const items = conditions[type];
    if (!Array.isArray(items)) continue;
    for (const c of items.filter(isObj)) list.push({ left: c.value1, right: "value2" in c ? c.value2 : d.value, op: str(c.operation) ?? d.op });
  }
  return { conditions: list, any: combineOperation === "any" };
}

/**
 * For a decision node, the outputs that carry only items the person approved, given the
 * approval step and where it puts its answer. Undefined when the node doesn't look at that
 * answer, so it protects none of its branches.
 */
export function approvedOutputs(decision: WorkflowNode, keys: string[], gate: string): Set<number> | undefined {
  const reads = readsAnswer(keys, gate);
  const p = decision.parameters;
  if (decision.type === "n8n-nodes-base.if" || decision.type === "n8n-nodes-base.filter") {
    const g = readGroup(p.conditions, p.combineOperation);
    const out = g ? groupApproved(g, reads) : undefined;
    // With "continue on error", items whose check failed come out of the false output.
    if (out && decision.errorsContinue) out.delete(1);
    return out;
  }
  if (decision.type !== "n8n-nodes-base.switch") return undefined;
  const out = switchApproved(decision, reads);
  if (!out) return undefined;
  // Unmatched items go to a numbered fallback output, and failed ones to the first output.
  const options = isObj(p.options) ? p.options : {};
  const fallback = decision.typeVersion >= 3 ? options.fallbackOutput : p.fallbackOutput;
  if (typeof fallback === "number") out.delete(fallback);
  if (decision.errorsContinue) out.delete(0);
  return out;
}

function switchApproved(decision: WorkflowNode, reads: (s: string) => boolean): Set<number> | undefined {
  const p = decision.parameters;
  if (p.mode === "expression") {
    // The output number is computed, so no branch can be trusted to mean yes.
    const expr = str(p.output);
    return expr !== undefined && reads(expr) ? new Set() : undefined;
  }
  const rules = isObj(p.rules) ? p.rules : {};
  let seen = false;
  const out = new Set<number>();
  if (Array.isArray(rules.values)) {
    // Version 3 and later: one output per rule, in order.
    rules.values.forEach((rule, i) => {
      const g = isObj(rule) ? readGroup(rule.conditions, undefined) : undefined;
      const approved = g ? groupApproved(g, reads) : undefined;
      if (approved) seen = true;
      if (approved?.has(0)) out.add(i);
    });
  } else if (Array.isArray(rules.rules)) {
    // Versions 1 and 2 compare one value against each rule. Version 1 sends a match to the
    // rule's output field; version 2 ignores that field and uses the rule's position.
    const d = V1_DEFAULTS[str(p.dataType) ?? "number"] ?? { op: "equal", value: "" };
    const approvedBy = new Map<number, boolean>();
    for (const [i, rule] of rules.rules.entries()) {
      if (!isObj(rule)) continue;
      const output = decision.typeVersion >= 2 ? i : typeof rule.output === "number" ? rule.output : 0;
      const pol = polarity({ left: p.value1, right: "value2" in rule ? rule.value2 : d.value, op: str(rule.operation) ?? d.op }, reads);
      if (pol !== undefined) seen = true;
      // Several rules can share an output; it means yes only if every one of them does.
      approvedBy.set(output, (approvedBy.get(output) ?? true) && pol === "approved");
    }
    for (const [output, yes] of approvedBy) if (yes) out.add(output);
  }
  return seen ? out : undefined;
}
