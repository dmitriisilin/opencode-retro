// Which planted traps became lessons, which lessons match nothing planted, and whether a
// true statement was turned into a false finding.
//
//   node score.mjs traps.json <project>/.retro [review-session-id]
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"

const [, , trapsPath, retro, review] = process.argv
const { traps, controls } = JSON.parse(readFileSync(trapsPath, "utf8"))

const lessons = []
for (const where of ["lessons", "archive"]) {
  const dir = join(retro, where)
  if (!existsSync(dir)) continue
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    const text = readFileSync(join(dir, f), "utf8")
    const field = (k) => (text.match(new RegExp(`^${k}: (.*)$`, "m")) ?? [])[1] ?? ""
    lessons.push({ file: `${where}/${f}`, id: field("id"), recurrence: Number(field("recurrence") || 1), text: text.toLowerCase(), raw: text })
  }
}

const hits = (item) => lessons.filter((l) => item.match.some((m) => l.text.includes(m.toLowerCase())))
const lines = [`${lessons.length} lesson(s) recorded`, ""]
let found = 0
for (const t of traps) {
  const h = hits(t)
  if (h.length) found++
  lines.push(`${h.length ? "FOUND " : "MISSED"}  ${t.id}`)
  lines.push(`        planted: ${t.planted}`)
  for (const l of h) lines.push(`        → ${l.id} (recurrence ${l.recurrence})`)
}
lines.push("", `recall: ${found}/${traps.length}`)
// Every task hits the planted traps, so a lesson about one should have been seen in more than
// one session. Recurrence stuck at 1 is the extractor staying silent about a known problem.
const recurring = lessons.filter((l) => l.recurrence > 1)
lines.push(`recurrence: ${recurring.length} lesson(s) seen in more than one session${recurring.length ? " — " + recurring.map((l) => `${l.id} ×${l.recurrence}`).join(", ") : ""}`)
// The review session only checks the lesson it was handed. Evidence from it means the review
// was counted as the problem happening again.
if (review) {
  const inflated = lessons.filter((l) => l.raw.includes(`session: ${review}`))
  const state0 = existsSync(join(retro, "state.json")) ? JSON.parse(readFileSync(join(retro, "state.json"), "utf8")) : {}
  const read = state0.extracted?.[review]
  const vacuous = !read || /one exchange/.test(read.detail ?? "")
  lines.push(
    inflated.length
      ? `BROKEN  the review was counted as a recurrence of: ${inflated.map((l) => l.id).join(", ")}`
      : vacuous
        ? "UNTESTED the review session's work was never analysed, so the check above proves nothing"
        : "ok      the review session was analysed and added to no lesson's recurrence",
  )
}
const state = existsSync(join(retro, "state.json")) ? JSON.parse(readFileSync(join(retro, "state.json"), "utf8")) : {}
lines.push("", "analysis per session:")
for (const [id, x] of Object.entries(state.extracted ?? {})) lines.push(`        ${x.ok ? "ok    " : "FAILED"} ${id}: ${x.detail}`)
for (const [id, m] of Object.entries(state.looked ?? {})) {
  if (m.failed) lines.push(`        FAILED ${id}: last read failed (${m.attempts ?? 1} attempt(s)); the next /retro asks again`)
}
// An order still open is the agent in the review session not having analysed it, which is a
// different failure from the extractor finding nothing — and the one that invalidates a run.
const open = Object.entries(state.orders ?? {}).filter(([, o]) => o && !o.done)
if (open.length) {
  lines.push("", `BROKEN  ${open.length} work order(s) never answered: ${open.map(([s]) => s).join(", ")}`)
  lines.push("        the recall above is not a measurement of the extractor; the analyses did not run.")
}
lines.push("")
for (const c of controls) {
  const h = hits(c)
  lines.push(`${h.length ? "CHECK " : "clean "}  control ${c.id}${h.length ? " — a lesson mentions it; read it: " + h.map((l) => l.id).join(", ") : ""}`)
}
const planted = new Set(traps.flatMap((t) => hits(t).map((l) => l.file)))
const other = lessons.filter((l) => !planted.has(l.file))
lines.push("", `${other.length} lesson(s) about nothing planted — real friction elsewhere, or noise:`)
for (const l of other) lines.push(`        ${l.id}`)
// A recurring lesson is re-saved; a quoted field that grows backslashes on every save is the
// frontmatter round trip breaking (fixed in cycle 6).
const escaped = lessons.filter((l) => /\\\\"/.test(l.raw))
lines.push("", escaped.length ? `BROKEN  escaping grew in: ${escaped.map((l) => l.id).join(", ")}` : "ok      no lesson's quoting grew on re-save")
console.log(lines.join("\n"))
