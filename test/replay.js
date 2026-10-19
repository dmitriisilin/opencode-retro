import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { createIngest } from "../src/ingest.js"

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Drives the ingest with a payload capture from fixtures/payloads/, so the record format,
 * the projection and the detectors can be worked on without running OpenCode at all.
 */
export function replay(fixture, { maxOutput = 8000 } = {}) {
  const lines = readFileSync(join(here, "..", "fixtures", "payloads", fixture), "utf8").trim().split("\n")
  const emitted = []
  let clock = 1_700_000_000_000

  const ingest = createIngest({
    maxOutput,
    now: () => (clock += 10),
    emit: (sessionID, record) => emitted.push({ sessionID, ...record }),
  })

  for (const line of lines) {
    const entry = JSON.parse(line)
    switch (entry.kind) {
      case "session.prompt":
        ingest.prompt(entry.payload)
        break
      case "tool.execute.before":
        ingest.toolBefore(entry.payload)
        break
      case "tool.execute.after":
        ingest.toolAfter(entry.payload)
        break
      case "event":
        ingest.event(entry.payload)
        break
    }
  }
  return { records: emitted, ingest }
}
