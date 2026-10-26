import { expect, test } from "bun:test"
import type { Cooking } from "@opencook/schema/cooking"
import { CookingNarration } from "../src/util/cooking-narration"

const run: Cooking.Run = {
  id: "run-a",
  session_id: "session-a",
  status: "running",
  index: 0,
  elapsed_ms: 0,
  started_at: 0,
  updated_at: 0,
  completions: [],
  plan: {
    task_id: "recipe-a",
    revision: 1,
    dish: "测试",
    recipe_text: "测试",
    program: "测试",
    actions: "测试",
    steps: ["清洗土豆", "切土豆成片", "加入土豆到锅"].map((action) => ({
      action,
      continuous: false,
      seconds: 0,
      conditions: [],
      logic: "",
    })),
  },
}
const audio = (value: number): Cooking.Speech => ({
  status: "ready",
  audio: Buffer.from([value]).toString("base64"),
  voice: "fixture",
})

test("late synthesis is discarded and fast steps replace the single pending utterance", async () => {
  const first = Promise.withResolvers<Cooking.Speech>()
  const played = Promise.withResolvers<number>()
  const requested: number[] = []
  const signals: AbortSignal[] = []
  const narrator = new CookingNarration({
    synthesize: async (request, signal) => {
      requested.push(request.index)
      signals.push(signal)
      return request.index === 0 ? first.promise : audio(request.index)
    },
    play: async (bytes) => {
      played.resolve(bytes[0])
    },
    error: () => {
      throw new Error("unexpected speech error")
    },
  })
  narrator.update(run)
  narrator.update({ ...run, index: 1 })
  narrator.update({ ...run, index: 2 })
  expect(signals[0].aborted).toBe(true)
  first.resolve(audio(0))
  expect(await played.promise).toBe(2)
  expect(requested).toEqual([0, 2])
  await narrator.dispose()
})

test("a new step stops playback before playing the latest step, with no overlap", async () => {
  const initial = Promise.withResolvers<void>()
  const latest = Promise.withResolvers<void>()
  const events: string[] = []
  let active = 0
  const narrator = new CookingNarration({
    synthesize: async (request) => audio(request.index),
    play: async (bytes, signal) => {
      expect(++active).toBe(1)
      events.push(`start:${bytes[0]}`)
      if (bytes[0] === 0) initial.resolve()
      if (bytes[0] === 2) latest.resolve()
      await new Promise<void>((resolve) => {
        const stop = () => {
          events.push(`stop:${bytes[0]}`)
          active--
          resolve()
        }
        if (signal.aborted) stop()
        else signal.addEventListener("abort", stop, { once: true })
      })
    },
    error: () => {
      throw new Error("unexpected playback error")
    },
  })
  narrator.update(run)
  await initial.promise
  narrator.update({ ...run, index: 1 })
  narrator.update({ ...run, index: 2 })
  await latest.promise
  expect(events).toEqual(["start:0", "stop:0", "start:2"])
  await narrator.dispose()
  expect(events.at(-1)).toBe("stop:2")
  expect(active).toBe(0)
})

test.each(["paused", "stopped", "completed", "muted"])(
  "%s cancels in-flight synthesis and never plays its response",
  async (status) => {
    const pending = Promise.withResolvers<Cooking.Speech>()
    let signal: AbortSignal | undefined
    const played: number[] = []
    const narrator = new CookingNarration({
      synthesize: async (_, input) => {
        signal = input
        return pending.promise
      },
      play: async (data) => {
        played.push(data[0])
      },
      error: () => {},
    })
    narrator.update(run)
    if (status === "muted") narrator.update(run, true)
    else narrator.update({ ...run, status: status as Cooking.Run["status"] })
    expect(signal?.aborted).toBe(true)
    pending.resolve(audio(0))
    await narrator.dispose()
    expect(played).toEqual([])
  },
)

