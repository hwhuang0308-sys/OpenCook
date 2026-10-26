import { Kitchen } from "@opencook/schema/kitchen"
import { Cooking } from "@opencook/schema/cooking"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"

export const KitchenGroup = HttpApiGroup.make("server.kitchen")
  .add(
    HttpApiEndpoint.post("kitchen.cookingReport", "/api/kitchen/cooking/report", {
      payload: Cooking.Report,
      success: HttpApiSchema.NoContent,
      error: Cooking.Invalid,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "kitchen.cookingReport", summary: "Return a finished cooking guide to chat" }),
    ),
  )
  .add(
    HttpApiEndpoint.post("kitchen.speech", "/api/kitchen/cooking/speech", {
      payload: Cooking.SpeechRequest,
      success: Cooking.Speech,
      error: Cooking.Invalid,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "kitchen.speech", summary: "Synthesize the current cooking instruction" }),
    ),
  )
  .add(
    HttpApiEndpoint.get("kitchen.cooking", "/api/kitchen/cooking", {
      query: Schema.Struct({ session_id: Schema.String }),
      success: Schema.NullOr(Cooking.Run),
    }).annotateMerge(
      OpenApi.annotations({ identifier: "kitchen.cooking", summary: "Read the cooking guide for a session" }),
    ),
  )
  .add(
    HttpApiEndpoint.post("kitchen.cookingControl", "/api/kitchen/cooking/control", {
      payload: Cooking.Control,
      success: Cooking.Run,
      error: Cooking.Invalid,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "kitchen.cookingControl", summary: "Confirm, pause, resume or stop cooking" }),
    ),
  )
  .add(
    HttpApiEndpoint.get("kitchen.settings", "/api/kitchen/settings", { success: Kitchen.Settings }).annotateMerge(
      OpenApi.annotations({ identifier: "kitchen.settings", summary: "Read OpenCook settings without secrets" }),
    ),
  )
  .add(
    HttpApiEndpoint.put("kitchen.model", "/api/kitchen/model", {
      payload: Kitchen.ModelUpdate,
      success: Kitchen.Settings,
      error: Kitchen.InvalidSettings,
    }).annotateMerge(OpenApi.annotations({ identifier: "kitchen.model", summary: "Configure a model capability" })),
  )
  .add(
    HttpApiEndpoint.put("kitchen.devices", "/api/kitchen/devices", {
      payload: Kitchen.DeviceUpdate,
      success: Kitchen.Settings,
      error: Kitchen.InvalidSettings,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "kitchen.devices", summary: "Configure camera and serial sensors" }),
    ),
  )
  .add(
    HttpApiEndpoint.put("kitchen.recording", "/api/kitchen/recording", {
      payload: Kitchen.Recording,
      success: Kitchen.Settings,
      error: Kitchen.InvalidSettings,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "kitchen.recording", summary: "Enable or disable sensor debug recording" }),
    ),
  )
  .add(
    HttpApiEndpoint.get("kitchen.status", "/api/kitchen/status", {
      success: Schema.Array(Kitchen.DeviceStatus),
    }).annotateMerge(OpenApi.annotations({ identifier: "kitchen.status", summary: "Read live device connectivity" })),
  )
  .add(
    HttpApiEndpoint.post("kitchen.reconnect", "/api/kitchen/reconnect", {
      payload: Schema.Struct({ id: Kitchen.DeviceID }),
      success: Schema.Array(Kitchen.DeviceStatus),
    }).annotateMerge(
      OpenApi.annotations({ identifier: "kitchen.reconnect", summary: "Reconnect a configured device" }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "kitchen" }))
