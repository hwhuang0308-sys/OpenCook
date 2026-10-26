export * as CookingRecipe from "./recipe.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

const Text = Schema.Trim.check(Schema.isNonEmpty())
const Line = Text.check(Schema.isPattern(/^[^\r\n]+$/))
export const Quantity = Schema.Finite.check(Schema.isGreaterThan(0))

export const Ingredient = Schema.Struct({
  name: Line,
  quantity: Quantity,
  unit: Line,
  estimated: Schema.Boolean,
})

export const Recipe = Schema.Struct({
  name: Line,
  servings: Quantity,
  ingredients: Schema.Array(Ingredient).check(Schema.isNonEmpty()),
  seasonings: Schema.Array(Ingredient),
  steps: Schema.Array(Schema.Struct({ text: Line, uses: Schema.Array(Line) })).check(Schema.isNonEmpty()),
  equipment: Schema.Array(Text),
  minutes: Quantity,
  source_ids: Schema.Array(Text),
})
export type Recipe = typeof Recipe.Type

export const Stock = Schema.Struct({
  name: Text,
  quantity: optional(Quantity),
  unit: optional(Text),
})

export const Conditions = Schema.Struct({
  ingredients: Schema.Array(Stock),
  seasonings: Schema.Array(Stock),
  inventory_only: Schema.Boolean,
  servings: optional(Quantity),
  minutes: optional(Quantity),
  equipment: Schema.Array(Text),
  equipment_only: optional(Schema.Boolean),
  excluded: Schema.Array(Text),
  dietary_requirements: Schema.Array(Text),
  preferences: Schema.Array(Text),
  regional_context: Schema.Array(Text),
  emotional_context: Schema.Array(Text),
})
export type Conditions = typeof Conditions.Type
export const Changes = Schema.Struct({
  ingredients: optional(Conditions.fields.ingredients),
  seasonings: optional(Conditions.fields.seasonings),
  inventory_only: optional(Schema.Boolean),
  equipment: optional(Conditions.fields.equipment),
  excluded: optional(Conditions.fields.excluded),
  dietary_requirements: optional(Conditions.fields.dietary_requirements),
  preferences: optional(Conditions.fields.preferences),
  regional_context: optional(Conditions.fields.regional_context),
  emotional_context: optional(Conditions.fields.emotional_context),
  servings: optional(Schema.NullOr(Quantity)),
  minutes: optional(Schema.NullOr(Quantity)),
  equipment_only: optional(Schema.NullOr(Schema.Boolean)),
})
export type Changes = typeof Changes.Type

export const emptyConditions = (): Conditions => ({
  ingredients: [],
  seasonings: [],
  inventory_only: false,
  equipment: [],
  excluded: [],
  dietary_requirements: [],
  preferences: [],
  regional_context: [],
  emotional_context: [],
})

const synonyms = [
  ["番茄", "西红柿"],
  ["土豆", "马铃薯"],
  ["盐", "食盐"],
  ["糖", "白砂糖", "白糖"],
  ["水", "清水"],
  ["食用油", "植物油", "油"],
  ["葱", "葱花"],
  ["蒜", "蒜末", "大蒜"],
]

export function canonical(name: string) {
  const normalized = name.normalize("NFKC").replace(/\s/g, "").toLowerCase()
  return synonyms.find((names) => names.includes(normalized))?.[0] ?? normalized
}

const units: Record<string, { dimension: string; scale: number }> = {
  g: { dimension: "mass", scale: 1 },
  克: { dimension: "mass", scale: 1 },
  kg: { dimension: "mass", scale: 1000 },
  千克: { dimension: "mass", scale: 1000 },
  mg: { dimension: "mass", scale: 0.001 },
  毫克: { dimension: "mass", scale: 0.001 },
  ml: { dimension: "volume", scale: 1 },
  毫升: { dimension: "volume", scale: 1 },
  l: { dimension: "volume", scale: 1000 },
  升: { dimension: "volume", scale: 1000 },
}

export const Issue = Schema.Struct({ code: Text, message: Text })
export type Issue = typeof Issue.Type

