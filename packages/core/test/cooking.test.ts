import { beforeEach, describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencook/core/effect/app-node-builder"
import { CookingRecipe } from "@opencook/core/cooking/recipe"
import { CookingKnowledge } from "@opencook/core/cooking/knowledge"
import { CookingWorkflow } from "@opencook/core/cooking/workflow"
import { Generate } from "@opencook/core/generate"
import { LayerNode } from "@opencook/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const recipe: CookingRecipe.Recipe = {
  name: "番茄炒蛋",
  servings: 2,
  minutes: 15,
  equipment: ["炒锅"],
  source_ids: ["fixture-tomato"],
  ingredients: [
    { name: "番茄", quantity: 200, unit: "克", estimated: false },
    { name: "鸡蛋", quantity: 2, unit: "个", estimated: false },
  ],
  seasonings: [{ name: "盐", quantity: 2, unit: "克", estimated: false }],
  steps: [
    { text: "鸡蛋打散。", uses: ["鸡蛋"] },
    { text: "番茄切块炒软，放入鸡蛋，加入盐炒匀。", uses: ["番茄", "盐"] },
  ],
}
// Test material is deliberately synthetic, not presented as an authoritative cookbook.
const passage: CookingKnowledge.Document = {
  id: "fixture-tomato",
  title: "番茄炒蛋测试样例",
  author: "测试夹具",
  edition: "test",
  locator: "fixture 1",
  source: "fixture://tomato",
  text: "番茄炒蛋，两人份的家常菜测试资料。",
  tags: ["番茄", "鸡蛋", "家常菜"],
  recipe,
}
const answers: string[] = []
const calls: string[] = []
const generator = Layer.succeed(
  Generate.Service,
  Generate.Service.of({
    text: (input) =>
      Effect.sync(() => {
        calls.push(input.prompt)
        const answer = answers.shift()
        if (answer === undefined) throw new Error("Unexpected model call")
        return answer
      }),
  }),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([CookingWorkflow.node, CookingKnowledge.node]), [
    Generate.node.replace(generator),
  ]),
)
beforeEach(() => {
  answers.length = 0
  calls.length = 0
})

describe("cooking recipe contracts", () => {
  test("renders the fixed three-section format without mixing sources or explanations", () => {
    expect(CookingRecipe.render(recipe)).toBe(
      "所需食材：\n番茄200克\n鸡蛋2个\n所需调料：\n盐2克\n烹饪步骤：\n鸡蛋打散。\n番茄切块炒软，放入鸡蛋，加入盐炒匀。",
    )
    expect(() => Schema.decodeUnknownSync(CookingRecipe.Recipe)({ ...recipe, servings: 0 })).toThrow()
  })
  test("checks aliases, convertible stock quantities, missing oil and unknown quantities", () => {
    const conditions = {
      ...CookingRecipe.emptyConditions(),
      inventory_only: true,
      ingredients: [{ name: "西红柿", quantity: 0.1, unit: "kg" }, { name: "鸡蛋" }],
      seasonings: [],
    }
    const result = CookingRecipe.validate(recipe, conditions)
    expect(result.errors.map((error) => error.code)).toEqual(["insufficient_stock", "not_in_inventory"])
    expect(result.unresolved.map((error) => error.code)).toEqual(["stock_quantity_unknown"])
  })
  test("rejects unknown sources, excluded food and unlisted step ingredients", () => {
    const result = CookingRecipe.validate(
      { ...recipe, steps: [{ text: "加花生。", uses: ["花生"] }] },
      { ...CookingRecipe.emptyConditions(), excluded: ["西红柿"] },
      new Set(),
    )
    expect(result.errors.map((error) => error.code)).toContain("unknown_source")
    expect(result.errors.map((error) => error.code)).toContain("excluded_ingredient")
    expect(result.errors.map((error) => error.code)).toContain("unlisted_ingredient")
  })
  test("uses stock across categories without confusing soy sauce varieties or assuming utensils are forbidden", () => {
    const conditions = {
      ...CookingRecipe.emptyConditions(),
      inventory_only: true,
      ingredients: [
        { name: "西红柿", quantity: 200, unit: "克" },
        { name: "鸡蛋", quantity: 2, unit: "个" },
        { name: "食盐", quantity: 5, unit: "克" },
      ],
      equipment: ["铁锅"],
    }
    expect(CookingRecipe.validate(recipe, conditions).passed).toBe(true)
    expect(CookingRecipe.validate(recipe, { ...conditions, equipment_only: true }).passed).toBe(true)
    expect(
      CookingRecipe.validate({ ...recipe, equipment: ["蒸锅"] }, { ...conditions, equipment_only: true }).errors[0]
        .code,
    ).toBe("missing_equipment")
    expect(CookingRecipe.canonical("老抽")).not.toBe(CookingRecipe.canonical("生抽"))
  })
})

