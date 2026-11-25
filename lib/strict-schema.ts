// Shared by the photo readers; no imports, so tests can load it directly.

/** Strict tool use wants every object closed: no properties beyond the ones listed. */
export function strictSchema(schema: unknown): Record<string, unknown> {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = walk(v);
    const type = out.type;
    const isObject = type === "object" || (Array.isArray(type) && type.includes("object"));
    if (isObject && out.properties && out.additionalProperties === undefined) out.additionalProperties = false;
    return out;
  };
  return walk(schema) as Record<string, unknown>;
}
