export * as SensorProtocols from "./protocols.js"

// Ported from cook_audio_new.py, cook_air.py and cook_temperature_new.py.
// Keep protocol quirks here; changing validation would change device behavior.
export function crc16(bytes: Uint8Array) {
  let crc = 0xffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1
  }
  return crc
}

function request(bytes: number[]) {
  const data = Buffer.from(bytes)
  const checksum = crc16(data)
  return Buffer.concat([data, Buffer.from([checksum & 255, checksum >>> 8])])
}

export const soundRequest = () => request([0x01, 0x03, 0, 0, 0, 1])
export function soundValue(frame: Uint8Array) {
  if (frame.length < 7) throw new Error(`响应长度不足: ${frame.length}`)
  // The original deliberately does not check response CRC, address or function.
  return ((frame[3] << 8) | frame[4]) / 10
}

// The expression in the Python source evaluates to 1575, despite its 1583-byte comment.
export const temperatureFrameLength = 7 + 768 * 2 + 16 * 2
export const temperatureRequest = () => request([0x01, 0x65, 0, 0, 0x03, 0x11])
export function temperatureMatrix(frame: Uint8Array) {
  if (frame.length !== temperatureFrameLength) return
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  return Float32Array.from({ length: 768 }, (_, index) => view.getInt16(37 + index * 2, true) / 10)
}

export function airChecksum(frame: Uint8Array) {
  return (256 - (frame.slice(1, 8).reduce((sum, byte) => sum + byte, 0) & 255)) & 255
}
export function airActiveRequest() {
  const frame = Buffer.from([0xff, 0, 0x78, 0x40, 0, 0, 0, 0, 0])
  frame[8] = airChecksum(frame)
  return frame
}
export function airValue(frame: Uint8Array) {
  if (frame.length !== 9 || frame[0] !== 0xff || frame[8] !== airChecksum(frame)) return
  return {
    concentration: ((frame[4] << 8) | frame[5]) / 10 ** frame[3],
    full_scale: ((frame[6] << 8) | frame[7]) / 10 ** frame[3],
    gas_type: frame[1],
    unit: "mg/m³",
    unit_code: frame[2],
    decimal: frame[3],
  }
}
