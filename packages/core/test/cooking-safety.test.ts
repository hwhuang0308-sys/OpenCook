import { beforeEach, expect } from "bun:test"
import { Effect, Exit, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Cooking } from "@opencook/schema/cooking"
import { CookingExecution } from "@opencook/core/cooking/execution"
import { CookingSafety } from "@opencook/core/cooking/safety"
import { CookingVision } from "@opencook/core/cooking/vision"
import { KitchenDevices } from "@opencook/core/cooking/devices/service"
import { AppNodeBuilder } from "@opencook/core/effect/app-node-builder"
import { KV } from "@opencook/core/kv"
import { Global } from "@opencook/util/global"
import { LayerNode } from "@opencook/util/effect/layer-node"
import { tempGlobalLayer } from "./fixture/global"
import { testEffect } from "./lib/effect"

const hardware = { camera: true, air: true, smoke: 9 }
const modes: Record<Cooking.Hazard, "yes" | "no" | "fail" | "hang" | "defer"> = { fire: "no", burnt: "no" }
const calls: Cooking.Hazard[] = []
let pending = Promise.withResolvers<boolean>()
let normalCalls = 0
let cancelled = 0
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([CookingExecution.node, CookingSafety.node, KV.node]), [
    Global.node.replace(tempGlobalLayer),
    KitchenDevices.node.replace(
      Layer.succeed(
        KitchenDevices.Service,
        KitchenDevices.Service.of({
          status: () =>
            Effect.succeed([
              { id: "camera", state: hardware.camera ? "connected" : "disconnected" },
              { id: "air", state: hardware.air ? "connected" : "disconnected" },
            ]),
          reconnect: () => Effect.void,
          picture: () => ({ width: 2, height: 2, data: new Uint8Array(12).fill(100) }),
          matrix: () => undefined,
          temperature: () => undefined,
          sound: () => Effect.succeed([]),
          air: () => hardware.smoke,
          stir: () => ({ needed: false, message: "" }),
        }),
      ),
    ),
    // The external vision boundary is controllable; safety and execution are real.
    CookingVision.node.replace(
      Layer.succeed(
        CookingVision.Service,
        CookingVision.Service.of({
          check: (_, prompt) =>
            Effect.suspend(() => {
              if (prompt.startsWith("我现在")) {
                normalCalls++
                return Effect.sleep("3 seconds").pipe(Effect.as(true))
              }
              const kind = prompt.includes("烧焦") ? "burnt" : "fire"
              calls.push(kind)
              if (modes[kind] === "hang")
                return Effect.never.pipe(
                  Effect.onInterrupt(() =>
                    Effect.sync(() => {
                      cancelled++
                    }),
                  ),
                )
              if (modes[kind] === "defer") return Effect.promise(() => pending.promise)
              if (modes[kind] === "fail") return Effect.fail(new CookingVision.Error({ message: "fixture failure" }))
              return Effect.succeed(modes[kind] === "yes")
            }),
        }),
      ),
    ),
  ]),
)
const plan: Cooking.Plan = {
  task_id: "safety-fixture",
  revision: 1,
  dish: "测试菜",
  recipe_text: "测试",
  program: "测试",
  actions: "测试",
  steps: [
    {
      action: "加热食材",
      continuous: true,
      seconds: 5,
      conditions: [{ type: "temperature", duration: 1, condition: "锅中食材表面温度大于等于60℃" }],
      logic: "{0}",
    },
    { action: "取出食材", continuous: false, seconds: 0, conditions: [], logic: "" },
  ],
}
const waitFor = <A>(read: () => Effect.Effect<A>, accept: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = yield* read()
      if (accept(value)) return value
      // JPEG encoding is native asynchronous I/O, outside TestClock.
      yield* Effect.promise(() => Bun.sleep(5))
    }
    throw new Error(`Safety state did not settle: ${JSON.stringify({ calls, latest: yield* read() })}`)
  })
beforeEach(() => {
  hardware.camera = true
  hardware.air = true
  hardware.smoke = 9
  modes.fire = "no"
  modes.burnt = "no"
  pending = Promise.withResolvers<boolean>()
  normalCalls = 0
  cancelled = 0
  calls.length = 0
})

