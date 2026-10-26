export * as SensorBuffer from "./buffer.js"

export interface Sample<T> {
  readonly time: number
  readonly value: T
}

export class Window<T> {
  private samples: Sample<T>[] = []
  constructor(
    private capacity: number,
    private seconds?: number,
  ) {}
  resize(capacity: number, seconds?: number) {
    this.capacity = capacity
    this.seconds = seconds
    if (this.samples.length > capacity) this.samples.splice(0, this.samples.length - capacity)
  }
  append(time: number, value: T) {
    this.samples.push({ time, value })
    if (this.samples.length > this.capacity) this.samples.splice(0, this.samples.length - this.capacity)
    if (this.seconds !== undefined) {
      const seconds = this.seconds
      const first = this.samples.findIndex((sample) => sample.time >= time - seconds * 1000)
      if (first > 0) this.samples.splice(0, first)
    }
  }
  latest() {
    return this.samples.at(-1)
  }
  atOrBefore(time: number) {
    let result: Sample<T> | undefined
    for (const sample of this.samples) {
      if (sample.time > time) break
      result = sample
    }
    return result
  }
  between(start: number, end: number) {
    return this.samples.filter((sample) => sample.time >= start && sample.time <= end).map((sample) => sample.value)
  }
  get length() {
    return this.samples.length
  }
}
