import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  BOUNDED_COLLECTION_CONTRACT_VERSION,
  BoundedCollectionDrillHandle,
  BoundedCollectionSchema,
  boundedCollectionAllShown,
  defaultCollectionDrillPageSize,
  resolveCollectionDrillPage,
  sliceBoundedCollection,
} from "./bounded"
import { DrillQuery } from "./output"

describe("sliceBoundedCollection", () => {
  test("shows everything and reports zero omitted when under the limit", () => {
    const { shown, omitted } = sliceBoundedCollection([1, 2, 3], 10)
    expect(shown).toEqual([1, 2, 3])
    expect(omitted).toBe(0)
  })

  test("caps shown at the limit and reports the remainder as omitted", () => {
    const items = Array.from({ length: 10_000 }, (_, index) => index)
    const { shown, omitted } = sliceBoundedCollection(items, 5)
    expect(shown).toEqual([0, 1, 2, 3, 4])
    expect(omitted).toBe(9_995)
  })

  test("never throws on a negative or fractional limit -- clamps to a safe non-negative integer", () => {
    expect(sliceBoundedCollection([1, 2, 3], -5)).toEqual({ shown: [], omitted: 3 })
    expect(sliceBoundedCollection([1, 2, 3], 1.9)).toEqual({ shown: [1], omitted: 2 })
  })

  test("shown.length + omitted always reconstructs total", () => {
    const items = Array.from({ length: 137 }, (_, index) => index)

    for (const limit of [0, 1, 50, 136, 137, 200]) {
      const { shown, omitted } = sliceBoundedCollection(items, limit)
      expect(shown.length + omitted).toBe(items.length)
    }
  })
})

describe("boundedCollectionAllShown", () => {
  test("wraps a collection as fully shown with no drill handle", () => {
    const result = boundedCollectionAllShown(["a", "b"])
    expect(result).toEqual({ total: 2, shown: ["a", "b"], omitted: 0, drill: null })
  })

  test("an empty collection is fully shown too -- omitted stays semantically zero, never a phantom handle", () => {
    expect(boundedCollectionAllShown([])).toEqual({ total: 0, shown: [], omitted: 0, drill: null })
  })
})

describe("resolveCollectionDrillPage", () => {
  const items = Array.from({ length: 25 }, (_, index) => `item-${index}`)

  test("slices the requested offset/limit window and reports the true total", () => {
    const page = resolveCollectionDrillPage(items, { kind: "collection", offset: 10, limit: 5 })
    expect(page).toEqual({ total: 25, offset: 10, items: ["item-10", "item-11", "item-12", "item-13", "item-14"] })
  })

  test("is deterministic across repeated reads -- the same query always resolves the same page", () => {
    const query = { kind: "collection" as const, offset: 5, limit: 8 }
    const first = resolveCollectionDrillPage(items, query)
    const second = resolveCollectionDrillPage(items, query)
    expect(first).toEqual(second)
  })

  test("an offset past the end returns an empty page, not an error", () => {
    const page = resolveCollectionDrillPage(items, { kind: "collection", offset: 1_000, limit: 10 })
    expect(page).toEqual({ total: 25, offset: 1_000, items: [] })
  })

  test("clamps a negative offset/limit to zero rather than throwing", () => {
    const page = resolveCollectionDrillPage(items, { kind: "collection", offset: -3, limit: -1 })
    expect(page).toEqual({ total: 25, offset: 0, items: [] })
  })
})

describe("BoundedCollectionSchema + BoundedCollectionDrillHandle", () => {
  const StringCollection = BoundedCollectionSchema(Schema.String)
  const decode = Schema.decodeUnknownSync(StringCollection)
  const encode = Schema.encodeSync(StringCollection)

  test("round-trips a fully-shown collection (drill: null)", () => {
    const value = { total: 2, shown: ["a", "b"], omitted: 0, drill: null }
    expect(decode(value)).toEqual(value)
    expect(encode(value)).toEqual(value)
  })

  test("round-trips an overflowing collection carrying a typed drill handle", () => {
    const handle = {
      contractVersion: BOUNDED_COLLECTION_CONTRACT_VERSION,
      sessionId: "session-1",
      artifactKey: "flow-executed-steps-overflow",
      query: { kind: "collection" as const, offset: 0, limit: defaultCollectionDrillPageSize },
    }
    const value = { total: 10_000, shown: ["a"], omitted: 9_999, drill: handle }
    expect(decode(value)).toEqual(value)
  })

  test("rejects a handle whose contractVersion does not match the current contract", () => {
    const badHandle = {
      contractVersion: 99,
      sessionId: "session-1",
      artifactKey: "k",
      query: { kind: "collection" as const, offset: 0, limit: 10 },
    }
    expect(() => Schema.decodeUnknownSync(BoundedCollectionDrillHandle)(badHandle)).toThrow()
  })

  test("a drill handle's query is a real DrillQuery -- artifact.drill accepts it without reconstruction", () => {
    const handle = {
      contractVersion: BOUNDED_COLLECTION_CONTRACT_VERSION,
      sessionId: "session-1",
      artifactKey: "k",
      query: { kind: "collection" as const, offset: 0, limit: 200 },
    }
    // The handle's `query` field is typed as `DrillQuery` itself (see
    // domain/bounded.ts), so anything accepting a DrillQuery -- e.g. the
    // artifact.drill RPC/CLI surface -- accepts `handle.query` directly.
    const decodedQuery = Schema.decodeUnknownSync(DrillQuery)(handle.query)
    expect(decodedQuery).toEqual(handle.query)
  })
})
