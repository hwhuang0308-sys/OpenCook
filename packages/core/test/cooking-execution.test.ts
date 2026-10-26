import { Global } from "@opencook/util/global"
import { tempGlobalLayer } from "./fixture/global"
import { beforeEach, expect, test } from "bun:test"
import { Effect, Exit, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Cooking } from "@opencook/schema/cooking"
import { CookingCompiler } from "@opencook/core/cooking/compiler"
import { CookingExecution } from "@opencook/core/cooking/execution"
import { CookingConditions } from "@opencook/core/cooking/conditions"
import { CookingScore } from "@opencook/core/cooking/score"
import { CookingWorkflow } from "@opencook/core/cooking/workflow"
import { CookingKnowledge } from "@opencook/core/cooking/knowledge"
import { KitchenDevices } from "@opencook/core/cooking/devices/service"
import { Generate } from "@opencook/core/generate"
import { KV } from "@opencook/core/kv"
import { KitchenSettings } from "@opencook/core/cooking/settings"
import { AppNodeBuilder } from "@opencook/core/effect/app-node-builder"
import { LayerNode } from "@opencook/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const program =
  "第1步，do 切土豆成片\n第2步，do 调火至中火\n第3步，do 加热土豆，until <温度判定条件:[1 s]时长内满足条件[锅中食材表面温度大于等于60℃]>，<推荐时长: 10s>\n第4步，do 调火至关闭"
const plan: Cooking.Plan = {
  task_id: "fixture-recipe",
  revision: 1,
  dish: "土豆",
  recipe_text: "测试菜谱",
  program,
  actions: program,
  steps: CookingScore.validateActions(program, program),
}
const hardware = { connected: false, value: 20 }
const answers: string[] = []
const prompts: string[] = []
const devices = Layer.succeed(
  KitchenDevices.Service,
  KitchenDevices.Service.of({
    status: () => Effect.succeed(hardware.connected ? [{ id: "temperature", state: "connected" }] : []),
    reconnect: () => Effect.void,
    matrix: () => (hardware.connected ? new Float32Array(768).fill(hardware.value) : undefined),
    picture: () => undefined,
    temperature: () => hardware.value,
    sound: () => Effect.succeed([]),
    air: () => undefined,
    stir: () => ({ needed: false, message: "" }),
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      CookingCompiler.node,
      CookingExecution.node,
      CookingWorkflow.node,
      CookingKnowledge.node,
      KV.node,
    ]),
    [
      Global.node.replace(tempGlobalLayer),
      KitchenDevices.node.replace(devices),
      Generate.node.replace(
        Layer.succeed(
          Generate.Service,
          Generate.Service.of({
            text: (input) =>
              Effect.sync(() => {
                prompts.push(input.prompt)
                const next = answers.shift()
                if (next === undefined) throw new Error("Unexpected model call")
                return next
              }),
          }),
        ),
      ),
    ],
  ),
)
const visual = testEffect(
  AppNodeBuilder.build(LayerNode.group([CookingConditions.node, KitchenSettings.node]), [
    Global.node.replace(tempGlobalLayer),
    KitchenDevices.node.replace(
      Layer.succeed(
        KitchenDevices.Service,
        KitchenDevices.Service.of({
          status: () => Effect.succeed([{ id: "camera", state: "connected" }]),
          reconnect: () => Effect.void,
          matrix: () => undefined,
          temperature: () => undefined,
          sound: () => Effect.succeed([]),
          air: () => undefined,
          picture: () => ({ width: 2, height: 2, data: new Uint8Array(12).fill(180) }),
          stir: () => ({ needed: false, message: "" }),
        }),
      ),
    ),
  ]),
)
beforeEach(() => {
  hardware.connected = false
  hardware.value = 20
  answers.length = 0
  prompts.length = 0
})

