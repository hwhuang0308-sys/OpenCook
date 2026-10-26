export * as CookingExecution from "./execution.js"

import { Clock, Context, Effect, Fiber, Layer, Schema, Semaphore } from "effect"
import { Cooking } from "@opencook/schema/cooking"
import { makeGlobalNode } from "@opencook/util/effect/app-node"
import { KV } from "../kv.js"
import { KitchenDevices } from "./devices/service.js"
import { CookingSafety } from "./safety.js"
import { SensorRecording } from "./devices/recording.js"
import { CookingConditions } from "./conditions.js"

export interface Interface {
  readonly get: (sessionID: string) => Effect.Effect<Cooking.Run | null>
  readonly start: (sessionID: string, plan: Cooking.Plan) => Effect.Effect<Cooking.Run, Cooking.Invalid>
  readonly control: (input: Cooking.Control) => Effect.Effect<Cooking.Run, Cooking.Invalid>
}
export class Service extends Context.Service<Service, Interface>()("@opencook/CookingExecution") {}
const decode = Schema.decodeUnknownSync(Schema.toCodecJson(Cooking.Run))
const encode = Schema.encodeSync(Schema.toCodecJson(Cooking.Run))

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const kv = yield* KV.Service
    const devices = yield* KitchenDevices.Service
    const conditions = yield* CookingConditions.Service
    const safety = yield* CookingSafety.Service
    const recorder = yield* SensorRecording.Service
    const scope = yield* Effect.scope
    const lock = Semaphore.makeUnsafe(1)
    const active = new Map<
      string,
      {
        run: Cooking.Run
        since: number
        latches: CookingConditions.Latch[]
        worker: boolean
        fiber?: Fiber.Fiber<void>
        stir: CookingConditions.StirWarning
        displayRequest?: string
        monitoring?: typeof Cooking.Monitoring.Type
        safetyEpoch?: number
      }
    >()
    const save = (run: Cooking.Run) =>
      kv.set(
        `cooking/execution/${run.session_id}`,
        encode({
          ...run,
          display_request: active.get(run.session_id)?.displayRequest ?? run.display_request,
          monitoring: active.get(run.session_id)?.monitoring ?? run.monitoring,
        }),
      )
    const get = Effect.fn(function* (sessionID: string) {
      const current = active.get(sessionID)
      if (current) {
        const now = yield* Clock.currentTimeMillis
        const frying =
          current.run.status === "running" && current.run.plan.steps[current.run.index]?.action.startsWith("炒")
        if (!frying) current.stir.close(now)
        return {
          ...current.run,
          display_request: current.displayRequest ?? current.run.display_request,
          monitoring: current.monitoring ?? current.run.monitoring,
          elapsed_ms:
            current.run.elapsed_ms +
            (current.run.status === "running" ? (yield* Clock.currentTimeMillis) - current.since : 0),
          warning:
            current.run.warning ||
            (frying ? current.stir.update(devices.stir().needed, devices.stir().message, now) : undefined),
        }
      }
      const stored = yield* kv.get(`cooking/execution/${sessionID}`)
      if (!stored) return null
      const run = decode(stored)
      if (run.status !== "running" && run.status !== "paused") return run
      const restored: Cooking.Run = {
        ...run,
        status: "paused",
        warning: run.emergency ? "服务已重启，应急处理尚未确认结束。" : "服务已重启，请核对实际操作进度后恢复指导。",
      }
      active.set(sessionID, {
        run: restored,
        since: yield* Clock.currentTimeMillis,
        latches: [],
        worker: false,
        stir: new CookingConditions.StirWarning(),
      })
      yield* save(restored)
      active.get(sessionID)!.worker = true
      yield* launch(sessionID, restored.id)
      return restored
    })
    const advance = Effect.fn(function* (
      sessionID: string,
      id: string,
      index: number,
      reason: Cooking.Completion["reason"],
    ) {
      const current = active.get(sessionID)
      if (!current || current.run.id !== id || current.run.index !== index || current.run.status !== "running") return
      const time = yield* Clock.currentTimeMillis
      current.run = {
        ...current.run,
        index: index + 1,
        elapsed_ms: 0,
        updated_at: time,
        warning: undefined,
        status: index + 1 === current.run.plan.steps.length ? "completed" : "running",
        completions: [...current.run.completions, { step: index, reason, time }],
      }
      current.since = time
      current.latches = []
      current.stir.close(time)
      yield* save(current.run)
      if (current.run.status === "completed") {
        active.delete(sessionID)
        if (current.fiber) yield* Fiber.interrupt(current.fiber).pipe(Effect.forkIn(scope))
      }
    })
    const monitor = (sessionID: string, id: string, kind: Cooking.Hazard) =>
      Effect.gen(function* () {
        let lastAlert = -Infinity
        while (active.get(sessionID)?.run.id === id) {
          if ((yield* Clock.currentTimeMillis) - lastAlert < CookingSafety.cooldown) {
            yield* Effect.sleep(CookingSafety.interval)
            continue
          }
          const epoch = active.get(sessionID)?.safetyEpoch
          yield* lock.withPermit(
            Effect.sync(() => {
              const current = active.get(sessionID)
              if (current?.run.id === id)
                current.monitoring = {
                  fire: "unavailable",
                  burnt: "unavailable",
                  ...current.monitoring,
                  [kind]: "checking",
                }
            }),
          )
          const result = yield* safety
            .inspect(kind)
            .pipe(Effect.catchDefect(() => Effect.succeed({ state: "error" as const })))
          yield* lock.withPermit(
            Effect.gen(function* () {
              const current = active.get(sessionID)
              if (!current || current.run.id !== id || current.safetyEpoch !== epoch) return
              const now = yield* Clock.currentTimeMillis
              const monitoring = {
                fire: "unavailable",
                burnt: "unavailable",
                ...current.monitoring,
                [kind]: result.state,
              } as const
              current.monitoring = monitoring
              if (result.state !== "alert" || now - lastAlert < CookingSafety.cooldown) return
              lastAlert = now
              if (current.run.emergency?.kind === "fire" || current.run.emergency?.kind === kind) return
              const emergency: Cooking.Emergency = {
                id: crypto.randomUUID(),
                kind,
                index: 0,
                steps: CookingSafety.steps(kind),
                interrupted_step: current.run.index,
                time: now,
              }
              current.run = {
                ...current.run,
                status: "paused",
                emergency,
                monitoring,
                incidents: [
                  ...(current.run.incidents ?? []).map((incident) =>
                    incident.id === current.run.emergency?.id ? { ...incident, superseded_by: emergency.id } : incident,
                  ),
                  { id: emergency.id, kind, step: current.run.index, time: now },
                ],
                elapsed_ms: current.run.elapsed_ms + (current.run.status === "running" ? now - current.since : 0),
                updated_at: now,
                warning: undefined,
                display_request: crypto.randomUUID(),
              }
              current.displayRequest = undefined
              current.latches = []
              current.stir.close(now)
              yield* save(current.run)
              // Debug I/O must never delay the emergency state transition.
              yield* recorder.warning(`应急中断：${kind}；步骤 ${current.run.index + 1}`, now).pipe(
                Effect.catch(() => Effect.void),
                Effect.forkIn(scope),
              )
            }),
          )
          yield* Effect.sleep(CookingSafety.interval)
        }
      })
    const worker = (sessionID: string, id: string) =>
      Effect.all(
        [
          monitor(sessionID, id, "fire"),
          monitor(sessionID, id, "burnt"),
          Effect.gen(function* () {
            while (active.get(sessionID)?.run.id === id) {
              yield* lock.withPermit(
                Effect.gen(function* () {
                  const current = active.get(sessionID)
                  if (!current || current.run.status !== "running") return
                  const step = current.run.plan.steps[current.run.index]
                  // Preserve recipe_executor.py's watchdog: duration expiry advances a
                  // continuous action, and is recorded separately from sensor success.
                  if (
                    step.continuous &&
                    current.run.elapsed_ms + (yield* Clock.currentTimeMillis) - current.since >= step.seconds * 1000
                  )
                    yield* advance(sessionID, id, current.run.index, "duration")
                }),
              )
              yield* Effect.sleep("100 millis")
            }
          }),
          Effect.gen(function* () {
            while (active.get(sessionID)?.run.id === id) {
              const current = active.get(sessionID)
              const run = current?.run
              if (current && run?.status === "running" && run.plan.steps[run.index].continuous) {
                const result = yield* conditions.check(run.plan.steps[run.index], current.latches).pipe(
                  Effect.catchDefect(() =>
                    Effect.fail(
                      new CookingConditions.Error({
                        message: "步骤判定失败，请核对实际状态；计时与异常监测继续运行。",
                      }),
                    ),
                  ),
                  Effect.result,
                )
                yield* lock.withPermit(
                  Effect.gen(function* () {
                    const latest = active.get(sessionID)
                    if (!latest || latest.run !== run) return
                    if (result._tag === "Failure") {
                      latest.run = { ...run, warning: result.failure.message }
                      return
                    }
                    if (result.success) yield* advance(sessionID, id, run.index, "sensor")
                  }),
                )
              }
              yield* Effect.sleep("100 millis")
            }
          }),
        ],
        { concurrency: "unbounded", discard: true },
      )
    const launch = Effect.fn(function* (sessionID: string, id: string) {
      const fiber = yield* worker(sessionID, id).pipe(Effect.forkIn(scope))
      const current = active.get(sessionID)
      if (current?.run.id === id) current.fiber = fiber
    })
    return Service.of({
      get: (sessionID) => lock.withPermit(get(sessionID)),
      start: (sessionID, plan) =>
        lock.withPermit(
          Effect.gen(function* () {
            const previous = yield* get(sessionID)
            if (previous && (previous.status === "running" || previous.status === "paused")) {
              if (previous.plan.task_id === plan.task_id && previous.plan.revision === plan.revision) return previous
              return yield* new Cooking.Invalid({ message: "已有烹饪指导，请先暂停并结束当前指导后再开始另一道菜" })
            }
            const now = yield* Clock.currentTimeMillis
            const run: Cooking.Run = {
              id: `cooking_${crypto.randomUUID()}`,
              session_id: sessionID,
              plan,
              status: "running",
              index: 0,
              elapsed_ms: 0,
              started_at: now,
              updated_at: now,
              completions: [],
            }
            active.set(sessionID, {
              run,
              since: now,
              latches: [],
              worker: true,
              stir: new CookingConditions.StirWarning(),
            })
            yield* save(run)
            yield* launch(sessionID, run.id)
            return run
          }),
        ),
      control: (input) =>
        lock.withPermit(
          Effect.gen(function* () {
            const snapshot = yield* get(input.session_id)
            if (!snapshot || snapshot.id !== input.run_id)
              return yield* new Cooking.Invalid({ message: "烹饪指导不存在或已被替换" })
            if (input.action === "open") {
              const display_request = crypto.randomUUID()
              const current = active.get(input.session_id)
              // Opening a view must preserve the timer origin and condition latches.
              if (current) current.displayRequest = display_request
              yield* save(current?.run ?? { ...snapshot, display_request })
              return { ...snapshot, display_request }
            }
            if (snapshot.status === "stopped" || snapshot.status === "completed") {
              if (input.action === "stop") return snapshot
              return yield* new Cooking.Invalid({ message: "烹饪指导已经结束" })
            }
            if (input.action === "confirm" && input.index !== snapshot.index)
              return yield* new Cooking.Invalid({ message: "当前步骤已改变，请查看最新动作后操作" })
            const current = active.get(input.session_id)!
            if (input.action === "emergency_confirm" || input.action === "emergency_resolve") {
              const emergency = snapshot.emergency
              if (!emergency || input.emergency_id !== emergency.id || input.emergency_index !== emergency.index)
                return yield* new Cooking.Invalid({ message: "应急步骤已改变，请查看最新提示后操作" })
              if (input.action === "emergency_resolve" && emergency.index < emergency.steps.length)
                return yield* new Cooking.Invalid({ message: "请先完成应急步骤，再确认现场安全" })
              const now = yield* Clock.currentTimeMillis
              if (input.action === "emergency_resolve") current.safetyEpoch = (current.safetyEpoch ?? 0) + 1
              current.run = {
                ...snapshot,
                status: "paused",
                updated_at: now,
                emergency:
                  input.action === "emergency_confirm"
                    ? { ...emergency, index: Math.min(emergency.index + 1, emergency.steps.length) }
                    : undefined,
                incidents:
                  input.action === "emergency_resolve"
                    ? snapshot.incidents?.map((incident) =>
                        incident.id === emergency.id ? { ...incident, resolved_at: now } : incident,
                      )
                    : snapshot.incidents,
                elapsed_ms: input.action === "emergency_resolve" ? 0 : snapshot.elapsed_ms,
                warning:
                  input.action === "emergency_resolve" ? "请核对被中断的操作和锅内状态，再恢复指导。" : undefined,
              }
              current.latches = []
              yield* save(current.run)
              return current.run
            }
            if (snapshot.emergency && input.action !== "stop" && input.action !== "pause")
              return yield* new Cooking.Invalid({
                message: "应急处理期间不能推进普通步骤；请先处理异常并明确确认现场安全",
              })
            if (input.action === "confirm") {
              if (snapshot.status !== "running")
                return yield* new Cooking.Invalid({ message: "请先恢复指导，再确认完成" })
              yield* advance(input.session_id, input.run_id, input.index, "confirmed")
              return (yield* get(input.session_id))!
            }
            const now = yield* Clock.currentTimeMillis
            const status = input.action === "stop" ? "stopped" : input.action === "pause" ? "paused" : "running"
            current.run = {
              ...snapshot,
              status,
              updated_at: now,
              warning: undefined,
              ...(input.action === "resume" ? { display_request: crypto.randomUUID() } : {}),
            }
            current.displayRequest = undefined
            current.since = now
            current.latches = []
            yield* save(current.run)
            if (status === "stopped") {
              active.delete(input.session_id)
              if (current.fiber) yield* Fiber.interrupt(current.fiber).pipe(Effect.forkIn(scope))
            }
            // A run restored from disk has no worker. Starting a worker is safe only
            // once, tracked independently from the persisted cooking status.
            if (input.action === "resume" && !current.worker) {
              current.worker = true
              yield* launch(input.session_id, input.run_id)
            }
            return current.run
          }),
        ),
    })
  }),
)
export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [KV.node, KitchenDevices.node, CookingConditions.node, CookingSafety.node, SensorRecording.node],
})
