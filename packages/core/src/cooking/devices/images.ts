export * as SensorImages from "./images.js"

import { PhotonModule } from "../../image/photon-module.js"
import { Effect } from "effect"
import type { KitchenCamera } from "./camera.js"

export const load = Effect.tryPromise({
  try: async () => {
    const { OpenCVRuntime } = await import("./opencv.js")
    return await OpenCVRuntime.ready
  },
  catch: (cause) => new Error("无法加载 OpenCV 图像处理模块", { cause }),
})

export type OpenCV = Effect.Success<typeof load>

export function correlation(cv: OpenCV, current: KitchenCamera.Frame, previous: KitchenCamera.Frame) {
  const x1 = 420,
    y1 = 70,
    x2 = Math.min(1500, current.width),
    y2 = Math.min(1010, current.height)
  const px2 = Math.min(1500, previous.width),
    py2 = Math.min(1010, previous.height)
  if (x2 <= x1 || y2 <= y1 || x2 - x1 !== px2 - x1 || y2 - y1 !== py2 - y1) return
  const a = new cv.Mat(current.height, current.width, cv.CV_8UC3)
  const b = new cv.Mat(previous.height, previous.width, cv.CV_8UC3)
  a.data.set(current.data)
  b.data.set(previous.data)
  const rect = new cv.Rect(x1, y1, x2 - x1, y2 - y1)
  const ar = a.roi(rect),
    br = b.roi(rect),
    ag = new cv.Mat(),
    bg = new cv.Mat(),
    result = new cv.Mat()
  try {
    cv.cvtColor(ar, ag, cv.COLOR_BGR2GRAY)
    cv.cvtColor(br, bg, cv.COLOR_BGR2GRAY)
    cv.GaussianBlur(ag, ag, new cv.Size(5, 5), 0)
    cv.GaussianBlur(bg, bg, new cv.Size(5, 5), 0)
    cv.matchTemplate(ag, bg, result, cv.TM_CCOEFF_NORMED)
    return result.data32F[0]
  } finally {
    result.delete()
    bg.delete()
    ag.delete()
    br.delete()
    ar.delete()
    b.delete()
    a.delete()
  }
}

export const encode = Effect.fn(function* (frame: KitchenCamera.Frame, format: "png" | "jpeg") {
  const module = yield* PhotonModule.load
  const rgba = new Uint8Array(frame.width * frame.height * 4)
  for (let index = 0; index < frame.width * frame.height; index++) {
    rgba[index * 4] = frame.data[index * 3 + 2]
    rgba[index * 4 + 1] = frame.data[index * 3 + 1]
    rgba[index * 4 + 2] = frame.data[index * 3]
    rgba[index * 4 + 3] = 255
  }
  return yield* Effect.try({
    try: () => {
      const image = new module.PhotonImage(rgba, frame.width, frame.height)
      try {
        return format === "jpeg" ? image.get_bytes_jpeg(95) : image.get_bytes()
      } finally {
        image.free()
      }
    },
    catch: () => new Error("调试图片编码失败"),
  })
})

export function heatmap(cv: OpenCV, matrix: Float32Array): KitchenCamera.Frame {
  const min = Math.min(...matrix),
    max = Math.max(...matrix)
  const gray = new cv.Mat(24, 32, cv.CV_8UC1),
    colored = new cv.Mat()
  try {
    gray.data.set(matrix.map((value) => (max - min < 1e-6 ? 0 : Math.trunc(((value - min) / (max - min)) * 255))))
    cv.applyColorMap(gray, colored, cv.COLORMAP_VIRIDIS)
    return { width: 32, height: 24, data: colored.data.slice() }
  } finally {
    colored.delete()
    gray.delete()
  }
}
