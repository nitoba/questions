import * as z from "zod/v4/core";
import * as Question from "../question.ts";
import type { AnyAnswer } from "../answer.ts";
import { requireConfidence } from "../decision.ts";
import { ValidationError } from "../errors.ts";
import { metadata, type Resolved } from "../schema-annotations.ts";
import { record } from "./validation.ts";

/** @internal Project only selected branches, applying confidence before any Zod callback. */
export type Read = (answers: Readonly<Record<string, AnyAnswer>>, confidence: number) => unknown;
/** @internal Immutable finite-question plan. */
export interface Plan {
  readonly questions: Readonly<Record<string, Question.AnyQuestion>>;
  readonly read: Read;
}
const OMIT = Symbol("absent schema field");
type Primitive = string | number | boolean | null | undefined;
interface Option {
  readonly value: Primitive;
  readonly description?: string;
  readonly confidence?: number;
}

function merge(inner: Resolved, outer: Resolved): Resolved {
  const confidence = Math.max(inner.confidence ?? 0, outer.confidence ?? 0);
  return { ...inner, ...outer, confidence };
}

function guidance(meta: Resolved): string[] {
  return [
    ...(meta.title ? [meta.title] : []),
    ...(meta.description ? [meta.description] : []),
    ...(meta.examples ? [`Examples: ${JSON.stringify(meta.examples)}`] : []),
  ];
}

function fail(message: string, path: string): never {
  throw new ValidationError(message, path);
}

function primitive(value: unknown, path: string): Primitive {
  if (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  )
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return fail("only finite JSON primitive literals and undefined can be decision options", path);
}