test("parses action scores, preserves logic precedence, and rejects changed conditions and foreign code", () => {
  expect(plan.steps[0].continuous).toBe(false)
  expect(plan.steps[2]).toMatchObject({ continuous: true, seconds: 10, logic: "{0}" })
  expect(CookingScore.evaluate("{0} or ({1} and {2})", [true, false, false])).toBe(true)
  expect(CookingScore.evaluate("({0} or {1}) and {2}", [true, false, false])).toBe(false)
  expect(() => CookingScore.evaluate("process.exit()", [])).toThrow()
  expect(() => CookingScore.evaluate("{1}", [true])).toThrow()
  expect(() => CookingScore.parse(program.replace("60℃", "180℃"))).toThrow()
  expect(() => CookingScore.validateActions(program, program.replace("10s", "11s"))).toThrow("判定条件")
  expect(() => CookingScore.validateActions(program, program.replace("切土豆成片", "切<A>成<B>"))).toThrow()
})

test("retains the original continuous and cumulative temperature policies", () => {
  const continuous = CookingConditions.latch()
  expect(CookingConditions.hold(continuous, true, 0, 1)).toBe(false)
  expect(CookingConditions.hold(continuous, false, 500, 1)).toBe(false)
  expect(CookingConditions.hold(continuous, true, 1000, 1)).toBe(false)
  expect(CookingConditions.hold(continuous, true, 2000, 1)).toBe(true)
  const accumulated = CookingConditions.latch()
  expect(CookingConditions.hold(accumulated, true, 0, 1, true)).toBe(false)
  expect(CookingConditions.hold(accumulated, true, 500, 1, true)).toBe(false)
  expect(CookingConditions.hold(accumulated, false, 1000, 1, true)).toBe(false)
  expect(CookingConditions.hold(accumulated, true, 1500, 1, true)).toBe(true)
  const matrix = new Float32Array(768).fill(65)
  expect(CookingConditions.foodTemperature(matrix, 60)).toBe(true)
  matrix.fill(20, 0, 160)
  expect(CookingConditions.foodTemperature(matrix, 60)).toBe(false)
})

test("stir warnings retain the three-second display and cross-step cooldown", () => {
  const alarm = new CookingConditions.StirWarning()
  expect(alarm.update(true, "请翻炒", 0)).toBe("请翻炒")
  expect(alarm.update(false, "", 1000)).toBe("请翻炒")
  expect(alarm.update(false, "", 3000)).toBeUndefined()
  expect(alarm.update(true, "请翻炒", 4000)).toBeUndefined()
  expect(alarm.update(true, "请翻炒", 6000)).toBe("请翻炒")
  alarm.close(6100)
  expect(alarm.update(true, "请翻炒", 9000)).toBeUndefined()
  expect(alarm.update(true, "请翻炒", 9100)).toBe("请翻炒")
})

