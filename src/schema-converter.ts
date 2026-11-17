import { z } from 'zod';

interface ToolLike {
  description: string;
  parameters: z.ZodTypeAny;
}

export function toOllamaTools(tools: Record<string, ToolLike>) {
  return Object.entries(tools).map(([name, t]) => ({
    type: 'function' as const,
    function: {
      name,
      description: t.description,
      parameters: zodToJsonSchema(t.parameters),
    },
  }));
}

function parseObjectProperties(def: Record<string, unknown>): {
  properties: Record<string, unknown>;
  required: string[];
} {
  const shapeRaw = typeof def.shape === 'function' ? (def.shape as () => unknown)() : def.shape;
  const shape = (shapeRaw ?? {}) as Record<string, z.ZodTypeAny>;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, val] of Object.entries(shape)) {
    properties[key] = zodToJsonSchema(val);
    const node = val as unknown as { type?: string; _def?: { typeName?: string; defaultValue?: unknown }; def?: { defaultValue?: unknown } };
    const kind = node.type ?? node._def?.typeName?.replace(/^Zod/, '').toLowerCase() ?? '';
    const hasDefault = (node.def ?? node._def)?.defaultValue !== undefined;
    if (kind !== 'optional' && !hasDefault) required.push(key);
  }
  return { properties, required };
}

function parseConstraints(checks: Array<{ type?: string; kind?: string; value?: unknown; def?: { value?: unknown } }>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of checks) {
    const kind = c.type ?? c.kind;
    const val = c.value ?? c.def?.value;
    if (kind === 'min') out.minimum = val;
    if (kind === 'max') out.maximum = val;
    if (kind === 'int') out.type = 'integer';
  }
  return out;
}

export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const node = schema as unknown as { type?: string; _def?: { typeName?: string }; def?: Record<string, unknown> };
  const kind = node.type ?? node._def?.typeName?.replace(/^Zod/, '').toLowerCase() ?? '';
  const def = (node.def ?? (node as unknown as { _def?: Record<string, unknown> })._def ?? {}) as Record<string, unknown>;
  const inner = () => (def.innerType ?? def.type) as z.ZodTypeAny | undefined;

  switch (kind) {
    case 'object': {
      const { properties, required } = parseObjectProperties(def);
      return { type: 'object', properties, ...(required.length ? { required } : {}) };
    }
    case 'optional':
    case 'default':
      return inner() ? zodToJsonSchema(inner()!) : { type: 'string' };
    case 'nullable':
      return { anyOf: [inner() ? zodToJsonSchema(inner()!) : { type: 'string' }, { type: 'null' }] };
    case 'enum':
    case 'nativeenum':
      return { type: 'string', enum: Object.values((def.entries ?? def.values ?? {}) as object) };
    case 'literal':
      return { type: typeof def.value, enum: [def.value] };
    case 'string':
      return { type: 'string' };
    case 'number':
      return { type: 'number', ...parseConstraints((def.checks as any) ?? []) };
    case 'boolean':
      return { type: 'boolean' };
    case 'array':
      return { type: 'array', items: inner() ? zodToJsonSchema(inner()!) : {} };
    case 'union':
      return { anyOf: ((def.options as z.ZodTypeAny[]) ?? []).map((o) => zodToJsonSchema(o)) };
    default:
      return { type: 'string' };
  }
}