export function validate(recipe: Recipe, conditions: Conditions, sourceIDs?: ReadonlySet<string>) {
  const errors: Issue[] = []
  const unresolved: Issue[] = []
  const items = [...recipe.ingredients, ...recipe.seasonings]
  const names = items.map((item) => canonical(item.name))
  if (new Set(names).size !== names.length)
    errors.push({ code: "duplicate_ingredient", message: "合并重复的食材或调料" })
  const used = new Set(recipe.steps.flatMap((step) => step.uses.map(canonical)))
  for (const name of names) {
    if (!used.has(name)) errors.push({ code: "unused_ingredient", message: `步骤未使用：${name}` })
  }
  for (const name of used) {
    if (!names.includes(name))
      errors.push({ code: "unlisted_ingredient", message: `步骤使用了清单以外的原料：${name}` })
  }
  for (const item of items) {
    const name = canonical(item.name)
    if (/适量|少许|若干|随意/.test(item.unit))
      errors.push({ code: "vague_unit", message: `${item.name}需要明确的计量单位` })
    if (conditions.excluded.some((excluded) => canonical(excluded) === name))
      errors.push({ code: "excluded_ingredient", message: `用户排除了：${item.name}` })
  }
  // The category in which the user listed an item is not an availability constraint.
  const stock = [...conditions.ingredients, ...conditions.seasonings]
  for (const item of items) {
    const available = stock.filter((entry) => canonical(entry.name) === canonical(item.name))
    if (conditions.inventory_only && available.length === 0) {
      errors.push({ code: "not_in_inventory", message: `库存不包含：${item.name}` })
      continue
    }
    if (!available.length) continue
    const measured = units[item.unit.toLowerCase()] ?? { dimension: item.unit, scale: 1 }
    const comparable = available.filter(
      (entry) =>
        entry.quantity !== undefined &&
        entry.unit !== undefined &&
        (units[entry.unit.toLowerCase()]?.dimension ?? entry.unit) === measured.dimension,
    )
    if (!comparable.length) {
      unresolved.push({ code: "stock_quantity_unknown", message: `${item.name}的可用数量或单位尚未确认` })
      continue
    }
    const total = comparable.reduce(
      (sum, entry) => sum + entry.quantity! * (units[entry.unit!.toLowerCase()]?.scale ?? 1),
      0,
    )
    if (item.quantity * measured.scale > total + 1e-9)
      errors.push({ code: "insufficient_stock", message: `${item.name}的需要量超过已知库存` })
  }
  if (conditions.servings !== undefined && recipe.servings !== conditions.servings)
    errors.push({ code: "servings_mismatch", message: "份量与用户要求不一致" })
  if (conditions.minutes !== undefined && recipe.minutes > conditions.minutes)
    errors.push({ code: "time_exceeded", message: "预计制作时间超过用户限制" })
  if (conditions.equipment_only) {
    for (const equipment of recipe.equipment) {
      if (
        !conditions.equipment.some(
          (item) =>
            canonical(item) === canonical(equipment) || (equipment === "炒锅" && ["铁锅", "不粘锅"].includes(item)),
        )
      )
        errors.push({ code: "missing_equipment", message: `未确认设备可用：${equipment}` })
    }
  }
  if (sourceIDs) {
    for (const id of recipe.source_ids) {
      if (!sourceIDs.has(id)) errors.push({ code: "unknown_source", message: `来源不存在：${id}` })
    }
  }
  return { passed: errors.length === 0, errors, unresolved }
}

export function render(recipe: Recipe) {
  const line = (item: typeof Ingredient.Type) => `${item.name}${item.quantity}${item.unit}`
  return [
    "所需食材：",
    ...recipe.ingredients.map(line),
    "所需调料：",
    ...recipe.seasonings.map(line),
    "烹饪步骤：",
    ...recipe.steps.map((step) => step.text),
  ].join("\n")
}

export function inventoryNames(recipe: Recipe, conditions: Conditions): Recipe {
  const names = new Map(
    [...conditions.ingredients, ...conditions.seasonings].map((item) => [canonical(item.name), item.name]),
  )
  const name = (value: string) => names.get(canonical(value)) ?? value
  return {
    ...recipe,
    ingredients: recipe.ingredients.map((item) => ({ ...item, name: name(item.name) })),
    seasonings: recipe.seasonings.map((item) => ({ ...item, name: name(item.name) })),
    steps: recipe.steps.map((step) => ({ ...step, uses: step.uses.map(name) })),
  }
}
