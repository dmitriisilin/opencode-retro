import { clamp } from "./config.js"

/**
 * Shadow log -> the text the extractor reads (AGENTS.md decision 5).
 *
 * Prompts and assistant text in full, because that is where intent and regret live.
 * Tool output trimmed hard, because that is where the volume lives. Deterministic: the
 * same log must always project to the same text, or the extractor prompt cannot be
 * iterated on fixtures.
 */
export function project(records, { maxToolOutput = 600, maxPromptChars = 4000 } = {}) {
  const lines = []
  for (const r of records) {
    switch (r.k) {
      case "session":
        lines.push(r.event === "start" ? `--- session ${r.event}` : `--- session ${r.event}: ${r.outcome}`)
        break

      case "prompt": {
        const { text } = clamp(r.text ?? "", maxPromptChars)
        lines.push(`[${r.n}] user:`, indent(text))
        break
      }

      case "text": {
        const { text } = clamp(r.text ?? "", maxPromptChars)
        lines.push(`[${r.n}] assistant:`, indent(text))
        break
      }

      case "tool":
        lines.push(`[${r.n}] ${describeCall(r)}`)
        for (const detail of describeResult(r, maxToolOutput)) lines.push(indent(detail))
        break

      case "step":
        if (r.files?.length) lines.push(`[${r.n}] step ${r.finish ?? ""} — changed: ${r.files.join(", ")}`.trimEnd())
        break
    }
  }
  return lines.join("\n") + "\n"
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