test("repeated polling does not repeat a step, while a warning preempts it", async () => {
  const first = Promise.withResolvers<void>()
  const warning = Promise.withResolvers<void>()
  const calls: string[] = []
  const narrator = new CookingNarration({
    synthesize: async (request) => {
      calls.push(request.kind)
      return audio(request.kind === "warning" ? 1 : 0)
    },
    play: async (data, signal) => {
      if (data[0] === 1) {
        warning.resolve()
        return
      }
      first.resolve()
      await new Promise<void>((resolve) =>
        signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true }),
      )
    },
    error: () => {},
  })
  narrator.update(run)
  await first.promise
  narrator.update({ ...run })
  expect(calls).toEqual(["step"])
  narrator.update({ ...run, warning: "请均匀翻炒" })
  await warning.promise
  narrator.update({ ...run, warning: "请均匀翻炒" })
  expect(calls).toEqual(["step", "warning"])
  await narrator.dispose()
})

test("synthesis failure is reported without breaking subsequent narration", async () => {
  const failed = Promise.withResolvers<void>()
  const played = Promise.withResolvers<void>()
  const narrator = new CookingNarration({
    synthesize: async (request) => {
      if (!request.index) throw new Error("fixture synthesis failed")
      return audio(1)
    },
    play: async () => {
      played.resolve()
    },
    error: () => {
      failed.resolve()
    },
  })
  narrator.update(run)
  await failed.promise
  narrator.update({ ...run, index: 1 })
  await played.promise
  await narrator.dispose()
})

test("a paused emergency interrupts ordinary speech and each emergency step has its own identity", async () => {
  const pending = Promise.withResolvers<Cooking.Speech>()
  const played = Promise.withResolvers<void>()
  const requests: Cooking.SpeechRequest[] = []
  const signals: AbortSignal[] = []
  const narrator = new CookingNarration({
    synthesize: async (request, signal) => {
      requests.push(request)
      signals.push(signal)
      return request.kind === "emergency" ? audio(9) : pending.promise
    },
    play: async (data) => {
      expect(data[0]).toBe(9)
      played.resolve()
    },
    error: () => {
      throw new Error("Unexpected narration error")
    },
  })
  narrator.update(run)
  narrator.update({
    ...run,
    status: "paused",
    emergency: {
      id: "incident-fire",
      kind: "fire",
      index: 0,
      steps: ["立即关火"],
      interrupted_step: 0,
      time: 0,
    },
  })
  expect(signals[0].aborted).toBe(true)
  pending.resolve(audio(0))
  await played.promise
  expect(requests.at(-1)).toMatchObject({ kind: "emergency", emergency_id: "incident-fire", emergency_index: 0 })
  await narrator.dispose()
})

test.each(["stopped", "completed"] as const)(
  "%s cancels speech even when an unresolved emergency is retained",
  async (status) => {
    const pending = Promise.withResolvers<Cooking.Speech>()
    const requests: Cooking.SpeechRequest[] = []
    const played: number[] = []
    let signal: AbortSignal | undefined
    const narrator = new CookingNarration({
      synthesize: async (request, input) => {
        requests.push(request)
        signal = input
        return pending.promise
      },
      play: async (data) => {
        played.push(data[0])
      },
      error: () => {
        throw new Error("Unexpected narration error")
      },
    })
    const emergency: Cooking.Run = {
      ...run,
      status: "paused",
      emergency: { id: "incident-fire", kind: "fire", index: 0, steps: ["立即关火"], interrupted_step: 0, time: 0 },
    }
    try {
      narrator.update(emergency)
      expect(requests).toHaveLength(1)
      narrator.update({ ...emergency, status })
      expect(signal?.aborted).toBe(true)
      pending.resolve(audio(9))
      await narrator.dispose()
      expect(played).toEqual([])
      expect(requests).toHaveLength(1)
    } finally {
      pending.resolve(audio(9))
      await narrator.dispose()
    }
  },
)
