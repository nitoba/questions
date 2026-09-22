import type * as z from "zod/v4/core";
import * as Schema from "../schema.ts";
import type { SchemaField, SchemaPath } from "../diagnostics.ts";
import type { Outcome } from "../policy.ts";
import { ValidationError } from "../errors.ts";
import { plan } from "./schema-compiler.ts";
import { reference, type Owner } from "./policy-condition.ts";

/** @internal Preserve input paths. No transform, presence inference or user callback is guessed. */
export function schemaReferences(
  schema: Schema.Type,
  owner: Owner,
): {
  readonly compiled: Schema.Compiled<Schema.Type>;
  readonly references: unknown;
} {
  const active = new Set<Schema.Type>();
  function validate(node: Schema.Type, path: SchemaPath): void {
    const location = `policy.schema${JSON.stringify(path)}`;
    if (active.has(node) || active.size >= 100)
      throw new ValidationError("recursive or excessively nested policy schema", location);
    active.add(node);
    try {
      const def = (node as z.$ZodTypes)._zod.def;
      if (def.checks?.some((check) => check._zod.def.check === "overwrite"))
        throw new ValidationError("overwrite transforms cannot define policy evidence", location);
      switch (def.type) {
        case "readonly":
          validate(def.innerType, path);
          break;
        case "object":
          for (const [key, child] of Object.entries(def.shape)) validate(child, [...path, key]);
          break;
        case "tuple":
          if (def.rest)
            throw new ValidationError("policy tuples must have a fixed length", location);
          def.items.forEach((child, index) => validate(child, [...path, index]));
          break;
        case "union":
          for (const child of def.options) validate(child, path);
          break;
        case "boolean":
        case "enum":
        case "literal":
        case "number":
        case "string":
        case "null":
        case "undefined":
          break;
        default:
          throw new ValidationError(
            `Zod ${def.type} is not supported in policies; use required, shape-preserving decisions or ask(schema)`,
            location,
          );
      }
    } finally {
      active.delete(node);
    }
  }
  validate(schema, []);
  const compiled = Schema.compile(schema);
  const fields = new Map<string, SchemaField>();
  for (const field of compiled.fields) {
    if (field.role !== "value")
      throw new ValidationError(
        "presence decisions are not supported in policies",
        "policy.schema",
      );
    if (field.annotations.kind === "probability")
      throw new ValidationError(
        "use a boolean schema and .is(true) for probability cutoffs",
        "policy.schema",
      );
    fields.set(JSON.stringify(field.path), field);
  }
  function walk(original: Schema.Type, path: SchemaPath): unknown {
    let node = original;
    while ((node as z.$ZodTypes)._zod.def.type === "readonly")
      node = (node as z.$ZodReadonly)._zod.def.innerType;
    const def = (node as z.$ZodTypes)._zod.def;
    if (def.type === "object")
      return Object.freeze(
        Object.fromEntries(
          Object.entries(def.shape).map(([key, child]) => [key, walk(child, [...path, key])]),
        ),
      );
    if (def.type === "tuple")
      return Object.freeze(def.items.map((child, index) => walk(child, [...path, index])));
    const field = fields.get(JSON.stringify(path));
    if (field)
      return reference(
        owner,
        Object.freeze({
          id: field.questionId,
          path: field.path,
          question: field.question,
          ...(field.choices === undefined ? {} : { choices: field.choices }),
        }),
      );
    // Constants require neither inference nor parsing callbacks. Reuse the finite compiler's reader.
    const constant = plan(original);
    if (Object.keys(constant.questions).length !== 0)
      throw new ValidationError("cannot associate schema input with its evidence", "policy.schema");
    return reference(
      owner,
      Object.freeze({ path: Object.freeze(path), value: constant.read({}, 0) as Outcome }),
    );
  }
  return { compiled, references: walk(schema, []) };
}
