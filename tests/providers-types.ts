/** Compile-only contracts: the installed official SDK remains structurally compatible. */
import { createGateway } from "@ai-sdk/gateway";
import { Questions, TypeSafe, SystemOne, type QuestionModel } from "../src/index.ts";
import { z } from "zod";
import * as AISDK from "../src/providers/ai-sdk.ts";
import * as Vercel from "../src/providers/vercel.ts";

const gateway = createGateway({ apiKey: "compile-only" });
const sdkModel: AISDK.EvaluationModel = gateway.evaluationModel("typesafe-ai/jev");
const models: QuestionModel[] = [
  AISDK.create({ model: sdkModel }),
  Vercel.create({ apiKey: "compile-only" }),
  TypeSafe.create({ apiKey: "compile-only" }),
  SystemOne.create({ baseURL: "http://localhost:8000/v1", model: "local" }),
];
// @ts-expect-error a chat model does not implement evaluation
AISDK.create({ model: gateway("typesafe-ai/jev") });
// @ts-expect-error gateway confidence cannot be a made-up policy name
Vercel.create({ apiKey: "compile-only", confidence: "entropy" });
// @ts-expect-error the generic System One host requires a model
SystemOne.create({ baseURL: "https://host.test" });
const schema = z.object({ route: z.enum(["a", "b"]) }).transform((value) => ({ id: value.route }));
const output = await Questions.create({ model: models[0]! }).about("x").ask(schema);
const id: "a" | "b" = output.id;
// @ts-expect-error transforms preserve their output shape with any provider
void output.route;
void id;
