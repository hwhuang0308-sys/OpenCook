import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { OpenCook, Session } from "../src"

test("Promise host uses the embedded router", async () => {
  await using directory = await tmpdir("opencook-promise-sdk-")
  const config = join(directory.path, "config")
  await mkdir(config)
  const opencook = await OpenCook.create({
    events: { persist: true },
    config: { directory: config, project: false, content: "{}" },
  })

  try {
    const location = { directory: directory.path }
    const session = await opencook.sessions.create({ location })
    const selected = await opencook.sessions.get({ sessionID: session.id })
    const page = await opencook.sessions.list({ directory: directory.path })
    const events = Array.fromAsync(opencook.sessions.log({ sessionID: session.id }))

    expect(selected.id).toBe(session.id)
    expect(page.data.some((item) => item.id === session.id)).toBe(true)
    expect((await events).some((event) => event.type === "session.created")).toBe(true)

    const missingSessionID = Session.ID.create()
    const missing = await opencook.sessions.get({ sessionID: missingSessionID }).catch((error: unknown) => error)
    expect(missing).toMatchObject({ _tag: "SessionNotFoundError", sessionID: missingSessionID })
  } finally {
    await opencook.close()
    await opencook.close()
  }
})

test("Promise event streams support cancellation", async () => {
  await using directory = await tmpdir("opencook-promise-stream-")
  const config = join(directory.path, "config")
  await mkdir(config)
  {
    await using opencook = await OpenCook.create({ config: { directory: config, project: false, content: "{}" } })
    const controller = new AbortController()
    const events = opencook.events.subscribe({ signal: controller.signal })[Symbol.asyncIterator]()
    expect(await events.next()).toMatchObject({ value: { type: "server.connected" }, done: false })
    const pending = events.next()
    controller.abort()
    // A caller abort ends only this subscriber; client tests pin closing the shared transport after the last one.
    expect(await pending).toEqual({ done: true, value: undefined })
    await events.return?.()
  }
})

test("closing cancels active Promise event streams", async () => {
  await using directory = await tmpdir("opencook-promise-stream-close-")
  const config = join(directory.path, "config")
  await mkdir(config)
  const opencook = await OpenCook.create({ config: { directory: config, project: false, content: "{}" } })
  const events = opencook.events.subscribe()[Symbol.asyncIterator]()
  expect(await events.next()).toMatchObject({ value: { type: "server.connected" }, done: false })
  const pending = events.next()

  await opencook.close()
  const error = await pending.catch((error: unknown) => error)
  expect(error).toMatchObject({ name: "ClientError", reason: "Transport" })
})
