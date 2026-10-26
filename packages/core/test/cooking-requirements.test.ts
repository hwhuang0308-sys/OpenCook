import { beforeEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencook/core/effect/app-node-builder"
import { LayerNode } from "@opencook/util/effect/layer-node"
import { CookingRequirements } from "@opencook/core/cooking/requirements"
import { Generate } from "@opencook/core/generate"
import { Session } from "@opencook/core/session"
import { SessionExecution } from "@opencook/core/session/execution"
import { SessionEvent } from "@opencook/core/session/event"
import { Location } from "@opencook/core/location"
import { Config } from "@opencook/core/config"
import { Bus } from "@opencook/core/bus"
import { testEffect } from "./lib/effect"
import { tempLocationLayer } from "./fixture/location"

const answers: string[] = []
const requests: string[] = []
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([CookingRequirements.node, Session.node, Location.node, Bus.node]), [
    Location.node.replace(tempLocationLayer),
    Config.node.replace(Config.testLayer()),
    SessionExecution.node.replace(SessionExecution.noopLayer),
    Generate.node.replace(
      Layer.succeed(
        Generate.Service,
        Generate.Service.of({
          text: (input) =>
            Effect.sync(() => {
              requests.push(input.prompt)
              const next = answers.shift()
              if (next === undefined) throw new Error("Unexpected requirements extraction")
              return next
            }),
        }),
      ),
    ),
  ]),
)
beforeEach(() => {
  answers.length = 0
  requests.length = 0
})
const setup = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const location = yield* Location.Service
  const bus = yield* Bus.Service
  const requirements = yield* CookingRequirements.Service
  const session = yield* sessions.create({ location: Location.Ref.make({ directory: location.directory }) })
  const say = (text: string) =>
    Effect.gen(function* () {
      const message = yield* sessions.prompt({ sessionID: session.id, text, resume: false })
      yield* bus.publish(SessionEvent.InboxDelivered, { sessionID: session.id, inboxID: message.id })
      return message
    })
  return { session, say, requirements }
})

it.live("keeps literal stock quantities, strips invented recipe amounts, and caches the same user evidence", () =>
  Effect.gen(function* () {
    const s = yield* setup
    const text = "两个鸡蛋，三个西红柿，油盐都有，用多少你定"
    const message = yield* s.say(text)
    answers.push(
      JSON.stringify({
        changes: {
          ingredients: [
            { name: "鸡蛋", quantity: 2, unit: "个" },
            { name: "西红柿", quantity: 3, unit: "个" },
          ],
          seasonings: [
            { name: "油", quantity: 20, unit: "毫升" },
            { name: "盐", quantity: 2, unit: "克" },
          ],
        },
        evidence: [
          {
            field: "ingredients",
            source_id: message.id,
            quote: "两个鸡蛋",
            stock_name: "鸡蛋",
            quantity_text: "两",
            unit_text: "个",
          },
          {
            field: "ingredients",
            source_id: message.id,
            quote: "三个西红柿",
            stock_name: "西红柿",
            quantity_text: "三",
            unit_text: "个",
          },
          {
            field: "seasonings",
            source_id: message.id,
            quote: "油盐都有",
            stock_name: "油",
            quantity_text: "20",
            unit_text: "毫升",
          },
          {
            field: "seasonings",
            source_id: message.id,
            quote: "油盐都有",
            stock_name: "盐",
            quantity_text: "2",
            unit_text: "克",
          },
        ],
      }),
    )
    const initial = yield* s.requirements.resolve(s.session.id)
    expect(initial.ingredients).toEqual([
      { name: "鸡蛋", quantity: 2, unit: "个" },
      { name: "西红柿", quantity: 3, unit: "个" },
    ])
    expect(initial.seasonings).toEqual([{ name: "油" }, { name: "盐" }])
    expect(yield* s.requirements.resolve(s.session.id)).toEqual(initial)
    expect(requests).toHaveLength(1)
    const correction = yield* s.say("不要甜口，用老抽，不要糖")
    answers.push(
      JSON.stringify({
        changes: {
          preferences: ["咸口，用老抽"],
          excluded: ["糖"],
          seasonings: [{ name: "油" }, { name: "盐" }, { name: "老抽" }],
        },
        evidence: [
          { field: "preferences", source_id: correction.id, quote: "不要甜口，用老抽" },
          { field: "excluded", source_id: correction.id, quote: "不要糖" },
          { field: "seasonings", source_id: correction.id, quote: "用老抽" },
        ],
      }),
    )
    const updated = yield* s.requirements.resolve(s.session.id)
    expect(updated.ingredients).toEqual(initial.ingredients)
    expect(updated.excluded).toEqual(["糖"])
    expect(updated.preferences).toEqual(["咸口，用老抽"])
    expect(updated.seasonings.at(-1)).toEqual({ name: "老抽" })
    const acceptance = yield* s.say("可以，就这个版本，开始吧")
    answers.push(
      JSON.stringify({
        changes: {},
        evidence: [],
        guidance: { action: "start", source_id: acceptance.id, quote: "请开始吧" },
      }),
    )
    // Reinterpreting an old quote must not change a recipe merely on acceptance.
    answers.push(
      JSON.stringify({
        changes: { servings: 2, excluded: ["糖", "蒜"] },
        guidance: { action: "start", source_id: acceptance.id, quote: "开始吧" },
        evidence: [
          { field: "servings", source_id: message.id, quote: "两个鸡蛋" },
          { field: "excluded", source_id: correction.id, quote: "不要糖" },
        ],
      }),
    )
    expect(acceptance.id).not.toBe(correction.id)
    expect(yield* s.requirements.resolve(s.session.id)).toEqual(updated)
    expect(requests.at(-1)).toContain("guidance quote is not an exact substring")
    expect(yield* s.requirements.guidance(s.session.id)).toBe("start")
    yield* s.requirements.consume(s.session.id)
    expect(yield* s.requirements.guidance(s.session.id)).toBe("none")
    expect(yield* s.requirements.resolve(s.session.id)).toEqual(updated)
    expect(yield* s.requirements.guidance(s.session.id)).toBe("none")
  }),
)

