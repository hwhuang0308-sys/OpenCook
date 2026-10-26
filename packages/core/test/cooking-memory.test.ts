import { beforeEach, expect } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencook/core/effect/app-node-builder"
import { LayerNode } from "@opencook/util/effect/layer-node"
import { CookingMemory } from "@opencook/core/cooking/memory"
import { CookingExecution } from "@opencook/core/cooking/execution"
import { CookingWorkflow } from "@opencook/core/cooking/workflow"
import { CookingRecipe } from "@opencook/core/cooking/recipe"
import { CookingKnowledge } from "@opencook/core/cooking/knowledge"
import { Session } from "@opencook/core/session"
import { SessionStore } from "@opencook/core/session/store"
import { SessionExecution } from "@opencook/core/session/execution"
import { SessionEvent } from "@opencook/core/session/event"
import { Location } from "@opencook/core/location"
import { Config } from "@opencook/core/config"
import { Bus } from "@opencook/core/bus"
import { KV } from "@opencook/core/kv"
import { Generate } from "@opencook/core/generate"
import { testEffect } from "./lib/effect"
import { tempLocationLayer } from "./fixture/location"

const answers: string[] = []
const calls: string[] = []
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      CookingMemory.node,
      Session.node,
      CookingWorkflow.node,
      Location.node,
      Bus.node,
      KV.node,
      SessionStore.node,
      CookingExecution.node,
      CookingKnowledge.node,
    ]),
    [
      Location.node.replace(tempLocationLayer),
      Config.node.replace(Config.testLayer()),
      SessionExecution.node.replace(SessionExecution.noopLayer),
      Generate.node.replace(
        Layer.succeed(
          Generate.Service,
          Generate.Service.of({
            text: (input) =>
              Effect.sync(() => {
                calls.push(input.prompt)
                const answer = answers.shift()
                if (!answer) throw new Error("Unexpected generation")
                return answer
              }),
          }),
        ),
      ),
    ],
  ),
)
beforeEach(() => {
  answers.length = 0
  calls.length = 0
})
const recipe: CookingRecipe.Recipe = {
  name: "番茄炒蛋",
  servings: 1,
  minutes: 10,
  equipment: ["炒锅"],
  source_ids: ["fixture-memory"],
  ingredients: [
    { name: "番茄", quantity: 200, unit: "克", estimated: false },
    { name: "鸡蛋", quantity: 2, unit: "个", estimated: false },
  ],
  seasonings: [{ name: "盐", quantity: 2, unit: "克", estimated: false }],
  steps: [{ text: "炒熟番茄和鸡蛋，加盐调味。", uses: ["番茄", "鸡蛋", "盐"] }],
}
const setup = Effect.gen(function* () {
  const memory = yield* CookingMemory.Service
  const sessions = yield* Session.Service
  const location = yield* Location.Service
  const bus = yield* Bus.Service
  const create = (parentID?: Session.ID) =>
    sessions.create(parentID ? { parentID } : { location: Location.Ref.make({ directory: location.directory }) })
  const session = yield* create()
  const say = (text: string, id = session.id) =>
    Effect.gen(function* () {
      const input = yield* sessions.prompt({ sessionID: id, text, resume: false })
      yield* bus.publish(SessionEvent.InboxDelivered, { sessionID: id, inboxID: input.id })
      return input
    })
  return { memory, sessions, create, session, say, bus }
})
const feedback = {
  action: "remember",
  kind: "experience",
  scope: "dish",
  dish: "西红柿炒鸡蛋",
  quote: "鸡蛋有点老，酱油太重了",
  topic: "口感与咸度",
  tags: ["西红柿炒鸡蛋", "鸡蛋老", "酱油过多"],
  proposed_adjustment: "下次核对火力和锅具，适当减少受热时间与酱油用量。",
} as const

