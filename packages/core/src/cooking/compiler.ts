export * as CookingCompiler from "./compiler.js"

import { Context, Effect, Layer, Schema } from "effect"
import { Cooking } from "@opencook/schema/cooking"
import { makeLocationNode } from "@opencook/util/effect/app-node"
import { CookingWorkflow } from "./workflow.js"
import { CookingScore } from "./score.js"
import { Generate } from "../generate.js"
import PROGRAM from "./prompts/program.txt"
import ACTIONS from "./prompts/actions.txt"

const Program = Schema.Struct({
  steps: Schema.Array(
    Schema.Union([
      Schema.Struct({ ...Cooking.Step.fields, continuous: Schema.Literal(false) }),
      Schema.Struct({
        ...Cooking.Step.fields,
        continuous: Schema.Literal(true),
        heat: Schema.Literals(["大火", "中火", "小火", "关闭"]),
      }),
    ]),
  ).check(Schema.isNonEmpty(), Schema.isMaxLength(160)),
})
const Actions = Schema.Struct({
  steps: Schema.Array(
    Schema.Union([
      Schema.Struct({
        source_step: Schema.Int.check(Schema.isGreaterThan(0)),
        verb: Schema.Literals(["清洗", "剖开", "沥干", "抓拌", "搅匀", "静置", "加热", "炒", "炸"]),
        object: Schema.Trim.check(Schema.isNonEmpty()),
      }),
      Schema.Struct({
        source_step: Schema.Int.check(Schema.isGreaterThan(0)),
        verb: Schema.Literal("切"),
        object: Schema.Trim.check(Schema.isNonEmpty()),
        shape: Schema.Trim.check(Schema.isNonEmpty()),
      }),
      Schema.Struct({
        source_step: Schema.Int.check(Schema.isGreaterThan(0)),
        verb: Schema.Literal("剔除"),
        object: Schema.Trim.check(Schema.isNonEmpty()),
        from: Schema.Trim.check(Schema.isNonEmpty()),
      }),
      Schema.Struct({
        source_step: Schema.Int.check(Schema.isGreaterThan(0)),
        verb: Schema.Literal("加入"),
        object: Schema.Trim.check(Schema.isNonEmpty()),
        to: Schema.Trim.check(Schema.isNonEmpty()),
      }),
      Schema.Struct({
        source_step: Schema.Int.check(Schema.isGreaterThan(0)),
        verb: Schema.Literal("取出"),
        object: Schema.Trim.check(Schema.isNonEmpty()),
        from: Schema.Trim.check(Schema.isNonEmpty()),
        to: Schema.Trim.check(Schema.isNonEmpty()),
      }),
      Schema.Struct({
        source_step: Schema.Int.check(Schema.isGreaterThan(0)),
        verb: Schema.Literal("调火"),
        heat: Schema.Literals(["大火", "中火", "小火", "关闭"]),
      }),
    ]),
  ).check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
})

