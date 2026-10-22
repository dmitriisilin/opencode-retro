import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeAtomic } from "../src/atomic.js"

test("a write replaces the whole file and leaves nothing beside it", () => {
  const dir = mkdtempSync(join(tmpdir(), "retro-atomic-"))
  writeFileSync(join(dir, "state.json"), "{ \"old\": true }\n")
  writeAtomic(join(dir, "state.json"), "{ \"new\": true }\n")
  assert.equal(readFileSync(join(dir, "state.json"), "utf8"), "{ \"new\": true }\n")
  assert.deepEqual(readdirSync(dir), ["state.json"])
})

test("a write that fails leaves the old file whole and no temporary behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "retro-atomic-"))
  writeFileSync(join(dir, "state.json"), "{ \"old\": true }\n")
  // Renaming a file over a directory fails after the temporary file is written.
  assert.throws(() => writeAtomic(join(dir), "x"))
  assert.equal(readFileSync(join(dir, "state.json"), "utf8"), "{ \"old\": true }\n")
  assert.deepEqual(readdirSync(dir), ["state.json"])
})
