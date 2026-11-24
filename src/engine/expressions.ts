// n8n stores an expression as a string that starts with "=". Static analysis can't run it,
// but it can tell where the value comes from: the model, the incoming item, or a named node.

// Returns boolean rather than a type guard: a guard would narrow a plain string to `never`
// on the false branch.
export const isExpression = (v: unknown): boolean => typeof v === "string" && v.startsWith("=") && v.includes("{{");

const NAMED_REF = /\$\(\s*(['"`])((?:(?!\1).)+)\1\s*\)|\$node\[\s*(['"`])((?:(?!\3).)+)\3\s*\]|\$items\(\s*(['"`])((?:(?!\5).)+)\5/g;

export function referencedNodes(expr: string): string[] {
  const names = new Set<string>();
  for (const m of expr.matchAll(NAMED_REF)) {
    const name = m[2] ?? m[4] ?? m[6];
    if (name) names.add(name);
  }
  return [...names];
}

export const usesFromAI = (expr: string) => /\$fromAI\s*\(/.test(expr);

/** True when the value comes from the item flowing into the node rather than a named node. */
export const usesIncomingItem = (expr: string) => /\$json\b|\$input\b|\$binary\b|\$item\b/.test(expr);

/** Every string leaf in a parameter tree, with a dotted path for messages. */
export function* stringLeaves(value: unknown, path = ""): Generator<[string, string]> {
  if (typeof value === "string") yield [path, value];
  else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield* stringLeaves(value[i], `${path}[${String(i)}]`);
  } else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) yield* stringLeaves(v, path ? `${path}.${k}` : k);
  }
}
