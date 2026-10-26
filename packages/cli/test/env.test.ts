import { expect, test } from "bun:test"
import { Env } from "../src/env"

test("session environment omits server credentials", () => {
  const previousPassword = process.env.OPENCOOK_PASSWORD
  const previousLegacyPassword = process.env.OPENCOOK_SERVER_PASSWORD
  const previousValue = process.env.OPENCOOK_SESSION_ENV_TEST
  process.env.OPENCOOK_PASSWORD = "password"
  process.env.OPENCOOK_SERVER_PASSWORD = "legacy"
  process.env.OPENCOOK_SESSION_ENV_TEST = "included"

  const environment = Env.session()

  if (previousPassword === undefined) delete process.env.OPENCOOK_PASSWORD
  else process.env.OPENCOOK_PASSWORD = previousPassword
  if (previousLegacyPassword === undefined) delete process.env.OPENCOOK_SERVER_PASSWORD
  else process.env.OPENCOOK_SERVER_PASSWORD = previousLegacyPassword
  if (previousValue === undefined) delete process.env.OPENCOOK_SESSION_ENV_TEST
  else process.env.OPENCOOK_SESSION_ENV_TEST = previousValue

  expect(environment.OPENCOOK_PASSWORD).toBeUndefined()
  expect(environment.OPENCOOK_SERVER_PASSWORD).toBeUndefined()
  expect(environment.OPENCOOK_SESSION_ENV_TEST).toBe("included")
})
