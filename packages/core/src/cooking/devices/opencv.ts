export * as OpenCVRuntime from "./opencv.js"

import cv from "@techstark/opencv-js"

// Its CommonJS export is a Promise. Re-export it under a name so bundled dynamic imports
// cannot mistake the namespace's copied `then` method for a bound Promise method.
export const ready = cv
