export * as Cooking from "./cooking.js"

import { Schema } from "effect"
import { optional, NonNegativeInt, PositiveInt } from "./schema.js"
import { SessionID } from "./session-id.js"

const Text = Schema.Trim.check(Schema.isNonEmpty())
export interface Condition extends Schema.Schema.Type<typeof Condition> {}
export const Condition = Schema.Struct({
  type: Schema.Literals(["visual", "temperature", "audio"]),
  duration: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  condition: Text,
}).annotate({ identifier: "Cooking.Condition" })

export interface Step extends Schema.Schema.Type<typeof Step> {}
export const Step = Schema.Struct({
  action: Text,
  continuous: Schema.Boolean,
  seconds: NonNegativeInt,
  conditions: Schema.Array(Condition),
  logic: Schema.String,
}).annotate({ identifier: "Cooking.Step" })

export interface Plan extends Schema.Schema.Type<typeof Plan> {}
export const Plan = Schema.Struct({
  task_id: Text,
  revision: PositiveInt,
  dish: Text,
  recipe_text: Text,
  program: Text,
  actions: Text,
  steps: Schema.Array(Step).check(Schema.isNonEmpty()),
}).annotate({ identifier: "Cooking.Plan" })

export interface Completion extends Schema.Schema.Type<typeof Completion> {}
export const Completion = Schema.Struct({
  step: NonNegativeInt,
  reason: Schema.Literals(["confirmed", "sensor", "duration"]),
  time: Schema.Finite,
}).annotate({ identifier: "Cooking.Completion" })

export const Hazard = Schema.Literals(["fire", "burnt"])
export type Hazard = typeof Hazard.Type
export const MonitorState = Schema.Literals(["unavailable", "checking", "clear", "alert", "error"])
export const Monitoring = Schema.Struct({ fire: MonitorState, burnt: MonitorState })
export interface Emergency extends Schema.Schema.Type<typeof Emergency> {}
export const Emergency = Schema.Struct({
  id: Text,
  kind: Hazard,
  index: NonNegativeInt,
  steps: Schema.Array(Text).check(Schema.isNonEmpty()),
  interrupted_step: NonNegativeInt,
  time: Schema.Finite,
}).annotate({ identifier: "Cooking.Emergency" })

export interface Run extends Schema.Schema.Type<typeof Run> {}
export const Run = Schema.Struct({
  id: Text,
  session_id: Text,
  plan: Plan,
  status: Schema.Literals(["running", "paused", "completed", "stopped"]),
  index: NonNegativeInt,
  elapsed_ms: Schema.Finite,
  started_at: Schema.Finite,
  updated_at: Schema.Finite,
  completions: Schema.Array(Completion),
  warning: optional(Schema.String),
  display_request: optional(Schema.String),
  emergency: optional(Emergency),
  monitoring: optional(Monitoring),
  incidents: optional(
    Schema.Array(
      Schema.Struct({
        id: Text,
        kind: Hazard,
        step: NonNegativeInt,
        time: Schema.Finite,
        resolved_at: optional(Schema.Finite),
        superseded_by: optional(Text),
      }),
    ),
  ),
}).annotate({ identifier: "Cooking.Run" })

export interface Control extends Schema.Schema.Type<typeof Control> {}
export const Control = Schema.Struct({
  session_id: Text,
  run_id: Text,
  index: NonNegativeInt,
  emergency_id: optional(Text),
  emergency_index: optional(NonNegativeInt),
  action: Schema.Literals(["open", "confirm", "pause", "resume", "stop", "emergency_confirm", "emergency_resolve"]),
}).annotate({ identifier: "Cooking.Control" })

export interface Report extends Schema.Schema.Type<typeof Report> {}
export const Report = Schema.Struct({
  session_id: SessionID,
  run_id: Text,
}).annotate({ identifier: "Cooking.Report" })

export interface SpeechRequest extends Schema.Schema.Type<typeof SpeechRequest> {}
export const SpeechRequest = Schema.Struct({
  session_id: Text,
  run_id: Text,
  index: NonNegativeInt,
  kind: Schema.Literals(["step", "warning", "emergency"]),
  emergency_id: optional(Text),
  emergency_index: optional(NonNegativeInt),
}).annotate({ identifier: "Cooking.SpeechRequest" })

export type Speech = typeof Speech.Type
export const Speech = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ready"), audio: Text, voice: Text }),
  Schema.Struct({ status: Schema.Literals(["disabled", "obsolete"]) }),
]).annotate({ identifier: "Cooking.Speech" })

export class Invalid extends Schema.TaggedError<Invalid>()(
  "CookingInvalid",
  { message: Schema.String },
  {
    httpApiStatus: 400,
  },
) {}
