// n8n stores an expression as a string that starts with "=". Static analysis can't run it,
// but it can tell where the value comes from: the model, the incoming item, or a named node.

// Returns boolean rather than a type guard: a guard would narrow a plain string to `never`
// on the false branch.
export const isExpression = (v: unknown): boolean => typeof v === "string" && v.startsWith("=") && v.includes("{{");

// Quoted names may hold escaped quotes: $('Client\'s data').
const NAMED_REF = /\$\(\s*(['"`])((?:\\.|(?!\1)[^\\])+)\1\s*\)|\$node\[\s*(['"`])((?:\\.|(?!\3)[^\\])+)\3\s*\]|\$items\(\s*(['"`])((?:\\.|(?!\5)[^\\])+)\5/g;

const unescape = (s: string) => s.replace(/\\(.)/g, "$1");

export function referencedNodes(expr: string): string[] {
  const names = new Set<string>();
  for (const m of expr.matchAll(NAMED_REF)) {
    const name = m[2] ?? m[4] ?? m[6];
    if (name) names.add(unescape(name));
  }
  return [...names];
}

const SELECTION = /\$\(\s*(['"`])((?:\\.|(?!\1)[^\\])+)\1\s*\)\s*\.\s*(item|first\(\s*\)|last\(\s*\)|all\(\s*\)\s*\[\s*\d+\s*\]|itemMatching\(\s*\d+\s*\))|\$node\[\s*(['"`])((?:\\.|(?!\4)[^\\])+)\4\s*\]/g;

/**
 * Which item of each named node an expression reads: `item`, `first()`, `last()`, `all()[2]`.
 * A reference with no recognizable selector reads "?", which never matches another read.
 */
export function itemSelections(expr: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (name: string, pick: string) => out.set(name, (out.get(name) ?? new Set()).add(pick));
  for (const m of expr.matchAll(SELECTION)) {
    if (m[2] !== undefined) add(unescape(m[2]), (m[3] ?? "").replace(/\s+/g, ""));
    else if (m[5] !== undefined) add(unescape(m[5]), "item");
  }
  for (const name of referencedNodes(expr)) if (!out.has(name)) add(name, "?");
  return out;
}

export const usesFromAI = (expr: string) => /\$fromAI\s*\(/.test(expr);

/** True when the value comes from the item flowing into the node rather than a named node. */
export const usesIncomingItem = (expr: string) => /\$json\b|\$input\b|\$binary\b|\$item\b/.test(expr);

/**
 * Every string in a parameter tree, in document order. Walks with its own stack: a file well
 * under 5 MB can nest arrays 20,000 deep, which overflows the call stack when recursing.
 */
export function* stringLeaves(value: unknown): Generator<string> {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === "string") yield v;
    else if (Array.isArray(v)) for (let i = v.length - 1; i >= 0; i--) stack.push(v[i]);
    else if (typeof v === "object" && v !== null) {
      const values = Object.values(v);
      for (let i = values.length - 1; i >= 0; i--) stack.push(values[i]);
    }
  }
}
