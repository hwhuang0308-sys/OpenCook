export * as CookingScore from "./score.js"

import { Cooking } from "@opencook/schema/cooking"

// Parse only the condition language emitted by the cooking compiler. No eval.
export function evaluate(logic: string, values: readonly boolean[]) {
  const tokens = logic.match(/\{\d+\}|and|or|\(|\)/g) ?? []
  if (tokens.join("") !== logic.replace(/\s/g, "")) throw new Error("判定条件包含无效逻辑")
  let index = 0
  const atom = (): boolean => {
    const token = tokens[index++]
    if (token === "(") {
      const value = expression()
      if (tokens[index++] !== ")") throw new Error("判定条件括号不匹配")
      return value
    }
    if (!token || !/^\{\d+\}$/.test(token)) throw new Error("判定条件缺少传感器")
    const position = Number(token.slice(1, -1))
    if (position >= values.length) throw new Error("判定条件引用了不存在的传感器")
    return values[position]
  }
  const conjunction = (): boolean => {
    let value = atom()
    while (tokens[index] === "and") {
      index++
      const next = atom()
      value = value && next
    }
    return value
  }
  const expression = (): boolean => {
    let value = conjunction()
    while (tokens[index] === "or") {
      index++
      const next = conjunction()
      value = value || next
    }
    return value
  }
  const result = expression()
  if (index !== tokens.length) throw new Error("判定条件逻辑不完整")
  return result
}

export function parse(text: string): Cooking.Step[] {
  return text
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      const match = line.trim().match(/^第\s*(\d+)\s*步[，,]\s*do\s*(.+?)(?:[，,]\s*until\s*(.+))?$/i)
      if (!match || Number(match[1]) !== index + 1)
        throw new Error(`第${index + 1}步格式或编号无效：${line.slice(0, 300)}`)
      const action = match[2].trim().replace(/[，,]$/, "")
      if (!match[3]) return { action, continuous: false, seconds: 0, conditions: [], logic: "" }
      const duration = match[3].match(/^(.*?)[，,]\s*<推荐时长\s*[:：]\s*(\d+)\s*s>$/)
      if (!duration || Number(duration[2]) <= 0) throw new Error(`第${index + 1}步缺少推荐时长`)
      const conditions: Cooking.Condition[] = []
      const logic = duration[1]
        .replace(
          /<(视觉|温度|声音)判定条件\s*[:：]\s*\[\s*([\d.]+)\s*s\s*\]\s*时长内满足条件\s*\[\s*([^\]]+?)\s*\]\s*>/g,
          (_, kind: string, seconds: string, condition: string) => {
            if (!Number.isFinite(Number(seconds))) throw new Error("传感器时长无效")
            const type = kind === "视觉" ? "visual" : kind === "温度" ? "temperature" : "audio"
            if (type !== "visual") {
              const threshold = condition.match(
                type === "temperature"
                  ? /^(空锅|食用油|锅中食材表面)温度大于等于\s*(\d+(?:\.\d+)?)\s*[℃°]/
                  : /^声音强度变化量大于等于\s*(\d+(?:\.\d+)?)\s*dB$/,
              )
              const value = Number(threshold?.[type === "temperature" ? 2 : 1])
              if (!threshold || value < (type === "temperature" ? 0 : 3) || value > (type === "temperature" ? 160 : 8))
                throw new Error("传感器条件或阈值不符合设备范围")
            }
            conditions.push({ type, duration: Number(seconds), condition })
            return `{${conditions.length - 1}}`
          },
        )
        .trim()
      try {
        evaluate(
          logic,
          conditions.map(() => false),
        )
      } catch (error) {
        throw new Error(`第${index + 1}步判定条件格式错误：${duration[1]}；${String(error)}`)
      }
      if (!conditions.length) throw new Error("持续动作缺少判定条件")
      return { action, continuous: true, seconds: Number(duration[2]), conditions, logic }
    })
}

export function validateActions(program: string, actions: string) {
  const original = parse(program)
  const steps = parse(actions)
  if (!steps.length) throw new Error("动作谱为空")
  const suffixes = (text: string) =>
    text.split(/\r?\n/).flatMap((line) => {
      const index = line.indexOf("until")
      return index < 0 ? [] : [line.slice(index).trim()]
    })
  if (JSON.stringify(suffixes(program)) !== JSON.stringify(suffixes(actions)))
    throw new Error("动作谱改变了程序谱的判定条件或推荐时长")
  if (steps.filter((step) => step.continuous).length !== original.filter((step) => step.continuous).length)
    throw new Error("持续动作数发生变化")
  const templates =
    /^(清洗.+|切.+成.+|剔除.+从.+|剖开.+|沥干.+|抓拌.+|搅匀.+|静置.+|加热.+|炒.+|炸.+|加入.+到.+|取出.+从.+到.+|调火至(?:大火|中火|小火|关闭))$/
  for (const [index, step] of steps.entries()) {
    if (!templates.test(step.action) || /[<>]|炒锅/.test(step.action)) throw new Error(`动作不符合模板：${step.action}`)
    if (step.continuous && !/^(加热|炒|炸)/.test(step.action))
      throw new Error(
        `第${index + 1}步“${step.action}”是一次性动作，不能保留持续动作条件；应使用与原持续动作对应的加热、炒或炸模板`,
      )
  }
  return steps
}

export function render(steps: readonly Cooking.Step[]) {
  return steps
    .map((step, index) => {
      const prefix = `第${index + 1}步，do ${step.action}`
      if (!step.continuous) return prefix
      const expression = step.logic.replace(/\{(\d+)\}/g, (_, value: string) => {
        const condition = step.conditions[Number(value)]
        if (!condition) throw new Error("判定条件引用了不存在的传感器")
        const name = condition.type === "visual" ? "视觉" : condition.type === "audio" ? "声音" : "温度"
        return `<${name}判定条件:[${condition.duration} s]时长内满足条件[${condition.condition}]>`
      })
      return `${prefix}，until ${expression}，<推荐时长: ${step.seconds}s>`
    })
    .join("\n")
}