it.live(
  "persists quoted cooking experience with the actual recipe version and retrieves it across sessions and service reloads",
  () =>
    Effect.gen(function* () {
      const s = yield* setup
      const execution = yield* CookingExecution.Service
      const run = yield* execution.start(s.session.id, {
        task_id: "recipe-memory",
        revision: 4,
        dish: "西红柿炒鸡蛋（咸鲜版）",
        recipe_text: "鸡蛋2个，番茄200克，酱油5ml。",
        program: "test",
        actions: "test",
        steps: [{ action: "盛出菜品", continuous: false, seconds: 0, conditions: [], logic: "" }],
      })
      yield* execution.control({ session_id: s.session.id, run_id: run.id, index: 0, action: "confirm" })
      const input = yield* s.say(feedback.quote)
      const saved = yield* s.memory.run(s.session.id, { ...feedback, run_id: run.id })
      expect(saved.entries[0].entry.source.message_id).toBe(input.id)
      expect(saved.entries[0].entry.episode).toMatchObject({
        run_id: run.id,
        revision: 4,
        status: "completed",
        recipe_text: "鸡蛋2个，番茄200克，酱油5ml。",
      })
      const another = yield* s.create()
      const recalled = yield* s.memory.recall(another.id, { dish: "番茄炒蛋" })
      expect(recalled.entries[0]).toMatchObject({
        match: "exact",
        entry: { quote: feedback.quote, proposed_adjustment: feedback.proposed_adjustment },
      })
      expect((yield* s.memory.recall(another.id, { query: "菠菜炒蛋", tags: ["鸡蛋"] })).entries[0].match).toBe(
        "related",
      )
      expect((yield* s.memory.recall(another.id, { query: "清蒸鲈鱼" })).entries).toHaveLength(0)
      const kv = yield* KV.Service
      const store = yield* SessionStore.Service
      const fresh = yield* Layer.build(
        AppNodeBuilder.build(CookingMemory.node, [
          KV.node.replace(Layer.succeed(KV.Service, kv)),
          SessionStore.node.replace(Layer.succeed(SessionStore.Service, store)),
          CookingExecution.node.replace(Layer.succeed(CookingExecution.Service, execution)),
        ]),
      )
      expect(
        (yield* Context.get(fresh, CookingMemory.Service).recall(another.id, { dish: "番茄炒蛋" })).entries,
      ).toEqual(recalled.entries)
    }),
)

it.live("isolates local profiles and keeps other existing conversations bound to their original person", () =>
  Effect.gen(function* () {
    const s = yield* setup
    yield* s.say("我一直不喜欢甜口")
    const saved = yield* s.memory.run(s.session.id, {
      action: "remember",
      kind: "preference",
      scope: "general",
      quote: "我一直不喜欢甜口",
      lasting_evidence: "我一直不喜欢甜口",
      topic: "甜度",
    })
    const other = yield* s.create()
    expect((yield* s.memory.recall(other.id)).entries).toHaveLength(1)
    yield* s.say("切换到小王")
    const profile = yield* s.memory.run(s.session.id, { action: "profile", profile_name: "小王", quote: "切换到小王" })
    expect(profile.profile.name).toBe("小王")
    expect((yield* s.memory.recall(s.session.id)).entries).toHaveLength(0)
    expect((yield* s.memory.recall(other.id)).entries).toHaveLength(1)
    const third = yield* s.create()
    expect((yield* s.memory.recall(third.id)).profile.name).toBe("小王")
    const child = yield* s.create(other.id)
    expect((yield* s.memory.recall(child.id)).entries).toHaveLength(1)
    expect(
      (yield* s.memory.run(third.id, { action: "forget", id: saved.entries[0].entry.id }).pipe(Effect.flip)).message,
    ).toContain("当前个人档案")
    yield* s.say("我一直喜欢甜食", third.id)
    expect(
      (yield* s.memory
        .run(third.id, {
          action: "remember",
          kind: "preference",
          scope: "general",
          quote: "我一直喜欢甜食",
          lasting_evidence: "我一直喜欢甜食",
          topic: "甜度",
          replace_id: saved.entries[0].entry.id,
        })
        .pipe(Effect.flip)).message,
    ).toContain("当前个人档案")
  }),
)

it.live("rejects ungrounded quotes, synthetic feedback, global one-off experiences and mismatched execution IDs", () =>
  Effect.gen(function* () {
    const s = yield* setup
    yield* s.say("你好")
    const synthetic = yield* s.sessions.synthetic({ sessionID: s.session.id, text: feedback.quote, resume: false })
    yield* s.bus.publish(SessionEvent.InboxDelivered, { sessionID: s.session.id, inboxID: synthetic.id })
    expect((yield* s.memory.run(s.session.id, feedback).pipe(Effect.flip)).message).toContain("用户的原话")
    yield* s.say(feedback.quote)
    expect((yield* s.memory.run(s.session.id, { ...feedback, scope: "general" }).pipe(Effect.flip)).message).toContain(
      "不能直接变成全局偏好",
    )
    expect(
      (yield* s.memory.run(s.session.id, { ...feedback, run_id: "unrelated" }).pipe(Effect.flip)).message,
    ).toContain("不一致")
    yield* s.say("明天我想吃清淡一点的")
    expect(
      (yield* s.memory
        .run(s.session.id, {
          action: "remember",
          kind: "preference",
          scope: "general",
          quote: "明天我想吃清淡一点的",
          topic: "清淡",
        })
        .pipe(Effect.flip)).message,
    ).toContain("长期偏好需要")
    yield* s.say(feedback.quote)
    const first = yield* s.memory.run(s.session.id, feedback)
    const retry = yield* s.memory.run(s.session.id, feedback)
    expect(retry).toEqual(first)
    expect((yield* s.memory.run(s.session.id, { action: "list" })).entries).toHaveLength(1)
  }),
)