it.effect(
  "fire and smoke-gated burnt checks run independently; a hanging fire request cannot block burnt interruption",
  () =>
    Effect.gen(function* () {
      modes.fire = "hang"
      modes.burnt = "yes"
      const execution = yield* CookingExecution.Service
      const started = yield* execution.start("safety", plan)
      yield* TestClock.adjust("100 millis")
      const run = (yield* waitFor(
        () => execution.get("safety"),
        (run) => !!run?.emergency,
      ))!
      expect(calls).toContain("fire")
      expect(calls).toContain("burnt")
      expect(run).toMatchObject({
        status: "paused",
        index: 0,
        completions: [],
        emergency: { kind: "burnt", interrupted_step: 0 },
      })
      expect(run.incidents).toHaveLength(1)
      yield* TestClock.adjust("20 seconds")
      expect((yield* execution.get("safety"))?.index).toBe(0)
      expect((yield* execution.get("safety"))?.emergency?.id).toBe(run.emergency!.id)
      expect(
        Exit.isFailure(
          yield* execution
            .control({ session_id: "safety", run_id: started.id, index: 0, action: "confirm" })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      yield* execution.control({ session_id: "safety", run_id: started.id, index: 0, action: "stop" })
    }),
)

it.effect(
  "simultaneous alerts choose fire, reject stale confirmations, and require safe-scene confirmation before resume",
  () =>
    Effect.gen(function* () {
      modes.fire = "yes"
      modes.burnt = "yes"
      const execution = yield* CookingExecution.Service
      const started = yield* execution.start("safety", plan)
      yield* TestClock.adjust("100 millis")
      let run = (yield* waitFor(
        () => execution.get("safety"),
        (run) => run?.emergency?.kind === "fire",
      ))!
      expect(run.completions).toEqual([])
      expect(run.emergency!.steps.join(" ")).toContain("不要向油锅泼水")
      const input = {
        session_id: "safety",
        run_id: started.id,
        index: 0,
        emergency_id: run.emergency!.id,
        emergency_index: 0,
      }
      expect(Exit.isFailure(yield* execution.control({ ...input, action: "resume" }).pipe(Effect.exit))).toBe(true)
      expect(
        Exit.isFailure(yield* execution.control({ ...input, action: "emergency_resolve" }).pipe(Effect.exit)),
      ).toBe(true)
      run = yield* execution.control({ ...input, action: "emergency_confirm" })
      expect(
        Exit.isFailure(yield* execution.control({ ...input, action: "emergency_confirm" }).pipe(Effect.exit)),
      ).toBe(true)
      run = yield* execution.control({ ...input, emergency_index: 1, action: "emergency_confirm" })
      run = yield* execution.control({ ...input, emergency_index: 2, action: "emergency_resolve" })
      expect(run).toMatchObject({ status: "paused", index: 0, completions: [], elapsed_ms: 0 })
      expect(run.emergency).toBeUndefined()
      expect(run.incidents!.at(-1)!.resolved_at).toBeDefined()
      modes.fire = "no"
      modes.burnt = "no"
      run = yield* execution.control({ ...input, action: "resume" })
      expect(run.status).toBe("running")
      yield* TestClock.adjust("6 seconds")
      expect((yield* execution.get("safety"))?.completions[0]?.reason).toBe("duration")
    }),
)

it.effect("one failed detector leaves the other running; fire does not require an air sensor", () =>
  Effect.gen(function* () {
    modes.fire = "fail"
    modes.burnt = "yes"
    const safety = yield* CookingSafety.Service
    expect((yield* safety.inspect("fire")).state).toBe("error")
    expect((yield* safety.inspect("burnt")).state).toBe("alert")
    hardware.air = false
    modes.fire = "yes"
    expect((yield* safety.inspect("fire")).state).toBe("alert")
    expect((yield* safety.inspect("burnt")).state).toBe("unavailable")
    hardware.camera = false
    expect((yield* safety.inspect("fire")).state).toBe("unavailable")
  }),
)

it.effect("burnt monitoring preserves the threshold and never uses stale air readings", () =>
  Effect.gen(function* () {
    const safety = yield* CookingSafety.Service
    modes.burnt = "yes"
    hardware.smoke = 8.99
    expect((yield* safety.inspect("burnt")).state).toBe("clear")
    expect(calls).toEqual([])
    hardware.smoke = 9
    expect((yield* safety.inspect("burnt")).state).toBe("alert")
    hardware.air = false
    expect((yield* safety.inspect("burnt")).state).toBe("unavailable")
    expect(calls).toEqual(["burnt"])
  }),
)

it.effect("a hanging safety request cannot block the independent duration watchdog or stopping a run", () =>
  Effect.gen(function* () {
    modes.fire = "hang"
    modes.burnt = "hang"
    const execution = yield* CookingExecution.Service
    const started = yield* execution.start("safety", plan)
    yield* TestClock.adjust("100 millis")
    yield* waitFor(
      () => Effect.succeed(calls.length),
      (count) => count === 2,
    )
    yield* TestClock.adjust("6 seconds")
    expect((yield* execution.get("safety"))?.index).toBe(1)
    yield* execution.control({ session_id: "safety", run_id: started.id, index: 1, action: "stop" })
    yield* TestClock.adjust("1 minute")
    expect((yield* execution.get("safety"))?.status).toBe("stopped")
    expect(calls).toHaveLength(2)
    yield* waitFor(
      () => Effect.succeed(cancelled),
      (count) => count === 2,
    )
    hardware.camera = false
    const next = yield* execution.start("safety", plan)
    expect(next.id).not.toBe(started.id)
    expect(next.emergency).toBeUndefined()
  }),
)

it.effect("restart preserves unresolved emergency steps and keeps ordinary steps frozen", () =>
  Effect.gen(function* () {
    hardware.camera = false
    const kv = yield* KV.Service
    const execution = yield* CookingExecution.Service
    const run: Cooking.Run = {
      id: "restart",
      session_id: "safety",
      plan,
      status: "paused",
      index: 0,
      elapsed_ms: 1000,
      started_at: 0,
      updated_at: 0,
      completions: [],
      emergency: {
        id: "incident",
        kind: "fire",
        steps: CookingSafety.steps("fire"),
        index: 1,
        interrupted_step: 0,
        time: 0,
      },
    }
    yield* kv.set("cooking/execution/safety", Schema.encodeSync(Schema.toCodecJson(Cooking.Run))(run))
    expect((yield* execution.get("safety"))?.emergency).toEqual(run.emergency)
    yield* TestClock.adjust("1 minute")
    expect((yield* execution.get("safety"))?.completions).toEqual([])
    expect(
      Exit.isFailure(
        yield* execution
          .control({ session_id: "safety", run_id: "restart", index: 0, action: "resume" })
          .pipe(Effect.exit),
      ),
    ).toBe(true)
  }),
)

it.effect("monitor status updates do not discard slow ordinary visual condition results", () =>
  Effect.gen(function* () {
    const execution = yield* CookingExecution.Service
    yield* execution.start("safety", {
      ...plan,
      steps: [
        {
          ...plan.steps[0],
          seconds: 60,
          conditions: [{ type: "visual", duration: 0, condition: "食材变软" }],
          logic: "{0}",
        },
        plan.steps[1],
      ],
    })
    yield* TestClock.adjust("100 millis")
    for (let count = 1; count <= 4; count++) {
      yield* waitFor(
        () => Effect.succeed(normalCalls),
        (value) => value >= count,
      )
      yield* TestClock.adjust("3100 millis")
    }
    const run = (yield* waitFor(
      () => execution.get("safety"),
      (run) => run?.index === 1,
    ))!
    expect(run.completions[0].reason).toBe("sensor")
    expect(calls.filter((kind) => kind === "fire").length).toBeGreaterThan(1)
    expect(calls.filter((kind) => kind === "burnt").length).toBeGreaterThan(1)
  }),
)

it.effect("a late fire result upgrades burnt guidance and invalidates the former emergency confirmation", () =>
  Effect.gen(function* () {
    modes.fire = "defer"
    modes.burnt = "yes"
    const execution = yield* CookingExecution.Service
    const started = yield* execution.start("safety", plan)
    yield* TestClock.adjust("100 millis")
    const burnt = (yield* waitFor(
      () => execution.get("safety"),
      (run) => run?.emergency?.kind === "burnt",
    ))!
    pending.resolve(true)
    const fire = (yield* waitFor(
      () => execution.get("safety"),
      (run) => run?.emergency?.kind === "fire",
    ))!
    expect(fire.emergency!.id).not.toBe(burnt.emergency!.id)
    expect(fire.plan.steps).toEqual(plan.steps)
    expect(fire.completions).toEqual([])
    expect(fire.incidents![0].superseded_by).toBe(fire.emergency!.id)
    expect(
      Exit.isFailure(
        yield* execution
          .control({
            session_id: "safety",
            run_id: started.id,
            index: 0,
            action: "emergency_confirm",
            emergency_id: burnt.emergency!.id,
            emergency_index: 0,
          })
          .pipe(Effect.exit),
      ),
    ).toBe(true)
  }),
)

it.effect("a pre-resolution detection response cannot reinsert a stale emergency after the user confirms safety", () =>
  Effect.gen(function* () {
    modes.fire = "yes"
    modes.burnt = "defer"
    const execution = yield* CookingExecution.Service
    const started = yield* execution.start("safety", plan)
    yield* TestClock.adjust("100 millis")
    const fire = (yield* waitFor(
      () => execution.get("safety"),
      (run) => run?.emergency?.kind === "fire",
    ))!
    yield* waitFor(() => Effect.succeed(calls.includes("burnt")), Boolean)
    const input = { session_id: "safety", run_id: started.id, index: 0, emergency_id: fire.emergency!.id }
    yield* execution.control({ ...input, action: "emergency_confirm", emergency_index: 0 })
    yield* execution.control({ ...input, action: "emergency_confirm", emergency_index: 1 })
    yield* execution.control({ ...input, action: "emergency_resolve", emergency_index: 2 })
    modes.fire = "no"
    modes.burnt = "no"
    pending.resolve(true)
    // Drain the old external I/O result without advancing to a fresh polling cycle.
    yield* Effect.promise(() => Bun.sleep(20))
    expect((yield* execution.get("safety"))?.emergency).toBeUndefined()
    expect((yield* execution.get("safety"))?.index).toBe(0)
  }),
)
