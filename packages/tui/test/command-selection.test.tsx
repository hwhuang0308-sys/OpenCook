import { expect, test } from "bun:test"
import { directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"
import { createAppFixture } from "./fixture/app"

test("custom commands use Cook and the configured model while removed selectors stay inactive", async () => {
  await using state = await tmpdir()
  const agent = Promise.withResolvers<Response>()
  const model = Promise.withResolvers<Response>()
  const mutations: { type: string; body: unknown }[] = []
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  const session = {
    id: `ses_${crypto.randomUUID()}`,
    projectID: "project",
    title: "Command selection fixture",
    agent: "cook",
    model: { providerID: "demo", id: "first" },
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  await using setup = await createAppFixture({
    state: state.path,
    config: {
      animations: false,
      keybinds: { "agent.cycle": "f6", "variant.cycle": "f7", "model.list": "f8" },
    },
    args: { sessionID: session.id },
    fetch: async (url, request) => {
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/agent")
        return json({
          location,
          data: ["cook"].map((id) => ({ id, mode: "primary", hidden: false, permissions: [] })),
        })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "demo", name: "Demo" }] })
      if (url.pathname === "/api/model")
        return json({
          location,
          data: ["first", "second"].map((id) => ({
            id,
            providerID: "demo",
            name: `${id} model`,
            variants: [{ id: "low" }, { id: "high" }],
            cost: [],
            time: { released: 0 },
          })),
        })
      if (url.pathname === "/api/command")
        return json({ location, data: [{ name: "menu", description: "Plan a dinner menu" }] })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
      const type = url.pathname.match(/^\/api\/session\/[^/]+\/(agent|model|command)$/)?.[1]
      if (!type) return
      mutations.push({ type, body: await request.json() })
      return type === "agent" ? agent.promise : type === "model" ? model.promise : new Response(null, { status: 204 })
    },
  })
  try {
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes("Cook · first model"))
    setup.mockInput.pressKey("F6")
    setup.mockInput.pressKey("F7")
    setup.mockInput.pressKey("F8")
    await setup.flush()
    expect(setup.captureCharFrame()).toContain("Cook · first model")
    expect(setup.captureCharFrame()).not.toContain("Select model")
    expect(setup.captureCharFrame()).not.toContain("Select variant")
    await setup.mockInput.typeText("/menu selected input")
    setup.mockInput.pressEscape()
    setup.mockInput.pressEnter()
    await setup.waitFor(() => mutations.length > 0)
    expect(mutations).toEqual([{ type: "model", body: { model: { providerID: "demo", id: "first" } } }])
    model.resolve(new Response(null, { status: 204 }))
    await setup.waitFor(() => mutations.length === 2)
    expect(mutations[1]).toEqual({
      type: "command",
      body: { name: "menu", text: "selected input", files: [], agents: [], delivery: "steer" },
    })
  } finally {
    agent.resolve(new Response(null, { status: 204 }))
    model.resolve(new Response(null, { status: 204 }))
  }
})
