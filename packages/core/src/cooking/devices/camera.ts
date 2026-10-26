export * as KitchenCamera from "./camera.js"

import { Clock, Effect, References, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { AppProcess } from "@opencook/util/process"

export interface Frame {
  readonly width: number
  readonly height: number
  readonly data: Uint8Array
}

export class Decoder {
  private pending = Buffer.alloc(0)
  push(chunk: Uint8Array) {
    this.pending = Buffer.concat([this.pending, chunk])
    const frames: Frame[] = []
    while (this.pending.length) {
      const header = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(
        this.pending.toString("ascii", 0, Math.min(128, this.pending.length)),
      )
      if (!header) {
        if (this.pending.length > 128) throw new Error("摄像头解码输出格式错误")
        break
      }
      const width = Number(header[1]),
        height = Number(header[2]),
        size = width * height * 3
      if (!width || !height || size > 256 * 1024 * 1024) throw new Error("摄像头图像尺寸无效")
      if (this.pending.length < header[0].length + size) break
      const rgb = this.pending.subarray(header[0].length, header[0].length + size)
      const bgr = new Uint8Array(size)
      for (let pixel = 0; pixel < size; pixel += 3) {
        bgr[pixel] = rgb[pixel + 2]
        bgr[pixel + 1] = rgb[pixel + 1]
        bgr[pixel + 2] = rgb[pixel]
      }
      frames.push({ width, height, data: bgr })
      this.pending = this.pending.subarray(header[0].length + size)
    }
    return frames
  }
}

export const capture = Effect.fn(function* (
  url: string,
  executable: string,
  consume: (frame: Frame, time: number) => Effect.Effect<void, Error>,
) {
  const processes = yield* AppProcess.Service
  const handle = yield* processes
    .spawn(
      ChildProcess.make(
        executable || "ffmpeg",
        [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          url,
          // Python grabs eight frames and retrieves only the eighth. Keep the same stride.
          "-vf",
          "select=not(mod(n+1\\,8))",
          "-vsync",
          "0",
          "-f",
          "image2pipe",
          "-vcodec",
          "ppm",
          "pipe:1",
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe", forceKillAfter: "1 second" },
      ),
    )
    .pipe(
      // Process logs include arguments, which can contain RTSP credentials.
      Effect.provideService(References.MinimumLogLevel, "None"),
      Effect.mapError(() => new Error("无法启动摄像头解码器，请安装 FFmpeg 或在设置中填写其路径")),
    )
  yield* Stream.runDrain(handle.stderr).pipe(Effect.ignore, Effect.forkScoped({ startImmediately: true }))
  const decoder = new Decoder()
  let last = yield* Clock.currentTimeMillis
  const read = Stream.runForEach(handle.stdout, (chunk) =>
    Effect.gen(function* () {
      const frames = yield* Effect.try({ try: () => decoder.push(chunk), catch: () => new Error("摄像头解码失败") })
      for (const frame of frames) {
        last = yield* Clock.currentTimeMillis
        yield* consume(frame, last)
      }
    }),
  ).pipe(Effect.mapError(() => new Error("摄像头视频流已中断")))
  const stalled = Effect.forever(
    Effect.gen(function* () {
      yield* Effect.sleep("200 millis")
      if ((yield* Clock.currentTimeMillis) - last > 2000)
        return yield* Effect.fail(new Error("摄像头超过 2 秒没有收到新画面"))
    }),
  )
  yield* Effect.raceFirst(read, stalled)
  return yield* Effect.fail(new Error("摄像头视频流已结束"))
})