it.live("recognizes the count encoded in a colloquial Chinese counter without inventing an unstated stock amount", () =>
  Effect.gen(function* () {
    const s = yield* setup
    const message = yield* s.say("冰箱里俩鸡蛋，油盐都有")
    answers.push(
      JSON.stringify({
        changes: {
          ingredients: [{ name: "鸡蛋", quantity: 2, unit: "个" }],
          seasonings: [{ name: "油", quantity: 20, unit: "毫升" }],
        },
        evidence: [
          { field: "ingredients", source_id: message.id, quote: "俩鸡蛋", stock_name: "鸡蛋", quantity_text: "俩" },
          { field: "seasonings", source_id: message.id, quote: "油盐都有" },
        ],
      }),
    )
    const result = yield* s.requirements.resolve(s.session.id)
    expect(result.ingredients).toEqual([{ name: "鸡蛋", quantity: 2, unit: "个" }])
    expect(result.seasonings).toEqual([{ name: "油" }])
  }),
)
it.live("does not treat a fabricated citation or an accepted recipe as proof of stock or a personal preference", () =>
  Effect.gen(function* () {
    const s = yield* setup
    yield* s.say("可以，教我做")
    answers.push(
      JSON.stringify({
        changes: { servings: 2, preferences: ["甜口"], seasonings: [{ name: "油", quantity: 30, unit: "毫升" }] },
        evidence: [
          { field: "servings", source_id: "assistant-recipe", quote: "2人份" },
          { field: "preferences", source_id: "assistant-recipe", quote: "甜口" },
          {
            field: "seasonings",
            source_id: "assistant-recipe",
            quote: "油30毫升",
            stock_name: "油",
            quantity_text: "30",
            unit_text: "毫升",
          },
        ],
      }),
    )
    const result = yield* s.requirements.resolve(s.session.id)
    expect(result.servings).toBeUndefined()
    expect(result.preferences).toEqual([])
    expect(result.seasonings).toEqual([])
  }),
)

it.live("applies an explicit preference replacement and clearing of a previous serving limit", () =>
  Effect.gen(function* () {
    const s = yield* setup
    const initial = yield* s.say("一人份，喜欢甜口")
    answers.push(
      JSON.stringify({
        changes: { servings: 1, preferences: ["甜口"] },
        evidence: [
          { field: "servings", source_id: initial.id, quote: "一人份" },
          { field: "preferences", source_id: initial.id, quote: "喜欢甜口" },
        ],
      }),
    )
    yield* s.requirements.resolve(s.session.id)
    const next = yield* s.say("人数不限了，不吃甜的，改成咸口")
    answers.push(
      JSON.stringify({
        changes: { servings: null, preferences: ["咸口，不甜"] },
        evidence: [
          { field: "servings", source_id: next.id, quote: "人数不限了" },
          { field: "preferences", source_id: next.id, quote: "不吃甜的，改成咸口" },
        ],
      }),
    )
    const result = yield* s.requirements.resolve(s.session.id)
    expect(result.servings).toBeUndefined()
    expect(result.preferences).toEqual(["咸口，不甜"])
  }),
)
