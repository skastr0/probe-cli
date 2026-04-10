import { describe, expect, test } from "bun:test"
import { assertSessionTransition, canTransitionSessionState } from "./session"

describe("session state transitions", () => {
  test("allows opening to ready", () => {
    expect(canTransitionSessionState("opening", "ready")).toBe(true)
  })

  test("rejects closed back to ready", () => {
    expect(canTransitionSessionState("closed", "ready")).toBe(false)
    expect(() => assertSessionTransition("closed", "ready")).toThrow(
      "Invalid session state transition: closed -> ready",
    )
  })
})
