import { clamp } from "./config.js"

/**
 * Shadow log -> the text the extractor reads (AGENTS.md decision 5).
 *
 * Prompts and assistant text in full, because that is where intent and regret live.
 * Tool output trimmed hard, because that is where the volume lives. Deterministic: the
 * same log must always project to the same text, or the extractor prompt cannot be
 * iterated on fixtures.
 */
export function project(records, { maxToolOutput = 600, maxPromptChars = 4000, budget = Infinity } = {}) {
  // Rendered once at full fidelity. If that is over budget, the same records are rendered
  // again with less of the tool output, and only then are steps dropped — in that order,
  // because it loses the least at each stage.
  const full = render(records, { maxToolOutput, maxPromptChars })
  if (size(full) <= budget) return join(full)

  const tight = render(records, { maxToolOutput: Math.min(maxToolOutput, 200), maxPromptChars })
  if (size(tight) <= budget) return join(tight)

  const elided = elide(tight, budget)
  // Dropping a very small block can cost more than it saves: a one-line call is shorter
  // than the marker that replaces it. Never return a "shorter" projection that is longer
  // than the one it was made from.
  const elidedText = join(elided)
  return elidedText.length <= join(tight).length ? elidedText : join(tight)
}

/**
 * Drop whole steps from the middle until it fits.
 *
 * Prompts, assistant text and the session markers are never dropped: that is where intent
 * and regret live, and a projection without them is a list of commands with no account of
 * why. Tool calls and steps go from the middle outward, because a session states its goal at
 * the start and discovers its trouble by the end. Each gap says how many steps went, so the
 * model is reading an excerpt and knows it.
 */
function elide(blocks, budget) {
  const keep = blocks.map(() => true)
  const droppable = blocks.map((b, i) => (b.droppable ? i : -1)).filter((i) => i >= 0)

  // Middle first: order the droppable indices by distance from the centre, descending.
  const centre = droppable.length ? (droppable[0] + droppable[droppable.length - 1]) / 2 : 0
  const order = [...droppable].sort(
    (a, b) => Math.abs(a - centre) - Math.abs(b - centre) || a - b,
  )

  const markerText = (n) => `[...] ${n} step${n === 1 ? "" : "s"} elided to fit the budget`
  const markerSize = (n) => markerText(n).length + 1
  const blockSize = blocks.map((b) => b.lines.reduce((m, l) => m + l.length + 1, 0))

  /**
   * The cost of the projection as it will actually be rendered, markers included.
   *
   * This used to be `size(kept) + 60`, which assumes one gap no matter how many the drops
   * create. A session with assistant text between tool calls produces a gap per turn, so
   * the estimate stopped dropping long before the text fitted: a fifty-turn log over an
   * 8,000-character budget came out at 9,130. Each dropped run carries its own marker, and
   * two runs merge when the block between them goes, so this tracks runs rather than
   * guessing.
   */
  let total = size(blocks)
  const runAtStart = new Map()
  const runAtEnd = new Map()
  const addRun = (run) => {
    runAtStart.set(run.start, run)
    runAtEnd.set(run.end, run)
  }
  const removeRun = (run) => {
    runAtStart.delete(run.start)
    runAtEnd.delete(run.end)
  }

  for (const i of order) {
    if (total <= budget) break
    const left = runAtEnd.get(i - 1)
    const right = runAtStart.get(i + 1)
    let delta = -blockSize[i]

    if (left && right) {
      // The block was the only thing between two gaps; they become one marker.
      removeRun(left)
      removeRun(right)
      const merged = { start: left.start, end: right.end, count: left.count + 1 + right.count }
      addRun(merged)
      delta += markerSize(merged.count) - markerSize(left.count) - markerSize(right.count)
    } else if (left) {
      removeRun(left)
      const grown = { ...left, end: i, count: left.count + 1 }
      addRun(grown)
      delta += markerSize(grown.count) - markerSize(left.count)
    } else if (right) {
      removeRun(right)
      const grown = { ...right, start: i, count: right.count + 1 }
      addRun(grown)
      delta += markerSize(grown.count) - markerSize(right.count)
    } else {
      const run = { start: i, end: i, count: 1 }
      addRun(run)
      delta += markerSize(1)
    }

    keep[i] = false
    total += delta
  }

  const out = []
  let dropped = 0
  for (let i = 0; i < blocks.length; i++) {
    if (keep[i]) {
      if (dropped) {
        out.push({ lines: [markerText(dropped)] })
        dropped = 0
      }
      out.push(blocks[i])
    } else dropped++
  }
  if (dropped) out.push({ lines: [markerText(dropped)] })
  return out
}

