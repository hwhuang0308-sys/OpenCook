export interface Asset {
  readonly path: string
  readonly sha256: string
}

export interface Runtime {
  readonly serial: { readonly module: Asset; readonly binding: Asset }
}

// Build scripts replace this module with target-specific embedded assets.
const binding: Runtime | undefined = undefined
export default binding