/** @internal Walk the Zod 4 core definition, never `instanceof` a Classic/Mini subclass. */
export function plan(schema: z.$ZodType): Plan {
  const entries: [string, Question.AnyQuestion][] = [];
  const active = new Set<z.$ZodType>();

  function emit(
    question: Question.AnyQuestion,
    meta: Resolved,
    project: (answer: AnyAnswer) => unknown,
  ): Read {
    const key = `q${entries.length}`;
    entries.push([key, question]);
    return (answers, minimum) => {
      const answer = answers[key]!;
      const threshold = Math.max(meta.confidence ?? 0, minimum);
      if (threshold > 0) requireConfidence(answer, threshold, question.instructions);
      return project(answer);
    };
  }

  function finiteOptions(
    node: z.$ZodType,
    path: string,
    parents = new Set<z.$ZodType>(),
  ): Option[] {
    if (parents.has(node) || parents.size >= 100)
      return fail("recursive or excessively nested decision options", path);
    parents.add(node);
    try {
      const def = (node as z.$ZodTypes)._zod.def;
      const meta = metadata(node, path);
      if (meta.levels !== undefined || meta.kind === "probability" || meta.kind === "score")
        fail("finite union alternatives cannot use probability or score annotations", path);
      if ((meta.kind === "boolean" || meta.criteria !== undefined) && def.type !== "boolean")
        fail("only boolean union alternatives can use boolean criteria", path);
      const description = [
        ...guidance(meta),
        ...(meta.instructions ? [meta.instructions] : []),
      ].join("\n");
      const wrap = (value: unknown): Option => ({
        value: primitive(value, path),
        ...(description ? { description } : {}),
        confidence: meta.confidence ?? 0,
      });
      let options: Option[];
      switch (def.type) {
        case "literal":
          options = def.values.map(wrap);
          break;
        case "enum":
          options = z.util.getEnumValues(def.entries).map(wrap);
          break;
        case "boolean":
          options = [wrap(true), wrap(false)].map((option) => ({
            ...option,
            description: [option.description, meta.criteria?.[option.value ? "true" : "false"]]
              .filter(Boolean)
              .join("\n"),
          }));
          break;
        case "null":
          options = [wrap(null)];
          break;
        case "undefined":
          options = [wrap(undefined)];
          break;
        case "union":
          options = def.options.flatMap((option, index) =>
            finiteOptions(option, `${path}.union[${index}]`, parents).map((child) => ({
              ...child,
              description: [description, child.description].filter(Boolean).join("\n"),
              confidence: Math.max(meta.confidence ?? 0, child.confidence ?? 0),
            })),
          );
          break;
        default:
          return fail(
            "unions must contain only booleans, enums or primitive literals; object unions are not finite decisions",
            path,
          );
      }
      for (const key of Object.keys(meta.options ?? {})) {
        if (!options.some(({ value }) => typeof value === "string" && value === key))
          fail(
            "option description does not match a declared string value",
            `${path}.options[${JSON.stringify(key)}]`,
          );
      }
      return options.map((option) => ({
        ...option,
        description: [
          option.description,
          typeof option.value === "string" && Object.hasOwn(meta.options ?? {}, option.value)
            ? meta.options![option.value]
            : undefined,
        ]
          .filter(Boolean)
          .join("\n"),
      }));
    } finally {
      parents.delete(node);
    }
  }

  function choice(options: Option[], instructions: string, meta: Resolved, path: string): Read {
    if (meta.kind !== undefined && meta.kind !== "choice")
      fail("this schema requires choice annotations", path);
    if (meta.criteria !== undefined || meta.levels !== undefined)
      fail("choice schemas accept options, not boolean criteria or score levels", path);
    const byValue = new Map<Primitive, Option>();
    for (const option of options) {
      const previous = byValue.get(option.value);
      byValue.set(
        option.value,
        previous
          ? {
              value: option.value,
              description: [previous.description, option.description].filter(Boolean).join("\n"),
              confidence: Math.max(previous.confidence ?? 0, option.confidence ?? 0),
            }
          : option,
      );
    }
    const distinct = [...byValue.values()];
    if (distinct.length === 0)
      return fail("a choice must declare at least one possible value", path);
    const labels = meta.options === undefined ? {} : record(meta.options, `${path}.options`);
    for (const key of Object.keys(labels)) {
      if (!distinct.some(({ value }) => typeof value === "string" && value === key)) {
        fail(
          "option description does not match a declared string value",
          `${path}.options[${JSON.stringify(key)}]`,
        );
      }
    }
    if (distinct.length === 1) return () => distinct[0]!.value;
    const criteria = Object.fromEntries(
      distinct.map((option, index) => {
        const label =
          option.value === undefined ? "undefined (no value)" : JSON.stringify(option.value);
        const extra =
          typeof option.value === "string" && Object.hasOwn(labels, option.value)
            ? labels[option.value]
            : option.description;
        return [
          `o${index}`,
          extra === undefined || extra === null
            ? label
            : `${label}: ${typeof extra === "string" ? extra : JSON.stringify(extra)}`,
        ];
      }),
    );
    return emit(Question.choice(instructions, criteria), meta, (answer) => {
      if (answer.type !== "choice") return fail("expected choice evidence", path);
      const selected = distinct[Number(answer.choice.slice(1))]!;
      if ((selected.confidence ?? 0) > 0)
        requireConfidence(answer, selected.confidence!, instructions);
      return selected.value;
    });
  }

  function walk(
    node: z.$ZodType,
    path: string,
    context: readonly string[],
    inherited: Resolved = {},
  ): Read {
    if (active.has(node))
      return fail("recursive schemas cannot be represented by a finite question batch", path);
    if (active.size >= 100) return fail("schema nesting exceeds 100 levels", path);
    active.add(node);
    try {
      const meta = merge(metadata(node, path), inherited);
      const def = (node as z.$ZodTypes)._zod.def;
      const instructions = [
        ...context,
        `Field: ${path}`,
        ...guidance(meta),
        meta.instructions ??
          meta.description ??
          `Determine the value of ${path} from the supplied context.`,
      ].join("\n");
      switch (def.type) {
        case "pipe":
          return walk(def.in, path, context, meta);
        case "readonly":
        case "catch":
        case "nonoptional":
          return walk(def.innerType, path, context, meta);
        case "lazy":
          return walk(def.getter(), path, context, meta);
        case "optional":
        case "nullable":
        case "default":
        case "prefault": {
          const absent = def.type === "nullable" ? null : OMIT;
          const presence = emit(
            Question.boolean(
              `${instructions}\nPresence check: does the context provide a value for this field, rather than ${absent === null ? "null" : "leaving it absent"}?`,
            ),
            { confidence: meta.confidence ?? 0 },
            (answer) => answer.type === "boolean" && answer.probability >= 0.5,
          );
          const inner = walk(def.innerType, path, context, meta);
          return (answers, minimum) =>
            presence(answers, minimum) ? inner(answers, minimum) : absent;
        }
        case "object": {
          if (Object.hasOwn(def.shape, "__proto__"))
            fail(
              "Zod object parsers discard __proto__ fields; choose a different field name",
              `${path}["__proto__"]`,
            );
          if (
            meta.kind !== undefined ||
            meta.criteria !== undefined ||
            meta.options !== undefined ||
            meta.levels !== undefined
          )
            fail(
              "object annotations may describe the object or set confidence, not define a leaf decision",
              path,
            );
          const children = Object.entries(def.shape).map(
            ([key, child]) =>
              [
                key,
                walk(
                  child,
                  `${path}[${JSON.stringify(key)}]`,
                  [
                    ...context,
                    ...guidance(meta),
                    ...(meta.instructions ? [meta.instructions] : []),
                  ],
                  { confidence: meta.confidence ?? 0 },
                ),
              ] as const,
          );
          return (answers, minimum) =>
            Object.fromEntries(
              children.flatMap(([key, read]) => {
                const value = read(answers, minimum);
                return value === OMIT ? [] : [[key, value]];
              }),
            );
        }
        case "tuple": {
          if (def.rest) fail("variable-length tuples are not supported; use a fixed tuple", path);
          if (
            meta.kind !== undefined ||
            meta.criteria !== undefined ||
            meta.options !== undefined ||
            meta.levels !== undefined
          )
            fail("tuple annotations cannot define a leaf decision", path);
          const children = def.items.map((child, index) =>
            walk(
              child,
              `${path}[${index}]`,
              [...context, ...guidance(meta), ...(meta.instructions ? [meta.instructions] : [])],
              { confidence: meta.confidence ?? 0 },
            ),
          );
          return (answers, minimum) =>
            children.map((read) => {
              const value = read(answers, minimum);
              return value === OMIT ? undefined : value;
            });
        }
        case "boolean": {
          if (meta.kind !== undefined && meta.kind !== "boolean")
            fail("boolean schemas require boolean annotations", path);
          if (meta.options !== undefined || meta.levels !== undefined)
            fail("boolean schemas accept criteria, not options or levels", path);
          return emit(
            Question.boolean(instructions, meta.criteria),
            meta,
            (answer) => answer.type === "boolean" && answer.probability >= 0.5,
          );
        }
        case "number": {
          if (meta.options !== undefined)
            fail(
              "number schemas use probability or score annotations; use literal unions for discrete numbers",
              path,
            );
          if (meta.kind === "probability") {
            if (meta.levels !== undefined) fail("probabilities do not have score levels", path);
            return emit(Question.boolean(instructions, meta.criteria), meta, (answer) => {
              if (answer.type !== "boolean") return fail("expected boolean evidence", path);
              return answer.probability;
            });
          }
          if (meta.kind === "score") {
            if (meta.criteria !== undefined) fail("scores use levels, not boolean criteria", path);
            const question = Question.score(instructions, meta.levels!);
            return emit(question, meta, (answer) => {
              if (answer.type !== "score") return fail("expected score evidence", path);
              return answer.score;
            });
          }
          return fail(
            'number schemas require { kind: "probability" } or { kind: "score", levels: [...] } annotations',
            path,
          );
        }
        case "string": {
          if (meta.options === undefined)
            return fail(
              "free-form strings cannot be generated by this decision protocol; use z.enum() or explicit choice options",
              path,
            );
          return choice(
            Object.keys(record(meta.options, `${path}.options`)).map((value) => ({ value })),
            instructions,
            meta,
            path,
          );
        }
        case "literal":
        case "enum":
        case "union":
        case "null":
        case "undefined":
          return choice(finiteOptions(node, path), instructions, meta, path);
        default:
          return fail(`Zod ${def.type} is not supported by the finite decision protocol`, path);
      }
    } finally {
      active.delete(node);
    }
  }
  const read = walk(schema, "$", []);
  return {
    questions: Object.freeze(Object.fromEntries(entries)),
    read: (answers, minimum) => {
      const value = read(answers, minimum);
      return value === OMIT ? undefined : value;
    },
  };
}
