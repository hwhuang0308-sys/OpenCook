import { expect, test } from "bun:test"
import { TextareaRenderable, TextRenderable } from "@opentui/core"
import { Cooking } from "@opencook/schema/cooking"
import { SessionID } from "@opencook/schema/session-id"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { waitForHighlightedFrame } from "./fixture/frame"

test.each(["completed", "stopped"] as const)(
  "returns %s cooking to chat and removes finished launchers",
  async (outcome) => {
    const session = {
      id: SessionID.make("ses_cooking_recovery"),
      title: "Cooking recovery",
      projectID: "proj_test",
      location: { directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0, updated: 0 },
    }
    let current: Cooking.Run = {
      id: "cooking_recovery",
      session_id: session.id,
      status: "running",
      index: 1,
      elapsed_ms: 4500,
      started_at: 0,
      updated_at: 0,
      completions: [{ step: 0, reason: "confirmed", time: 0 }],
      plan: {
        task_id: "recipe_recovery",
        revision: 2,
        dish: "西红柿炒鸡蛋",
        recipe_text: "测试菜谱",
        program: "测试程序谱",
        actions: "测试动作谱",
        steps: [
          { action: "清洗西红柿", continuous: false, seconds: 0, conditions: [], logic: "" },
          { action: "切西红柿成块", continuous: false, seconds: 0, conditions: [], logic: "" },
        ],
      },
    }
    const controls: Cooking.Control[] = []
    const reports: Cooking.Report[] = []
    const reported = Promise.withResolvers<void>()
    const polled = Promise.withResolvers<void>()
    let prompts = 0
    await using setup = await createAppFixture({
      width: 160,
      height: 48,
      config: { animations: false, tabs: { enabled: false } },
      args: { sessionID: session.id },
      fetch: async (url, request) => {
        if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
        if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
        if (url.pathname === `/api/session/${session.id}/inbox`) return json({ data: [] })
        if (url.pathname === `/api/session/${session.id}/message`) {
          if (request.method === "POST") prompts++
          return json({ data: [], cursor: {} })
        }
        if (url.pathname === "/api/kitchen/cooking") {
          if (reports.length) polled.resolve()
          return json(current)
        }
        if (url.pathname === "/api/kitchen/status")
          return json([
            { id: "camera", state: "connected" },
            { id: "temperature", state: "disconnected" },
            { id: "sound", state: "connecting" },
            { id: "air", state: "disabled" },
          ])
        if (url.pathname === "/api/kitchen/cooking/speech") return json({ status: "disabled" })
        if (url.pathname === "/api/kitchen/cooking/report") {
          reports.push(await request.json())
          reported.resolve()
          return new Response(null, { status: 204 })
        }
        if (url.pathname !== "/api/kitchen/cooking/control") return
        const control = (await request.json()) as Cooking.Control
        controls.push(control)
        if (control.action === "pause") current = { ...current, status: "paused" }
        if (control.action === "resume") current = { ...current, status: "running" }
        if (control.action === "stop") current = { ...current, status: "stopped" }
        if (control.action === "confirm")
          current = {
            ...current,
            status: "completed",
            index: 2,
            completions: [...current.completions, { step: 1, reason: "confirmed", time: 10 }],
          }
        return json(current)
      },
    })
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes("全程烹饪指导"))
    setup.mockInput.pressEscape()
    await setup.waitForFrame((frame) => !frame.includes("全程烹饪指导") && frame.includes("返回烹饪引导"))
    expect(controls).toEqual([{ action: "pause", session_id: session.id, run_id: current.id, index: 1 }])
    const button = setup.renderer.root.findDescendantById("sidebar-cooking-guide")
    if (!button) throw new Error("Missing cooking sidebar button")
    expect(button.x).toBeGreaterThanOrEqual(160 - 42)
    await setup.mockMouse.click(button.x + 3, button.y + 1)
    await setup.waitForFrame((frame) => frame.includes("全程烹饪指导") && frame.includes("已暂停"))
    expect(current.index).toBe(1)
    expect(current.elapsed_ms).toBe(4500)
    expect(controls).toHaveLength(1)
    setup.mockInput.pressEscape()
    await setup.waitForFrame((frame) => !frame.includes("全程烹饪指导"))
    await setup.waitFor(() => setup.renderer.currentFocusedRenderable instanceof TextareaRenderable)
    await setup.mockInput.typeText("/cooking")
    await setup.waitForFrame((frame) => frame.includes("/cooking"))
    setup.mockInput.pressEnter()
    await setup.waitForFrame((frame) => frame.includes("全程烹饪指导") && frame.includes("已暂停"))
    expect(controls).toHaveLength(1)
    expect(prompts).toBe(0)
    expect(current.id).toBe("cooking_recovery")
    expect(current.plan.revision).toBe(2)
    setup.mockInput.pressKey("p")
    await setup.waitForFrame((frame) => frame.includes("进行中"))
    if (outcome === "completed") setup.mockInput.pressEnter()
    else setup.mockInput.pressKey("q")
    const ending = outcome === "completed" ? "本次烹饪引导已完毕。" : "本次烹饪引导已中途结束。"
    await setup.waitForFrame((frame) => frame.includes(ending))
    expect(setup.captureCharFrame()).not.toContain("动作谱")
    expect(setup.captureCharFrame()).toContain("摄像头在线")
    expect(setup.captureCharFrame()).toContain("温度离线")
    expect(setup.captureCharFrame()).toContain("声音连接中")
    expect(setup.captureCharFrame()).toContain("空气停用")
    const colors = ["camera", "temperature", "sound", "air"].map((id) => {
      const light = setup.renderer.root.findDescendantById(`cooking-device-${id}-light`)
      if (!(light instanceof TextRenderable)) throw new Error(`Missing ${id} light`)
      return light.fg.toInts().join(",")
    })
    expect(new Set(colors).size).toBe(4)
    expect(setup.renderer.root.findDescendantById("sidebar-cooking-guide")).toBeUndefined()
    expect(reports).toHaveLength(0)
    setup.mockInput.pressEscape()
    await reported.promise
    await setup.waitForFrame((frame) => !frame.includes("全程烹饪指导") && !frame.includes("返回烹饪引导"))
    expect(reports).toEqual([{ session_id: session.id, run_id: current.id }])
    await polled.promise
    expect(reports).toHaveLength(1)
    const response =
      outcome === "completed"
        ? "西红柿炒鸡蛋的烹饪引导已完成，做出来的味道怎么样？"
        : "西红柿炒鸡蛋的烹饪引导已中途结束，有需要的话可以聊聊刚才遇到的问题。"
    setup.events.emit({
      id: "evt_cooking_reply_started",
      created: 20,
      type: "session.step.started",
      durable: { aggregateID: session.id, seq: 1, version: 1 },
      data: {
        sessionID: session.id,
        assistantMessageID: "msg_cooking_reply",
        agent: "cook",
        model: { providerID: "fixture", id: "fixture" },
        started: 20,
      },
    })
    setup.events.emit({
      id: "evt_cooking_reply_text_started",
      created: 21,
      type: "session.text.started",
      durable: { aggregateID: session.id, seq: 2, version: 1 },
      data: { sessionID: session.id, assistantMessageID: "msg_cooking_reply", ordinal: 0 },
    })
    setup.events.emit({
      id: "evt_cooking_reply_text",
      created: 21,
      type: "session.text.ended",
      durable: { aggregateID: session.id, seq: 3, version: 1 },
      data: { sessionID: session.id, assistantMessageID: "msg_cooking_reply", ordinal: 0, text: response },
    })
    setup.events.emit({
      id: "evt_cooking_reply_ended",
      created: 22,
      type: "session.step.ended",
      durable: { aggregateID: session.id, seq: 4, version: 1 },
      data: {
        sessionID: session.id,
        assistantMessageID: "msg_cooking_reply",
        finish: "stop",
        cost: 0,
        tokens: session.tokens,
      },
    })
    await waitForHighlightedFrame(setup, (frame) => frame.includes(response))
    setup.resize(44, 32)
    await setup.waitForFrame((frame) => !frame.includes("[打开 · /cooking]"))
    expect(setup.captureCharFrame()).not.toContain("返回烹饪引导")
  },
)
