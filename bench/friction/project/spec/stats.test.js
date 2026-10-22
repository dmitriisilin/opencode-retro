import { test } from "node:test"
import assert from "node:assert/strict"
import { mean, sum } from "../src/stats.js"

test("sum adds", () => assert.equal(sum([1, 2, 3]), 6))
test("mean averages", () => assert.equal(mean([1, 2, 3]), 2))
