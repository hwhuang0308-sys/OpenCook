export * as Kitchen from "./kitchen.js"

import { Schema } from "effect"
import { optional, PositiveInt } from "./schema.js"

export const ModelRole = Schema.Literals(["chat", "vision", "speech", "embedding", "rerank"])
export type ModelRole = typeof ModelRole.Type
export const modelRoles = ModelRole.literals
export const DeviceID = Schema.Literals(["camera", "temperature", "sound", "air"])
export type DeviceID = typeof DeviceID.Type
export const deviceIDs = DeviceID.literals

export interface ModelProfile extends Schema.Schema.Type<typeof ModelProfile> {}
export const ModelProfile = Schema.Struct({
  enabled: Schema.Boolean,
  base_url: Schema.String,
  model: Schema.String,
  context: PositiveInt,
  output: PositiveInt,
  voice: optional(Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(100))),
  speed: optional(Schema.Finite.check(Schema.isBetween({ minimum: 0.25, maximum: 4 }))),
}).annotate({ identifier: "Kitchen.ModelProfile" })

// Only the private configuration file contains keys; Settings responses use ModelView.
export const ModelConfig = Schema.Record(
  ModelRole,
  Schema.optionalKey(
    Schema.Struct({
      ...ModelProfile.fields,
      api_key: optional(Schema.String),
    }),
  ),
)
export type ModelConfig = typeof ModelConfig.Type

export interface ModelView extends Schema.Schema.Type<typeof ModelView> {}
export const ModelView = Schema.Struct({
  ...ModelProfile.fields,
  has_key: Schema.Boolean,
  source: Schema.Literals(["user", "environment", "unconfigured"]),
}).annotate({ identifier: "Kitchen.ModelView" })

export interface Serial extends Schema.Schema.Type<typeof Serial> {}
export const Serial = Schema.Struct({
  enabled: Schema.Boolean,
  port: Schema.String,
  baud_rate: PositiveInt,
  timeout_ms: PositiveInt,
  sample_period_ms: PositiveInt,
  buffer_seconds: PositiveInt,
}).annotate({ identifier: "Kitchen.Serial" })

export interface Camera extends Schema.Schema.Type<typeof Camera> {}
export const Camera = Schema.Struct({
  enabled: Schema.Boolean,
  rtsp_url: Schema.String,
  buffer_frames: PositiveInt,
  ffmpeg_path: Schema.String,
}).annotate({ identifier: "Kitchen.Camera" })

export interface Devices extends Schema.Schema.Type<typeof Devices> {}
export const Devices = Schema.Struct({
  camera: Camera,
  temperature: Serial,
  sound: Serial,
  air: Serial,
}).annotate({ identifier: "Kitchen.Devices" })

export interface Recording extends Schema.Schema.Type<typeof Recording> {}
export const Recording = Schema.Struct({ enabled: Schema.Boolean, directory: Schema.String }).annotate({
  identifier: "Kitchen.Recording",
})

export interface Settings extends Schema.Schema.Type<typeof Settings> {}
export const Settings = Schema.Struct({
  config_file: optional(Schema.String),
  models: Schema.Record(ModelRole, ModelView),
  devices: Devices,
  camera_has_password: Schema.Boolean,
  recording: Recording,
}).annotate({ identifier: "Kitchen.Settings" })

export interface ModelUpdate extends Schema.Schema.Type<typeof ModelUpdate> {}
export const ModelUpdate = Schema.Struct({
  role: ModelRole,
  profile: ModelProfile,
  api_key: optional(Schema.NullOr(Schema.String)),
}).annotate({ identifier: "Kitchen.ModelUpdate" })

export interface DeviceUpdate extends Schema.Schema.Type<typeof DeviceUpdate> {}
export const DeviceUpdate = Schema.Struct({
  devices: Devices,
  camera_password: optional(Schema.NullOr(Schema.String)),
}).annotate({ identifier: "Kitchen.DeviceUpdate" })

export interface DeviceStatus extends Schema.Schema.Type<typeof DeviceStatus> {}
export const DeviceStatus = Schema.Struct({
  id: DeviceID,
  state: Schema.Literals(["unconfigured", "disabled", "connecting", "connected", "disconnected"]),
  last_sample: optional(Schema.Finite),
  value: optional(Schema.Finite),
  unit: optional(Schema.String),
  message: optional(Schema.String),
}).annotate({ identifier: "Kitchen.DeviceStatus" })

export class InvalidSettings extends Schema.TaggedError<InvalidSettings>()(
  "KitchenInvalidSettings",
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}