it.live("corrects and deletes only the selected memory and preserves idempotency after a correction", () =>
  Effect.gen(function* () {
    const s = yield* setup
    yield* s.say("我一直不喜欢甜口")
    const first = yield* s.memory.run(s.session.id, {
      action: "remember",
      kind: "preference",
      scope: "general",
      quote: "我一直不喜欢甜口",
      lasting_evidence: "我一直不喜欢甜口",
      topic: "甜度",
    })
    yield* s.say("我现在改口了，我喜欢微甜")
    const replacement = {
      action: "remember",
      kind: "preference",
      scope: "general",
      quote: "我喜欢微甜",
      lasting_evidence: "我现在改口了，我喜欢微甜",
      topic: "甜度",
      replace_id: first.entries[0].entry.id,
    } as const
    const corrected = yield* s.memory.run(s.session.id, replacement)
    expect((yield* s.memory.run(s.session.id, replacement)).entries).toEqual(corrected.entries)
    const listed = yield* s.memory.run(s.session.id, { action: "list" })
    expect(listed.entries.map((entry) => entry.entry.quote)).toEqual(["我喜欢微甜"])
    yield* s.memory.run(s.session.id, { action: "forget", id: corrected.entries[0].entry.id })
    expect((yield* s.memory.recall(s.session.id)).entries).toHaveLength(0)
  }),
)

it.live(
  "feeds private feedback into actual recipe assessment and personalization without rewriting confirmed user conditions",
  () =>
    Effect.gen(function* () {
      const s = yield* setup
      const workflow = yield* CookingWorkflow.Service
      const knowledge = yield* CookingKnowledge.Service
      yield* knowledge.import([
        {
          id: "fixture-memory",
          title: "测试配方",
          author: "测试",
          edition: "test",
          locator: "1",
          source: "fixture://memory",
          text: "番茄炒蛋测试配方",
          tags: ["鸡蛋"],
          recipe,
        },
      ])
      yield* s.say(feedback.quote)
      yield* s.memory.run(s.session.id, feedback)
      const another = yield* s.create()
      answers.push(
        JSON.stringify({ needs_adaptation: true, reasons: ["上次反馈鸡蛋偏老，需要适配受热步骤"], questions: [] }),
      )
      const reference = yield* workflow.run({ action: "reference", dish: "番茄炒蛋" }, another.id)
      expect(reference.status).toBe("needs_adaptation")
      expect(reference.task.conditions.preferences).toEqual([])
      expect(reference.task.memory?.entries[0].entry.quote).toBe(feedback.quote)
      answers.push(
        JSON.stringify({
          ...recipe,
          steps: [{ text: "分别炒熟鸡蛋与番茄，及时盛出鸡蛋，回锅加盐拌匀。", uses: ["番茄", "鸡蛋", "盐"] }],
        }),
        JSON.stringify({ errors: [] }),
        JSON.stringify({ explanation: "根据上次鸡蛋偏老的反馈，改为分开处理并及时盛出，仍需按实际火力判断。" }),
      )
      const personalized = yield* workflow.run({ action: "personalize", task_id: reference.task.id }, another.id)
      expect(personalized.status).toBe("personalized")
      expect(personalized.recipe_text).toContain("及时盛出鸡蛋")
      expect(calls.every((prompt) => prompt.includes(feedback.quote))).toBe(true)
      expect(personalized.task.reference).toEqual(recipe)
      yield* s.say("这次鸡蛋口感刚好，我想保持现在的做法")
      const old = (yield* s.memory.run(s.session.id, { action: "list" })).entries[0].entry
      yield* s.memory.run(s.session.id, {
        ...feedback,
        quote: "这次鸡蛋口感刚好，我想保持现在的做法",
        proposed_adjustment: "保持做法",
        replace_id: old.id,
      })
      answers.push(JSON.stringify({ needs_adaptation: false, reasons: [], questions: [] }))
      const revised = yield* workflow.run({ action: "reference", task_id: reference.task.id }, another.id)
      expect(revised.status).toBe("reference_ready")
      expect(revised.task.personalized).toBeUndefined()
      expect(calls.at(-1)).toContain("这次鸡蛋口感刚好")
    }),
)