describe("persistent cooking knowledge and tasks", () => {
  it.effect("distinguishes an empty library, a miss and a real attributed hit", () =>
    Effect.gen(function* () {
      const knowledge = yield* CookingKnowledge.Service
      expect((yield* knowledge.search({ query: "番茄" })).status).toBe("empty_library")
      yield* knowledge.import([passage])
      expect((yield* knowledge.search({ query: "火星土壤" })).status).toBe("no_match")
      const result = yield* knowledge.search({ query: "番茄炒蛋" })
      expect(result.status).toBe("ready")
      expect(result.hits[0]?.document).toEqual(passage)
    }),
  )
  it.effect("returning to dish suggestions clears the old selection and retains emotional context", () =>
    Effect.gen(function* () {
      const knowledge = yield* CookingKnowledge.Service
      const workflow = yield* CookingWorkflow.Service
      yield* knowledge.import([passage])
      const initial = yield* workflow.run({ action: "reference", dish: recipe.name }, "session-a")
      answers.push(JSON.stringify({ candidates: [{ name: "京酱肉丝", reason: "京味家常菜候选", source_ids: [] }] }))
      const conditions = {
        ...CookingRecipe.emptyConditions(),
        regional_context: ["北京"],
        emotional_context: ["我想家了"],
      }
      const result = yield* workflow.run(
        { action: "suggest", task_id: initial.task.id, conditions, count: 1 },
        "session-a",
      )
      expect(result.status).toBe("suggested")
      expect(result.task.conditions.emotional_context).toEqual(["我想家了"])
      expect(result.task.reference).toBeUndefined()
      expect(result.task.dish).toBeUndefined()
      expect(result.recipe_text).toBeUndefined()
      expect(result.task.evidence?.status).toBe("not_searched")
      expect(calls).toHaveLength(1)
    }),
  )
  it.effect("can ground names-only suggestions in the library when Cook selects it", () =>
    Effect.gen(function* () {
      const knowledge = yield* CookingKnowledge.Service
      const workflow = yield* CookingWorkflow.Service
      yield* knowledge.import([passage])
      answers.push(
        JSON.stringify({ candidates: [{ name: recipe.name, reason: "书库中的家常菜", source_ids: [passage.id] }] }),
      )
      const result = yield* workflow.run(
        {
          action: "suggest",
          source: "library",
          conditions: { ...CookingRecipe.emptyConditions(), ingredients: [{ name: "番茄" }] },
        },
        "session-a",
      )
      expect(result.status).toBe("suggested")
      expect(result.task.evidence?.status).toBe("ready")
      expect(result.task.candidates[0]?.source_ids).toEqual([passage.id])
      expect(result.task.reference).toBeUndefined()
      expect(calls).toHaveLength(1)
    }),
  )
  it.effect("uses a matching indexed recipe unchanged, without a personalization call", () =>
    Effect.gen(function* () {
      const knowledge = yield* CookingKnowledge.Service
      const workflow = yield* CookingWorkflow.Service
      yield* knowledge.import([passage])
      const result = yield* workflow.run(
        { action: "reference", dish: "番茄炒蛋", conditions: { ...CookingRecipe.emptyConditions(), servings: 2 } },
        "session-a",
      )
      expect(result.status).toBe("reference_ready")
      expect(result.task.reference).toEqual(recipe)
      expect(result.task.personalized).toBeUndefined()
      expect(calls).toHaveLength(0)
      expect(CookingWorkflow.describe(result)).toMatchObject({
        phase: "recipe_ready",
        current_recipe_kind: "reference",
        reference_recipe: { name: recipe.name, source_ids: [passage.id] },
      })
      const saved = yield* workflow.run({ action: "get", task_id: result.task.id }, "session-a")
      expect(saved.recipe_text).toBe(CookingRecipe.render(recipe))
    }),
  )
  it.effect("reports missing evidence instead of pretending to have searched a cookbook", () =>
    Effect.gen(function* () {
      const workflow = yield* CookingWorkflow.Service
      const result = yield* workflow.run({ action: "reference", dish: "北京烤鸭" }, "session-a")
      expect(result.status).toBe("needs_evidence")
      expect(result.task.evidence?.status).toBe("empty_library")
      expect(calls).toHaveLength(0)
    }),
  )
  it.effect("does not retain another dish's recipe when a continuing task changes dish", () =>
    Effect.gen(function* () {
      const knowledge = yield* CookingKnowledge.Service
      const workflow = yield* CookingWorkflow.Service
      yield* knowledge.import([passage])
      const initial = yield* workflow.run({ action: "reference", dish: "番茄炒蛋" }, "session-a")
      const changed = yield* workflow.run(
        { action: "reference", task_id: initial.task.id, dish: "北京烤鸭" },
        "session-a",
      )
      expect(changed.status).toBe("needs_evidence")
      expect(changed.task.reference).toBeUndefined()
      expect(changed.task.assessment).toBeUndefined()
      expect(changed.transition).toMatchObject({
        cause: "dish_changed",
        reference: "missing",
        source_action: "library_lookup",
      })
      const saved = yield* workflow.run({ action: "get", task_id: initial.task.id }, "session-a")
      expect(saved.status).toBe("needs_evidence")
      expect(saved.recipe_text).toBeUndefined()
    }),
  )
  it.effect("reports evidence gaps even when the library contains a lexical match", () =>
    Effect.gen(function* () {
      const knowledge = yield* CookingKnowledge.Service
      const workflow = yield* CookingWorkflow.Service
      yield* knowledge.import([{ ...passage, recipe: undefined, text: "番茄炒蛋的文化背景，没有配方。" }])
      answers.push(JSON.stringify({ status: "needs_evidence", gaps: ["资料没有配方和操作步骤"] }))
      const result = yield* workflow.run({ action: "reference", dish: "番茄炒蛋" }, "session-a")
      expect(result.status).toBe("needs_evidence")
      expect(result.task.reference).toBeUndefined()
      expect(result.errors?.[0]?.code).toBe("source_gap")
    }),
  )
  it.effect("uses only external pages actually read in the current conversation", () =>
    Effect.gen(function* () {
      const knowledge = yield* CookingKnowledge.Service
      const workflow = yield* CookingWorkflow.Service
      const url = "https://example.test/recipe"
      yield* knowledge.import([passage])
      yield* knowledge.recordPage("session-a", url, CookingRecipe.render(recipe))
      const denied = yield* workflow.run({ action: "reference", dish: recipe.name, evidence_urls: [url] }, "session-b")
      expect(denied.status).toBe("needs_evidence")
      expect(calls).toHaveLength(0)
      answers.push(JSON.stringify({ status: "ready", recipe: { ...recipe, source_ids: [`web:${url}`] }, notes: [] }))
      const result = yield* workflow.run({ action: "reference", dish: recipe.name, evidence_urls: [url] }, "session-a")
      expect(result.status).toBe("reference_ready")
      expect(result.task.reference?.source_ids).toEqual([`web:${url}`])
      expect(result.task.evidence?.external?.[0]?.source).toBe(url)
      expect(result.task.evidence?.status).toBe("not_searched")
      expect(result.task.evidence?.hits).toEqual([])
    }),
  )
  it.effect("honors web source selection instead of reusing a library recipe or fabricating a draft", () =>
    Effect.gen(function* () {
      const knowledge = yield* CookingKnowledge.Service
      const workflow = yield* CookingWorkflow.Service
      yield* knowledge.import([passage])
      const initial = yield* workflow.run({ action: "reference", dish: recipe.name }, "session-a")
      const pending = yield* workflow.run(
        { action: "reference", task_id: initial.task.id, source: "web", allow_draft: true },
        "session-a",
      )
      expect(pending.status).toBe("needs_evidence")
      expect(pending.errors?.[0]?.code).toBe("web_evidence_required")
      expect(pending.task.reference).toBeUndefined()
      expect(pending.task.evidence?.status).toBe("not_searched")
      expect(pending.transition).toMatchObject({ cause: "new_reference", reference: "missing" })
      expect(calls).toHaveLength(0)
      const url = "https://example.test/web-variant"
      yield* knowledge.recordPage("session-a", url, CookingRecipe.render(recipe))
      answers.push(JSON.stringify({ status: "ready", recipe: { ...recipe, source_ids: [`web:${url}`] }, notes: [] }))
      const result = yield* workflow.run(
        { action: "reference", task_id: initial.task.id, source: "web", evidence_urls: [url] },
        "session-a",
      )
      expect(result.status).toBe("reference_ready")
      expect(result.task.reference?.source_ids).toEqual([`web:${url}`])
      expect(result.transition).toMatchObject({ reference: "acquired", source_action: "read_web_pages" })
      expect(calls).toHaveLength(1)
    }),
  )
  it.effect("retains routine estimates as notes and reuses the extracted web reference", () =>
    Effect.gen(function* () {
      const knowledge = yield* CookingKnowledge.Service
      const workflow = yield* CookingWorkflow.Service
      const url = "https://example.test/season-to-taste"
      yield* knowledge.recordPage("session-a", url, "番茄200克，鸡蛋2个，盐适量；打散鸡蛋，下锅炒熟。")
      const sourced = {
        ...recipe,
        seasonings: recipe.seasonings.map((item) => ({ ...item, estimated: true })),
        source_ids: [`web:${url}`],
      }
      const notes = ["原文盐用量为适量，2克为估算；制作时间和份量为估算。"]
      answers.push(JSON.stringify({ status: "ready", recipe: sourced, notes }))
      const initial = yield* workflow.run(
        { action: "reference", dish: recipe.name, source: "web", evidence_urls: [url] },
        "session-a",
      )
      expect(initial.status).toBe("reference_ready")
      expect(initial.task.reference).toEqual(sourced)
      expect(initial.task.reference_notes).toEqual(notes)
      expect(initial.recipe_text).toContain("盐2克")
      const repeated = yield* workflow.run(
        { action: "reference", task_id: initial.task.id, source: "web", evidence_urls: [url] },
        "session-a",
      )
      expect(repeated.status).toBe("reference_ready")
      expect(repeated.task.reference_notes).toEqual(notes)
      const saved = yield* workflow.run({ action: "get", task_id: initial.task.id }, "session-a")
      expect(saved.task.reference_notes).toEqual(notes)
      expect(calls).toHaveLength(1)
    }),
  )
  it.effect("does not repeat extraction or enter personalization when the same evidence still has a blocking gap", () =>
    Effect.gen(function* () {
      const knowledge = yield* CookingKnowledge.Service
      const workflow = yield* CookingWorkflow.Service
      const url = "https://example.test/missing-method"
      yield* knowledge.recordPage("session-a", url, "番茄炒蛋的食材介绍，没有烹饪方法。")
      answers.push(JSON.stringify({ status: "needs_evidence", gaps: ["缺少核心烹饪步骤"] }))
      const initial = yield* workflow.run(
        { action: "reference", dish: recipe.name, source: "web", evidence_urls: [url] },
        "session-a",
      )
      expect(initial.status).toBe("needs_evidence")
      expect(initial.task.reference).toBeUndefined()
      const repeated = yield* workflow.run(
        {
          action: "reference",
          task_id: initial.task.id,
          source: "web",
          evidence_urls: [url],
          conditions: { ...CookingRecipe.emptyConditions(), excluded: ["葱"], servings: 1 },
        },
        "session-a",
      )
      expect(repeated.errors?.map((error) => error.code)).toEqual(["unchanged_evidence", "source_gap"])
      const blocked = yield* workflow.run({ action: "personalize", task_id: initial.task.id }, "session-a")
      expect(blocked.status).toBe("needs_evidence")
      expect(blocked.errors?.[0]?.code).toBe("reference_required")
      const saved = yield* workflow.run({ action: "get", task_id: initial.task.id }, "session-a")
      expect(saved.errors?.some((error) => error.message === "缺少核心烹饪步骤")).toBe(true)
      expect(calls).toHaveLength(1)

      // Reading new content at the same URL must invalidate the failed extraction.
      yield* knowledge.recordPage("session-a", url, CookingRecipe.render(recipe))
      answers.push(JSON.stringify({ status: "ready", recipe: { ...recipe, source_ids: [`web:${url}`] }, notes: [] }))
      const repaired = yield* workflow.run(
        {
          action: "reference",
          task_id: initial.task.id,
          source: "web",
          evidence_urls: [url],
          conditions: { ...CookingRecipe.emptyConditions(), servings: null },
        },
        "session-a",
      )
      expect(repaired.status).toBe("reference_ready")
      expect(calls).toHaveLength(2)
    }),
  )
  it.effect("keeps an explicitly allowed general-knowledge draft with its uncertainty notes", () =>
    Effect.gen(function* () {
      const workflow = yield* CookingWorkflow.Service
      const draft = {
        ...recipe,
        source_ids: [],
        ingredients: recipe.ingredients.map((item) => ({ ...item, estimated: true })),
        seasonings: recipe.seasonings.map((item) => ({ ...item, estimated: true })),
      }
      answers.push(JSON.stringify({ status: "ready", recipe: draft, notes: ["未经来源核实的通用知识草稿。"] }))
      const result = yield* workflow.run({ action: "reference", dish: recipe.name, allow_draft: true }, "session-a")
      expect(result.status).toBe("reference_ready")
      expect(result.task.reference?.source_ids).toEqual([])
      expect(result.task.reference_notes).toContain("未经来源核实的通用知识草稿。")
      expect(calls).toHaveLength(1)
    }),
  )
  it.effect("repairs an ambiguous extraction with schema feedback instead of discarding a valid recipe", () =>
    Effect.gen(function* () {
      const knowledge = yield* CookingKnowledge.Service
      const workflow = yield* CookingWorkflow.Service
      const url = "https://example.test/repair-extraction"
      yield* knowledge.recordPage("session-a", url, CookingRecipe.render(recipe))
      const sourced = { ...recipe, source_ids: [`web:${url}`] }
      answers.push(
        JSON.stringify({ recipe: sourced, gaps: ["盐用量为估算"] }),
        JSON.stringify({ status: "ready", recipe: sourced, notes: ["盐用量为估算"] }),
      )
      const result = yield* workflow.run(
        { action: "reference", dish: recipe.name, source: "web", evidence_urls: [url] },
        "session-a",
      )
      expect(result.status).toBe("reference_ready")
      expect(calls).toHaveLength(2)
      const corrections = JSON.parse(calls[1]!.split("Correction requirements:\n")[1])
      expect(corrections).toHaveLength(1)
      expect(corrections[0]).toContain('"status"')
    }),
  )
  it.effect("retains a supplied recipe and does not invent an adaptation for an already met preference", () =>
    Effect.gen(function* () {
      const workflow = yield* CookingWorkflow.Service
      answers.push(JSON.stringify({ needs_adaptation: false, reasons: [], questions: [] }))
      const result = yield* workflow.run(
        {
          action: "personalize",
          dish: recipe.name,
          provided_recipe: recipe,
          conditions: { ...CookingRecipe.emptyConditions(), preferences: ["家常口味"] },
        },
        "session-a",
      )
      expect(result.status).toBe("reference_ready")
      expect(result.task.reference?.ingredients).toEqual(recipe.ingredients)
      expect(result.task.personalized).toBeUndefined()
      expect(result.task.evidence?.external?.[0]?.source).toBe("conversation-recipe")
      expect(result.task.evidence?.external?.[0]?.author).not.toBe("用户")
      expect(result.task.evidence?.status).toBe("not_searched")
      expect(calls).toHaveLength(1)
    }),
  )
  it.effect("adapts a serving mismatch, records reasons, and invalidates an old adaptation on new conditions", () =>
    Effect.gen(function* () {
      const knowledge = yield* CookingKnowledge.Service
      const workflow = yield* CookingWorkflow.Service
      yield* knowledge.import([passage])
      const initial = yield* workflow.run(
        { action: "reference", dish: "番茄炒蛋", conditions: { ...CookingRecipe.emptyConditions(), servings: 1 } },
        "session-a",
      )
      expect(initial.status).toBe("needs_adaptation")
      expect(initial.task.personalized).toBeUndefined()
      expect(calls).toHaveLength(0)
      const adapted = {
        ...recipe,
        servings: 1,
        ingredients: recipe.ingredients.map((item) => ({ ...item, quantity: item.quantity / 2, estimated: true })),
        seasonings: recipe.seasonings.map((item) => ({ ...item, quantity: item.quantity / 2, estimated: true })),
      }
      answers.push(JSON.stringify(adapted), JSON.stringify({ explanation: "根据一人份要求减少原料用量。" }))
      const result = yield* workflow.run(
        {
          action: "personalize",
          task_id: initial.task.id,
          conditions: { ...CookingRecipe.emptyConditions(), servings: 1 },
        },
        "session-a",
      )
      expect(result.status).toBe("personalized")
      expect(result.task.reference?.servings).toBe(2)
      expect(result.task.personalized?.servings).toBe(1)
      expect(result.transition).toMatchObject({ reference: "reused", source_action: "none" })
      expect(CookingWorkflow.describe(result)).toMatchObject({
        phase: "recipe_ready",
        current_recipe_kind: "personalized",
        reference_recipe: { name: recipe.name, servings: 2, source_ids: [passage.id] },
      })
      const updated = yield* workflow.run(
        {
          action: "reference",
          task_id: initial.task.id,
          conditions: { ...CookingRecipe.emptyConditions(), servings: 2 },
        },
        "session-a",
      )
      expect(updated.task.personalized).toBeUndefined()
      expect(updated.transition).toEqual({
        cause: "conditions_changed",
        changed_fields: ["servings"],
        reference: "reused",
        source_action: "none",
      })
      expect(updated.task.revision).toBeGreaterThan(result.task.revision)
      expect(calls).toHaveLength(2)
    }),
  )
  it.effect(
    "merges a changed condition without losing quantities and reuses an unchanged request without another revision",
    () =>
      Effect.gen(function* () {
        const knowledge = yield* CookingKnowledge.Service
        const workflow = yield* CookingWorkflow.Service
        yield* knowledge.import([passage])
        answers.push(JSON.stringify({ needs_adaptation: false, reasons: [], questions: [] }))
        const initial = yield* workflow.run(
          {
            action: "reference",
            dish: recipe.name,
            conditions: {
              ingredients: [{ name: "鸡蛋", quantity: 2, unit: "个" }],
              equipment: ["铁锅"],
              excluded: ["糖"],
              preferences: ["咸口"],
            },
          },
          "session-a",
        )
        // Only the taste changes; the user's quantities and other restrictions remain facts.
        answers.push(JSON.stringify({ needs_adaptation: false, reasons: [], questions: [] }))
        const changed = yield* workflow.run(
          { action: "reference", task_id: initial.task.id, conditions: { preferences: ["家常口味"] } },
          "session-a",
        )
        expect(changed.task.conditions.ingredients).toEqual([{ name: "鸡蛋", quantity: 2, unit: "个" }])
        expect(changed.task.conditions.excluded).toEqual(["糖"])
        expect(changed.task.conditions.equipment).toEqual(["铁锅"])
        expect(changed.task.reference).toEqual(recipe)
        const repeated = yield* workflow.run(
          { action: "reference", task_id: initial.task.id, conditions: { preferences: ["家常口味"] } },
          "session-a",
        )
        expect(repeated.reused).toBe(true)
        expect(repeated.task.revision).toBe(changed.task.revision)
        expect(repeated.ready_for_guidance).toBe(true)
        expect(answers).toHaveLength(0)
      }),
  )
  it.effect("repairs an actual recipe violation internally instead of reopening cooking questions", () =>
    Effect.gen(function* () {
      const knowledge = yield* CookingKnowledge.Service
      const workflow = yield* CookingWorkflow.Service
      yield* knowledge.import([passage])
      answers.push(JSON.stringify({ needs_adaptation: true, reasons: ["用户希望盐更少"], questions: [] }))
      const initial = yield* workflow.run(
        { action: "reference", dish: recipe.name, conditions: { preferences: ["盐少一点"] } },
        "session-a",
      )
      expect(initial.ready_for_guidance).toBe(false)
      expect(initial.recipe_text).toBeUndefined()
      expect(initial.next_action).toBe("adapt_recipe")
      const adapted = { ...recipe, seasonings: [{ ...recipe.seasonings[0], quantity: 1, estimated: true }] }
      answers.push(
        JSON.stringify(recipe),
        JSON.stringify({ errors: ["盐仍是2克，应减少到1克"] }),
        JSON.stringify(adapted),
        JSON.stringify({ errors: [] }),
        JSON.stringify({ explanation: "根据少盐要求将盐减至1克。" }),
      )
      const result = yield* workflow.run({ action: "personalize", task_id: initial.task.id }, "session-a")
      expect(result.status).toBe("personalized")
      expect(result.ready_for_guidance).toBe(true)
      expect(result.task.personalized?.seasonings[0].quantity).toBe(1)
      expect(result.task.assessment?.questions).toEqual([])
      expect(calls[3]).toContain("盐仍是2克")
      expect(calls[3]).toContain("previous_output")
      expect(answers).toHaveLength(0)
    }),
  )
  it.effect("removes routine assessment questions before they can block personalization", () =>
    Effect.gen(function* () {
      const knowledge = yield* CookingKnowledge.Service
      const workflow = yield* CookingWorkflow.Service
      yield* knowledge.import([passage])
      answers.push(
        JSON.stringify({
          needs_adaptation: true,
          reasons: ["用户要求少盐"],
          questions: ["盐减到多少克？", "盐是先放还是后放？"],
        }),
        JSON.stringify({ ask_indices: [], reason: "用量与顺序由菜谱决定" }),
      )
      const initial = yield* workflow.run(
        { action: "reference", dish: recipe.name, conditions: { preferences: ["少盐"] } },
        "session-a",
        { id: "user-1", text: "盐少一点，用量和顺序你决定" },
      )
      expect(initial.status).toBe("needs_adaptation")
      expect(initial.task.assessment?.questions).toEqual([])
      expect(initial.next_action).toBe("adapt_recipe")
      const adapted = { ...recipe, seasonings: [{ ...recipe.seasonings[0], quantity: 1, estimated: true }] }
      answers.push(
        JSON.stringify(adapted),
        JSON.stringify({ errors: [] }),
        JSON.stringify({ explanation: "按少盐要求将盐减至1克。" }),
      )
      const result = yield* workflow.run({ action: "personalize", task_id: initial.task.id }, "session-a")
      expect(result.ready_for_guidance).toBe(true)
      expect(result.task.reference).toEqual(recipe)
      expect(result.task.personalized?.seasonings[0].quantity).toBe(1)
      expect(result.transition).toMatchObject({ reference: "reused", source_action: "none" })
      expect(answers).toHaveLength(0)
    }),
  )
  it.effect("retains an essential requested clarification and clears it after new user facts arrive", () =>
    Effect.gen(function* () {
      const knowledge = yield* CookingKnowledge.Service
      const workflow = yield* CookingWorkflow.Service
      yield* knowledge.import([passage])
      answers.push(
        JSON.stringify({ needs_adaptation: true, reasons: [], questions: ["这道菜给几个人吃？"] }),
        JSON.stringify({ ask_indices: [0], reason: "用户明确要求先询问人数" }),
      )
      const initial = yield* workflow.run(
        { action: "reference", dish: recipe.name, conditions: { preferences: ["先确认用餐人数"] } },
        "session-a",
        { id: "user-1", text: "先问我用餐人数再改份量" },
      )
      expect(initial.status).toBe("needs_clarification")
      expect(CookingWorkflow.describe(initial).phase).toBe("awaiting_user_fact")
      const adapted = {
        ...recipe,
        servings: 4,
        ingredients: recipe.ingredients.map((item) => ({ ...item, quantity: item.quantity * 2 })),
        seasonings: recipe.seasonings.map((item) => ({ ...item, quantity: item.quantity * 2 })),
      }
      answers.push(
        JSON.stringify({ needs_adaptation: false, reasons: [], questions: [] }),
        JSON.stringify(adapted),
        JSON.stringify({ errors: [] }),
        JSON.stringify({ explanation: "根据已确认的四人份调整用量。" }),
      )
      const result = yield* workflow.run(
        { action: "personalize", task_id: initial.task.id, conditions: { servings: 4 } },
        "session-a",
        { id: "user-2", text: "四个人，直接按原来的参考改" },
      )
      expect(result.ready_for_guidance).toBe(true)
      expect(result.task.id).toBe(initial.task.id)
      expect(result.task.reference).toEqual(recipe)
      expect(result.task.personalized?.servings).toBe(4)
      expect(result.task.assessment?.questions).toEqual([])
      expect(result.transition).toEqual({
        cause: "conditions_changed",
        changed_fields: ["servings"],
        reference: "reused",
        source_action: "none",
      })
      expect(answers).toHaveLength(0)
    }),
  )
  it.effect("does not let a failed preparation become executable just because the baseline validates", () =>
    Effect.gen(function* () {
      const knowledge = yield* CookingKnowledge.Service
      const workflow = yield* CookingWorkflow.Service
      yield* knowledge.import([passage])
      answers.push(JSON.stringify({ needs_adaptation: true, reasons: ["需要少盐"], questions: [] }))
      const initial = yield* workflow.run(
        { action: "reference", dish: recipe.name, conditions: { preferences: ["少盐"] } },
        "session-a",
      )
      answers.push("not json", "not json", "not json")
      const failed = yield* workflow
        .run({ action: "personalize", task_id: initial.task.id }, "session-a")
        .pipe(Effect.exit)
      expect(Exit.isFailure(failed)).toBe(true)
      const saved = yield* workflow.run({ action: "get", task_id: initial.task.id }, "session-a")
      expect(saved.status).toBe("validation_failed")
      expect(saved.ready_for_guidance).toBe(false)
      expect(saved.recipe_text).toBeUndefined()
    }),
  )
  it.effect("reuses a retry within one user request but generates new suggestions for a new request", () =>
    Effect.gen(function* () {
      const workflow = yield* CookingWorkflow.Service
      answers.push(JSON.stringify({ candidates: [{ name: "西红柿炒鸡蛋", reason: "经典搭配", source_ids: [] }] }))
      const first = yield* workflow.run({ action: "suggest", count: 1 }, "session-a", {
        id: "user-1",
        text: "推荐一道菜",
      })
      const retry = yield* workflow.run({ action: "suggest", count: 1, task_id: first.task.id }, "session-a", {
        id: "user-1",
        text: "推荐一道菜",
      })
      expect(retry.reused).toBe(true)
      expect(calls).toHaveLength(1)
      answers.push(JSON.stringify({ candidates: [{ name: "番茄蛋汤", reason: "换一种做法", source_ids: [] }] }))
      const next = yield* workflow.run({ action: "suggest", count: 1, task_id: first.task.id }, "session-a", {
        id: "user-2",
        text: "换一道，别重复刚才的",
      })
      expect(next.reused).not.toBe(true)
      expect(next.task.candidates[0].name).toBe("番茄蛋汤")
      expect(calls[1]).toContain("换一道，别重复刚才的")
      expect(calls[1]).toContain("西红柿炒鸡蛋")
      expect(calls).toHaveLength(2)
    }),
  )
  it.effect("bounds correction attempts and prevents cross-session access", () =>
    Effect.gen(function* () {
      const workflow = yield* CookingWorkflow.Service
      answers.push("not json", "not json", "not json")
      const failure = yield* workflow.run({ action: "suggest" }, "session-a").pipe(Effect.exit)
      expect(Exit.isFailure(failure)).toBe(true)
      expect(calls).toHaveLength(3)
      answers.push(JSON.stringify({ candidates: [{ name: "炒鸡蛋", reason: "简单", source_ids: [] }] }))
      const task = yield* workflow.run({ action: "suggest" }, "session-a")
      const forbidden = yield* workflow.run({ action: "get", task_id: task.task.id }, "session-b").pipe(Effect.exit)
      expect(Exit.isFailure(forbidden)).toBe(true)
    }),
  )
})