const size = (blocks) => blocks.reduce((n, b) => n + b.lines.reduce((m, l) => m + l.length + 1, 0), 0) + 1
const join = (blocks) => blocks.flatMap((b) => b.lines).join("\n") + "\n"

function render(records, { maxToolOutput, maxPromptChars }) {
  const blocks = []
  const push = (lines, droppable = false) => blocks.push({ lines, droppable })
  // Which agent did a step only matters where it is not the usual one, and the usual one is
  // whichever did most of the work. Without this, a subagent's steps are written into the
  // parent's log and then read as if the main agent had done them — the attribution is
  // captured and invisible, which is the worst of both.
  const primary = dominantAgent(records)
  for (const r of records) {
    switch (r.k) {
      case "session":
        push([r.event === "start" ? `--- session ${r.event}` : `--- session ${r.event}: ${r.outcome}`])
        break

      case "prompt": {
        const { text } = clamp(r.text ?? "", maxPromptChars)
        push([`[${r.n}] user:`, indent(text)])
        break
      }

      case "text": {
        const { text } = clamp(r.text ?? "", maxPromptChars)
        push([`[${r.n}] assistant:`, indent(text)])
        break
      }

      case "tool": {
        const lines = [`[${r.n}] ${r.agent && r.agent !== primary ? `(${r.agent}) ` : ""}${describeCall(r)}`]
        for (const detail of describeResult(r, maxToolOutput)) lines.push(indent(detail))
        push(lines, true)
        break
      }

      case "step":
        if (r.files?.length) {
          push([`[${r.n}] step ${r.finish ?? ""} — changed: ${r.files.join(", ")}`.trimEnd()], true)
        }
        break
    }
  }
  return blocks
}

/** The agent that did most of the tool calls. Deterministic, from the log alone. */
function dominantAgent(records) {
  const counts = new Map()
  for (const r of records) {
    if (r.k !== "tool" || !r.agent) continue
    counts.set(r.agent, (counts.get(r.agent) ?? 0) + 1)
  }
  let best = null
  for (const [agent, n] of counts) {
    if (!best || n > best[1] || (n === best[1] && agent < best[0])) best = [agent, n]
  }
  return best?.[0] ?? null
}

function describeCall(r) {
  const input = r.input ?? {}
  switch (r.tool) {
    case "shell":
      return `shell: ${input.command ?? ""}`
    case "skill":
      return `skill: ${input.id ?? r.skill?.name ?? ""}`
    case "read":
      return `read: ${input.path ?? ""}`
    case "edit":
      return `edit: ${input.path ?? ""}`
    case "glob":
      return `glob: ${input.pattern ?? ""}`
    // The delegation's own instruction. It used to fall to the default case and be cut at
    // 200 characters, which removed the one thing that explains what the subagent was for.
    case "subagent":
      return `delegated to ${input.agent ?? "a subagent"}: ${input.description ?? ""}`
    default:
      return `${r.tool}: ${compact(input)}`
  }
}

function describeResult(r, maxToolOutput) {
  const out = []
  if (r.status === "error") {
    out.push(`-> error: ${compact(r.error)}`)
    return out
  }
  if (r.status === "unfinished") {
    out.push("-> never finished (session ended first)")
    return out
  }
  if (r.tool === "subagent" && r.input?.prompt) {
    out.push("asked:", indent(clamp(String(r.input.prompt).trim(), 800).text))
  }
  if (typeof r.exit === "number" && r.exit !== 0) out.push(`-> exit ${r.exit}`)
  for (const f of r.files ?? []) out.push(`-> ${f.status} ${f.file} (+${f.additions ?? 0}/-${f.deletions ?? 0})`)
  if (r.skill) out.push(`-> skill from ${r.skill.directory ?? "?"}`)
  if (r.output) {
    const { text } = clamp(r.output.trim(), maxToolOutput)
    if (text) out.push(text)
  }
  return out
}

const indent = (text) =>
  String(text)
    .split("\n")
    .map((l) => "    " + l)
    .join("\n")

function compact(value) {
  try {
    const s = JSON.stringify(value)
    return s && s.length > 200 ? s.slice(0, 200) + "…" : s ?? ""
  } catch {
    return ""
  }
}
