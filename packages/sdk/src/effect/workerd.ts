export * as OpenCookWorkerd from "./workerd"

import { Layer } from "effect"
import type { Config, Scope } from "effect"
import { WorkerdProfile } from "../internal/workerd"
import { OpenCook } from "./opencook"

export type Configuration = WorkerdProfile.Configuration

export interface CreateOptions<R = never> extends WorkerdProfile.Options {
  readonly log?: OpenCook.CreateOptions["log"]
  readonly plugins?: OpenCook.CreateOptions["plugins"]
  readonly workspaceProviders?: OpenCook.CreateOptions["workspaceProviders"]
  readonly instances?: OpenCook.CreateOptions<R>["instances"]
}

export const create = <R = never>({ log, plugins, workspaceProviders, instances, ...options }: CreateOptions<R>) => {
  const profile = WorkerdProfile.make(options)
  return OpenCook.create(
    { ...profile.options, log, plugins, workspaceProviders, instances },
    { overrides: profile.replacements },
  )
}

export const layer = <R = never>(
  options: CreateOptions<R>,
): Layer.Layer<OpenCook.Service, Config.ConfigError | Error, Exclude<R, Scope.Scope>> =>
  Layer.effect(OpenCook.Service, create(options))

export type Interface = OpenCook.Interface
export type Requirements = Scope.Scope
