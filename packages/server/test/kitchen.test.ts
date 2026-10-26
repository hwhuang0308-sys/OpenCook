import path from "node:path"
import { expect } from "bun:test"
import { Global } from "@opencook/util/global"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/http"
import { Kitchen } from "@opencook/schema/kitchen"
import { Cooking } from "@opencook/schema/cooking"
import { CookingExecution } from "@opencook/core/cooking/execution"
import { Session } from "@opencook/core/session"
import { SessionExecution } from "@opencook/core/session/execution"
import { Location } from "@opencook/schema/location"
import { AbsolutePath } from "@opencook/schema/schema"
import { Database } from "@opencook/core/database/database"
import { Bus } from "@opencook/core/bus"
import { SessionInbox } from "@opencook/core/session/inbox"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { createRoutes } from "../src/routes"

it.live("kitchen endpoints authenticate requests, redact credentials and reject invalid settings", () =>
  Effect.gen(function* () {
    const temporary = yield* tmpdirScoped("opencook-kitchen-api-")
    yield* Effect.promise(() =>
      Bun.write(
        path.join(temporary.path, "opencook.json"),
        JSON.stringify({
          cooking_models: {
            chat: {
              enabled: true,
              base_url: "https://user.test/v1",
              model: "test-cook",
              context: 10000,
              output: 1000,
              api_key: "private-model-key",
            },
          },
        }),
      ),
    )
    const wakeups: Session.ID[] = []
    const context = yield* Layer.build(
      createRoutes(
        {
          password: "test-secret",
          database: { path: ":memory:" },
          config: { directory: temporary.path, project: false },
          fs: { filewatcher: false },
        },
        () => [],
        [
          SessionExecution.node.replace(
            Layer.effect(
              SessionExecution.Service,
              Effect.gen(function* () {
                const execution = yield* SessionExecution.Service
                return SessionExecution.Service.of({
                  ...execution,
                  wake: (id) =>
                    Effect.sync(() => {
                      wakeups.push(id)
                    }),
                })
              }),
            ).pipe(Layer.provide(SessionExecution.noopLayer)),
          ),
          Global.node.replace(
            Global.layerWith({
              config: temporary.path,
              data: path.join(temporary.path, "data"),
              state: path.join(temporary.path, "state"),
              cache: path.join(temporary.path, "cache"),
            }),
          ),
        ],
      ).pipe(Layer.provide(HttpServer.layerServices)),
    )
    const handler = Context.get(context, HttpRouter.HttpRouter)
      .asHttpEffect()
      .pipe(HttpEffect.toWebHandlerWith(context))
    const request = (route: string, body?: unknown, authorized = true) =>
      Effect.promise((signal) =>
        handler(
          new Request(`http://opencook.local/api/kitchen/${route}`, {
            method: body === undefined ? "GET" : route.startsWith("cooking/") ? "POST" : "PUT",
            signal,
            headers: {
              ...(authorized ? { authorization: `Basic ${btoa("opencook:test-secret")}` } : {}),
              "content-type": "application/json",
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        ),
      )
    expect((yield* request("settings", undefined, false)).status).toBe(401)
    expect((yield* request("cooking?session_id=fixture", undefined, false)).status).toBe(401)
    expect(
      yield* Effect.promise(() =>
        handler(
          new Request("http://opencook.local/api/kitchen/cooking?session_id=fixture", {
            headers: { authorization: `Basic ${btoa("opencook:test-secret")}` },
          }),
        ).then((response) => response.json()),
      ),
    ).toBeNull()
    const first = yield* request("settings")
    expect(first.status).toBe(200)
    const settings = Schema.decodeUnknownSync(Kitchen.Settings)(yield* Effect.promise(() => first.json()))
    expect(settings.recording.enabled).toBe(false)
    const update = yield* request("model", {
      role: "chat",
      profile: { enabled: true, base_url: "https://user.test/v1", model: "test-cook", context: 10000, output: 1000 },
      api_key: "private-model-key",
    })
    expect(update.status).toBe(200)
    const text = yield* Effect.promise(() => update.text())
    expect(text).not.toContain("private-model-key")
    expect(text).toContain('"has_key":true')
    expect(settings.config_file).toBe(path.join(temporary.path, "opencook.json"))
    const document = yield* Effect.promise(() => Bun.file(settings.config_file!).json())
    expect(document.cooking_models.chat).toMatchObject({ model: "test-cook", api_key: "private-model-key" })
    const configView = yield* Effect.promise(() =>
      handler(
        new Request("http://opencook.local/api/config", {
          headers: { authorization: `Basic ${btoa("opencook:test-secret")}` },
        }),
      ).then((response) => response.text()),
    )
    expect(configView).not.toContain("private-model-key")
    expect(configView).toContain("test-cook")
    const invalid = yield* request("model", {
      role: "chat",
      profile: { enabled: true, base_url: "file:///secret", model: "x", context: 10000, output: 1000 },
    })
    expect(invalid.status).toBe(400)
    const devices = yield* request("devices", {
      devices: {
        ...settings.devices,
        camera: { ...settings.devices.camera, rtsp_url: "rtsp://admin:private-camera-key@camera.test/live" },
      },
    })
    expect(devices.status).toBe(200)
    expect(yield* Effect.promise(() => devices.text())).not.toContain("private-camera-key")
    const status = yield* request("status")
    expect(status.status).toBe(200)
    expect(
      Schema.decodeUnknownSync(Schema.Array(Kitchen.DeviceStatus))(yield* Effect.promise(() => status.json())),
    ).toHaveLength(4)
    const execution = Context.get(context, CookingExecution.Service)
    const run = yield* execution.start("fixture", {
      task_id: "recipe-fixture",
      revision: 1,
      dish: "测试",
      recipe_text: "测试配方",
      program: "测试程序谱",
      actions: "测试动作谱",
      steps: ["清洗番茄", "切番茄成块"].map((action) => ({
        action,
        continuous: false,
        seconds: 0,
        logic: "",
        conditions: [],
      })),
    })
    const fetched = yield* request("cooking?session_id=fixture")
    expect(fetched.status).toBe(200)
    expect(Schema.decodeUnknownSync(Cooking.Run)(yield* Effect.promise(() => fetched.json())).index).toBe(0)
    const control = { session_id: "fixture", run_id: run.id, index: 0 }
    expect((yield* request("cooking/control", { ...control, action: "pause" })).status).toBe(200)
    const opened = yield* request("cooking/control", { ...control, action: "open" })
    expect(opened.status).toBe(200)
    const viewing = Schema.decodeUnknownSync(Cooking.Run)(yield* Effect.promise(() => opened.json()))
    expect(viewing.status).toBe("paused")
    expect(viewing.display_request).toBeTruthy()
    expect(viewing.index).toBe(0)
    const resumed = yield* request("cooking/control", { ...control, action: "resume" })
    expect(resumed.status).toBe(200)
    const running = Schema.decodeUnknownSync(Cooking.Run)(yield* Effect.promise(() => resumed.json()))
    expect(running.status).toBe("running")
    expect(running.display_request).not.toBe(viewing.display_request)
    expect(running.id).toBe(run.id)
    const speechRequest = { session_id: "fixture", run_id: run.id, index: 0, kind: "step" }
    expect((yield* request("cooking/speech", speechRequest, false)).status).toBe(401)
    const speech = yield* request("cooking/speech", speechRequest)
    expect(speech.status).toBe(200)
    expect(yield* Effect.promise(() => speech.json())).toEqual({ status: "disabled" })
    const confirmed = yield* request("cooking/control", {
      session_id: "fixture",
      run_id: run.id,
      index: 0,
      action: "confirm",
    })
    expect(confirmed.status).toBe(200)
    expect(Schema.decodeUnknownSync(Cooking.Run)(yield* Effect.promise(() => confirmed.json())).index).toBe(1)
    expect(
      (yield* request("cooking/control", { session_id: "fixture", run_id: run.id, index: 0, action: "confirm" }))
        .status,
    ).toBe(400)
    expect(
      (yield* request("cooking/control", { session_id: "other", run_id: run.id, index: 1, action: "confirm" })).status,
    ).toBe(400)
    const sessions = Context.get(context, Session.Service)
    const session = yield* sessions.create({
      location: Location.Ref.make({ directory: AbsolutePath.make(temporary.path) }),
    })
    const feedback = yield* execution.start(session.id, run.plan)
    const report = { session_id: session.id, run_id: feedback.id }
    expect((yield* request("cooking/report", report, false)).status).toBe(401)
    expect((yield* request("cooking/report", report)).status).toBe(400)
    expect(yield* sessions.inbox(session.id)).toHaveLength(0)
    yield* execution.control({ ...report, index: 0, action: "confirm" })
    yield* execution.control({ ...report, index: 1, action: "confirm" })
    expect((yield* request("cooking/report", { ...report, run_id: "replaced" })).status).toBe(400)
    expect((yield* request("cooking/report", report)).status).toBe(204)
    expect((yield* request("cooking/report", report)).status).toBe(204)
    const inbox = yield* sessions.inbox(session.id)
    expect(inbox).toHaveLength(1)
    expect(inbox[0]).toMatchObject({
      type: "synthetic",
      delivery: "queue",
      payload: {
        description: "本次烹饪引导已完毕。",
        metadata: {
          type: "cooking_guidance_finished",
          run_id: feedback.id,
          status: "completed",
          completed_steps: 2,
          total_steps: 2,
        },
        text: expect.stringContaining('"status":"completed"'),
      },
    })
    expect(wakeups).toContain(session.id)
    const database = Context.get(context, Database.Service)
    const bus = Context.get(context, Bus.Service)
    yield* SessionInbox.promote(database.db, bus, session.id, "input")
    expect((yield* sessions.context(session.id)).at(-1)).toMatchObject({
      type: "synthetic",
      metadata: { type: "cooking_guidance_finished", status: "completed" },
    })
    expect((yield* request("cooking/report", report)).status).toBe(204)
    expect(yield* sessions.inbox(session.id)).toHaveLength(0)
    const stopped = yield* execution.start(session.id, run.plan)
    yield* execution.control({ session_id: session.id, run_id: stopped.id, index: 0, action: "stop" })
    expect((yield* request("cooking/report", { session_id: session.id, run_id: stopped.id })).status).toBe(204)
    expect((yield* sessions.inbox(session.id))[0]).toMatchObject({
      payload: {
        description: "本次烹饪引导已中途结束。",
        metadata: { status: "stopped", completed_steps: 0, total_steps: 2 },
      },
    })
  }),
)
