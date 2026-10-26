import { KitchenSettings } from "@opencook/core/cooking/settings"
import { KitchenDevices } from "@opencook/core/cooking/devices/service"
import { CookingExecution } from "@opencook/core/cooking/execution"
import { CookingSpeech } from "@opencook/core/cooking/speech"
import { Session } from "@opencook/core/session"
import { SessionMessage } from "@opencook/schema/session-message"
import { Cooking } from "@opencook/schema/cooking"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
import { Api } from "../api"

export const KitchenHandler = HttpApiBuilder.group(Api, "server.kitchen", (handlers) =>
  Effect.gen(function* () {
    const settings = yield* KitchenSettings.Service
    const devices = yield* KitchenDevices.Service
    const execution = yield* CookingExecution.Service
    const speech = yield* CookingSpeech.Service
    const sessions = yield* Session.Service
    return handlers
      .handle(
        "kitchen.cookingReport",
        Effect.fn(function* (ctx) {
          const run = yield* execution.get(ctx.payload.session_id)
          if (!run || run.id !== ctx.payload.run_id)
            return yield* new Cooking.Invalid({ message: "烹饪引导不存在或已被替换" })
          if (run.status !== "completed" && run.status !== "stopped")
            return yield* new Cooking.Invalid({ message: "烹饪引导尚未结束" })
          const description = run.status === "completed" ? "本次烹饪引导已完毕。" : "本次烹饪引导已中途结束。"
          const result = {
            type: "cooking_guidance_finished",
            run_id: run.id,
            dish: run.plan.dish,
            status: run.status,
            can_resume: false,
            completed_steps: run.completions.length,
            total_steps: run.plan.steps.length,
            completion_reasons: run.completions.map((entry) => entry.reason),
            warning: run.warning,
            incidents: run.incidents,
          }
          yield* sessions
            .synthetic({
              sessionID: ctx.payload.session_id,
              // A run has one durable result, including across retries and CLI restarts.
              id: SessionMessage.ID.make(`msg_cooking_finished_${run.id}`),
              description,
              text: `The user has returned from the cooking guide to chat. Cooking service result:\n${JSON.stringify(result)}`,
              metadata: result,
              delivery: "queue",
            })
            .pipe(Effect.mapError(() => new Cooking.Invalid({ message: "未能将烹饪结果送回对话，请重试" })))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle("kitchen.speech", (ctx) => speech.synthesize(ctx.payload))
      .handle("kitchen.cooking", (ctx) => execution.get(ctx.query.session_id))
      .handle("kitchen.cookingControl", (ctx) => execution.control(ctx.payload))
      .handle("kitchen.settings", () => settings.get())
      .handle("kitchen.model", (ctx) => settings.updateModel(ctx.payload))
      .handle("kitchen.devices", (ctx) => settings.updateDevices(ctx.payload))
      .handle("kitchen.recording", (ctx) => settings.updateRecording(ctx.payload))
      .handle("kitchen.status", () => devices.status())
      .handle(
        "kitchen.reconnect",
        Effect.fn(function* (ctx) {
          yield* devices.reconnect(ctx.payload.id)
          return yield* devices.status()
        }),
      )
  }),
)