export interface Interface {
  readonly compile: (
    taskID: string,
    revision: number,
    sessionID: string,
  ) => Effect.Effect<Cooking.Plan, Cooking.Invalid>
}
export class Service extends Context.Service<Service, Interface>()("@opencook/CookingCompiler") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const workflow = yield* CookingWorkflow.Service
    const generate = yield* Generate.Service
    const convert = <A>(schema: Schema.Codec<A>, prompt: string, validate: (value: A) => void) =>
      Effect.gen(function* () {
        let correction = ""
        let failure = ""
        for (let attempt = 0; attempt < 3; attempt++) {
          const text = (yield* generate
            .text({ prompt: prompt + correction })
            .pipe(Effect.mapError(() => new Cooking.Invalid({ message: "烹饪流程生成失败，请检查对话模型服务" }))))
            .trim()
            .replace(/^```[^\n]*\n|\n```$/g, "")
          const result = yield* Effect.try({
            try: () => {
              const value = Schema.decodeUnknownSync(Schema.fromJsonString(schema))(text)
              validate(value)
              return value
            },
            catch: (error) => String(error),
          }).pipe(Effect.result)
          if (result._tag === "Success") return result.success
          failure = result.failure
          correction = `\n上次输出：\n${text}\n修正要求：${result.failure}\n重新输出完整 JSON 对象，不要输出标题、分析、解释或代码块。`
        }
        return yield* new Cooking.Invalid({ message: `烹饪流程校验失败（已尝试3次）：${failure}` })
      })
    return Service.of({
      compile: Effect.fn(function* (taskID, revision, sessionID) {
        const result = yield* workflow
          .run({ action: "get", task_id: taskID }, sessionID)
          .pipe(Effect.mapError((error) => new Cooking.Invalid({ message: error.message })))
        if (result.task.revision !== revision)
          return yield* new Cooking.Invalid({ message: "菜谱版本已改变，请读取最新菜谱后再开始指导" })
        if (result.status !== "ready" || !result.recipe_text)
          return yield* new Cooking.Invalid({ message: "菜谱尚未准备完成，请先解决菜谱中的缺口或冲突" })
        const generated = yield* convert(Program, PROGRAM.replace("{recipe}", result.recipe_text), (value) => {
          const errors: string[] = []
          for (const step of value.steps)
            if (!step.continuous && (step.seconds !== 0 || step.conditions.length || step.logic))
              errors.push("瞬时动作必须 seconds=0、conditions=[]、logic=空字符串")
          for (const [index, step] of value.steps.entries())
            if (step.continuous) {
              if (/(加入|倒入|放入|取出|捞出)/.test(step.action))
                errors.push(
                  `第${index + 1}步持续动作“${step.action}”必须拆出加入/取出等瞬时操作，持续动作只写“加热对象”“炒对象”或“炸对象”`,
                )
            }
          for (const step of value.steps)
            for (const [index] of step.conditions.entries())
              if (!step.logic.includes(`{${index}}`)) errors.push("每个传感器条件都必须在 logic 中引用")
          if (errors.length) throw new Error(errors.join("；"))
          CookingScore.parse(CookingScore.render(value.steps))
        })
        const steps: Cooking.Step[] = []
        for (const raw of generated.steps) {
          const action = raw.action
            .replace(/^调火至(中小火|微火|文火)$/, "调火至小火")
            .replace(/^调火至中大火$/, "调火至中火")
          const step = { ...raw, action }
          if (action.startsWith("调火至") && !/^调火至(大火|中火|小火|关闭)$/.test(action))
            return yield* new Cooking.Invalid({ message: `火力编译失败：${action}，执行器支持大火、中火、小火、关闭` })
          if (step.continuous && steps.at(-1)?.action !== `调火至${step.heat}`)
            steps.push({ action: `调火至${step.heat}`, continuous: false, seconds: 0, conditions: [], logic: "" })
          steps.push(step)
        }
        const program = CookingScore.render(steps)
        const materialize = (value: typeof Actions.Type) => {
          const order = value.steps.map((step) => step.source_step)
          for (const [index, step] of steps.entries()) {
            const count = order.filter((id) => id === index + 1).length
            if (count < 1 || (step.continuous && count !== 1)) throw new Error("必须完整保留原步骤，持续动作不得拆分")
          }
          if (order.some((id, index) => id > steps.length || (index > 0 && id < order[index - 1])))
            throw new Error("source_step 必须按原步骤顺序引用，不能新增或跳过步骤")
          return CookingScore.render(
            value.steps.map((step) => {
              const source = steps[step.source_step - 1]
              const action =
                step.verb === "切"
                  ? `切${step.object}成${step.shape}`
                  : step.verb === "剔除"
                    ? `剔除${step.object}从${step.from}`
                    : step.verb === "加入"
                      ? `加入${step.object}到${step.to}`
                      : step.verb === "取出"
                        ? `取出${step.object}从${step.from}到${step.to}`
                        : step.verb === "调火"
                          ? `调火至${step.heat}`
                          : `${step.verb}${step.object}`
              if (source.action.startsWith("调火至") && source.action !== action)
                throw new Error(`第${step.source_step}步必须保持原火力：${source.action}`)
              return { ...source, action }
            }),
          )
        }
        const normalized = yield* convert(Actions, ACTIONS.replace("{program}", program), (value) => {
          CookingScore.validateActions(program, materialize(value))
        })
        const actions = materialize(normalized)
        const latest = yield* workflow
          .run({ action: "get", task_id: taskID }, sessionID)
          .pipe(Effect.mapError((error) => new Cooking.Invalid({ message: error.message })))
        if (latest.task.revision !== revision || latest.status !== "ready")
          return yield* new Cooking.Invalid({ message: "准备期间菜谱发生变化，请核对最新菜谱后重新开始指导" })
        return {
          task_id: taskID,
          revision,
          dish: result.task.dish!,
          recipe_text: result.recipe_text,
          program,
          actions,
          steps: CookingScore.validateActions(program, actions),
        }
      }),
    })
  }),
)
export const node = makeLocationNode({ service: Service, layer, deps: [CookingWorkflow.node, Generate.node] })
