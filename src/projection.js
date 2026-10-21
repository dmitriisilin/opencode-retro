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

  return join(elide(tight, budget))
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
  const centre = (droppable[0] + droppable[droppable.length - 1]) / 2
  const order = [...droppable].sort(
    (a, b) => Math.abs(a - centre) - Math.abs(b - centre) || a - b,
  )

  let total = size(blocks)
  for (const i of order) {
    if (total <= budget) break
    keep[i] = false
    total = size(blocks.filter((_, j) => keep[j])) + 60 // one marker's worth, roughly
  }

  const out = []
  let dropped = 0
  for (let i = 0; i < blocks.length; i++) {
    if (keep[i]) {
      if (dropped) {
        out.push({ lines: [`[...] ${dropped} step${dropped === 1 ? "" : "s"} elided to fit the budget`] })
        dropped = 0
      }
      out.push(blocks[i])
    } else dropped++
  }
  if (dropped) out.push({ lines: [`[...] ${dropped} step${dropped === 1 ? "" : "s"} elided to fit the budget`] })
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