it.effect(
  "compiles saved recipes, normalizes medium-low heat before action conversion and rejects stale or foreign tasks",
  () =>
    Effect.gen(function* () {
      const knowledge = yield* CookingKnowledge.Service
      const workflow = yield* CookingWorkflow.Service
      const compiler = yield* CookingCompiler.Service
      yield* knowledge.import([
        {
          id: "potato",
          title: "测试土豆",
          author: "测试夹具",
          edition: "test",
          locator: "fixture",
          source: "fixture://potato",
          text: "测试",
          tags: ["土豆"],
          recipe: {
            name: "土豆",
            servings: 1,
            ingredients: [{ name: "土豆", quantity: 100, unit: "克", estimated: false }],
            seasonings: [],
            steps: [{ text: "切片后加热土豆。", uses: ["土豆"] }],
            equipment: ["锅"],
            minutes: 10,
            source_ids: ["potato"],
          },
        },
      ])
      const reference = yield* workflow.run({ action: "reference", dish: "土豆" }, "session-a")
      answers.push(
        JSON.stringify({
          steps: plan.steps.map((step) =>
            step.continuous
              ? { ...step, heat: "小火" }
              : step.action === "调火至中火"
                ? { ...step, action: "调火至中小火" }
                : step,
          ),
        }),
        JSON.stringify({
          steps: [
            { source_step: 1, verb: "切", object: "土豆", shape: "片" },
            { source_step: 2, verb: "调火", heat: "小火" },
            { source_step: 3, verb: "加热", object: "土豆" },
            { source_step: 4, verb: "调火", heat: "关闭" },
          ],
        }),
      )
      const compiled = yield* compiler.compile(reference.task.id, reference.task.revision, "session-a")
      expect(compiled.steps).toHaveLength(4)
      expect(compiled.steps[1].action).toBe("调火至小火")
      expect(compiled.steps[2].conditions).toEqual(plan.steps[2].conditions)
      expect(compiled.program).not.toContain("中小火")
      expect(compiled.recipe_text).toContain("所需食材：")
      expect(prompts).toHaveLength(2)
      expect(prompts[0]).toContain("具备条件触发机制")
      expect(prompts[1]).toContain("原样保留")
      expect(Exit.isFailure(yield* compiler.compile(reference.task.id, 999, "session-a").pipe(Effect.exit))).toBe(true)
      expect(
        Exit.isFailure(
          yield* compiler.compile(reference.task.id, reference.task.revision, "session-b").pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(prompts).toHaveLength(2)
    }),
)

it.effect(
  "manual actions wait for a button, stale confirmations do not advance, and stopping cancels the watchdog",
  () =>
    Effect.gen(function* () {
      const execution = yield* CookingExecution.Service
      const first = yield* execution.start("session-a", plan)
      expect(yield* execution.get("session-b")).toBeNull()
      yield* TestClock.adjust("1 hour")
      expect((yield* execution.get("session-a"))?.index).toBe(0)
      expect((yield* execution.start("session-a", plan)).id).toBe(first.id)
      const control = (action: Cooking.Control["action"], index: number) =>
        execution.control({ session_id: "session-a", run_id: first.id, index, action })
      expect((yield* control("confirm", 0)).index).toBe(1)
      expect(Exit.isFailure(yield* control("confirm", 0).pipe(Effect.exit))).toBe(true)
      expect((yield* control("confirm", 1)).index).toBe(2)
      yield* TestClock.adjust("3 seconds")
      const paused = yield* control("pause", 0)
      yield* TestClock.adjust("1 hour")
      expect((yield* execution.get("session-a"))?.elapsed_ms).toBe(paused.elapsed_ms)
      yield* control("resume", 0)
      yield* TestClock.adjust("2 seconds")
      const stopped = yield* control("stop", 0)
      yield* TestClock.adjust("1 hour")
      expect(yield* execution.get("session-a")).toEqual(stopped)
      expect(stopped.completions).toHaveLength(2)
      expect(stopped.status).toBe("stopped")
    }),
)

it.effect("view requests preserve paused progress and the running watchdog while resuming requests a new view", () =>
  Effect.gen(function* () {
    const execution = yield* CookingExecution.Service
    const first = yield* execution.start("session-a", { ...plan, steps: plan.steps.slice(2) })
    const control = (action: Cooking.Control["action"]) =>
      execution.control({
        session_id: "session-a",
        run_id: first.id,
        index: 0,
        action,
      })
    yield* TestClock.adjust("3 seconds")
    const opened = yield* control("open")
    expect(opened.status).toBe("running")
    expect(opened.elapsed_ms).toBe(3000)
    expect(opened.display_request).toBeTruthy()
    yield* TestClock.adjust("2 seconds")
    const again = yield* control("open")
    expect(again.elapsed_ms).toBe(5000)
    expect(again.display_request).not.toBe(opened.display_request)
    const paused = yield* control("pause")
    yield* TestClock.adjust("1 hour")
    const viewing = yield* control("open")
    expect(viewing.status).toBe("paused")
    expect(viewing.id).toBe(first.id)
    expect(viewing.index).toBe(0)
    expect(viewing.elapsed_ms).toBe(paused.elapsed_ms)
    expect(viewing.completions).toEqual(paused.completions)
    const resumed = yield* control("resume")
    expect(resumed.display_request).not.toBe(viewing.display_request)
    expect(resumed.id).toBe(first.id)
    expect(resumed.index).toBe(0)
    expect(resumed.elapsed_ms).toBe(5000)
    yield* TestClock.adjust("5 seconds")
    expect((yield* execution.get("session-a"))?.index).toBe(1)
    expect(prompts).toHaveLength(0)
  }),
)

it.effect(
  "advances continuous actions by the legacy duration watchdog and keeps the following instant action waiting",
  () =>
    Effect.gen(function* () {
      const execution = yield* CookingExecution.Service
      const first = yield* execution.start("session-a", { ...plan, steps: plan.steps.slice(2) })
      yield* TestClock.adjust("10 seconds")
      const next = (yield* execution.get("session-a"))!
      expect(next.index).toBe(1)
      expect(next.completions[0].reason).toBe("duration")
      yield* TestClock.adjust("1 hour")
      expect((yield* execution.get("session-a"))?.index).toBe(1)
      const done = yield* execution.control({ session_id: "session-a", run_id: first.id, index: 1, action: "confirm" })
      expect(done.status).toBe("completed")
      expect(prompts).toHaveLength(0)
    }),
)

it.effect("real temperature conditions advance before the watchdog without a conversation or model call", () =>
  Effect.gen(function* () {
    hardware.connected = true
    hardware.value = 65
    const execution = yield* CookingExecution.Service
    yield* execution.start("session-a", { ...plan, steps: plan.steps.slice(2) })
    yield* TestClock.adjust("2 seconds")
    const next = (yield* execution.get("session-a"))!
    expect(next.index).toBe(1)
    expect(next.completions[0].reason).toBe("sensor")
    expect(prompts).toHaveLength(0)
  }),
)

it.effect("restores interrupted runs paused and starts a worker on explicit resume", () =>
  Effect.gen(function* () {
    const kv = yield* KV.Service
    const execution = yield* CookingExecution.Service
    const run: Cooking.Run = {
      id: "restart",
      session_id: "session-a",
      plan: { ...plan, steps: plan.steps.slice(2) },
      status: "running",
      index: 0,
      elapsed_ms: 3000,
      started_at: 0,
      updated_at: 0,
      completions: [],
    }
    yield* kv.set("cooking/execution/session-a", Schema.encodeSync(Schema.toCodecJson(Cooking.Run))(run))
    expect((yield* execution.get("session-a"))?.status).toBe("paused")
    yield* TestClock.adjust("1 hour")
    expect((yield* execution.get("session-a"))?.index).toBe(0)
    yield* execution.control({ session_id: "session-a", run_id: "restart", index: 0, action: "pause" })
    yield* execution.control({ session_id: "session-a", run_id: "restart", index: 0, action: "resume" })
    yield* TestClock.adjust("8 seconds")
    expect((yield* execution.get("session-a"))?.completions[0].reason).toBe("duration")
  }),
)

visual.live("visual conditions use the configured multimodal model and require both original judgments", () =>
  Effect.gen(function* () {
    const requests: Array<{ model: string; messages: unknown[] }> = []
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          async fetch(request) {
            requests.push((await request.json()) as { model: string; messages: unknown[] })
            return Response.json({ choices: [{ message: { content: "1" } }] })
          },
        }),
      ),
      (server) => Effect.sync(() => server.stop(true)),
    )
    const settings = yield* KitchenSettings.Service
    yield* settings.updateModel({
      role: "vision",
      profile: { enabled: true, base_url: `${server.url}v1`, model: "fixture-vision", context: 4096, output: 512 },
      api_key: "fixture-key",
    })
    const conditions = yield* CookingConditions.Service
    const step: Cooking.Step = {
      action: "炒鸡蛋",
      continuous: true,
      seconds: 30,
      conditions: [{ type: "visual", duration: 0, condition: "鸡蛋凝固" }],
      logic: "{0}",
    }
    const state: CookingConditions.Latch[] = []
    expect(yield* conditions.check(step, state)).toBe(false)
    expect(yield* conditions.check(step, state)).toBe(true)
    expect(requests).toHaveLength(4)
    expect(requests.every((request) => request.model === "fixture-vision")).toBe(true)
    expect(JSON.stringify(requests[0].messages)).toContain("image_url")
    expect(yield* conditions.check(step, state)).toBe(true)
    expect(requests).toHaveLength(4)
  }),
)
