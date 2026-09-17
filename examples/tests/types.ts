import type { Values, Execution } from "../../src/index.ts";
import { inspection } from "../02-native-question-schema.ts";
import type { ReturnAssessment } from "../07-zod-decision-schemas.ts";
import type { Assessment } from "../16-fulfillment-desk/domain.ts";

// Compile-only contracts: examples must teach actual literal inference rather than broad casts.
declare const native: Values<typeof inspection>;
const team: "electrical" | "mechanical" | "unknown" = native.category;
// @ts-expect-error A nondeclared option is not an inferred category.
const invented: "plumbing" = native.category;
declare const parsed: ReturnAssessment;
const damaged: boolean = parsed.damaged;
// @ts-expect-error The output transform does not return an integer.
const queue: number = parsed.reviewQueue;
declare const execution: Execution<Assessment>;
const action:
  | "request_carrier_update"
  | "verify_address"
  | "inspect_damage"
  | "manual_investigation" = execution.value.proposedAction;
void [team, invented, damaged, queue, action];
