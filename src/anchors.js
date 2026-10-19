/**
 * Anchors: cheap deterministic markers that say *where to look* (AGENTS.md decision 4).
 *
 * They decide nothing. They hand the extractor a step range and the reason it was
 * flagged, so the model is not asked to find the needle and judge it in one pass.
 * Every anchor carries `from`/`to` as shadow-log `n` values — the evidence coordinate.
 */

export function detectAnchors(records) {
  return [...detectRepeat(records), ...detectRevert(records), ...detectSkillFailure(records)].sort(
    (a, b) => a.from - b.from || a.to - b.to,
  )
}

/**
 * repeat — the same call made again with nothing changed in between.
 *
 * "Nothing changed" is the part that matters: retrying a command after an edit is normal
 * work, retrying it after no edit is the agent hoping the world moved.
 */
export function detectRepeat(records) {
  const anchors = []
  const seen = new Map()
  for (const r of records) {
    if (r.k === "tool" && r.files?.length) {
      seen.clear()
      continue
    }
    if (r.k === "step" && r.files?.length) {
      seen.clear()
      continue
    }
    if (r.k !== "tool" || r.tool === "read" || r.tool === "glob") continue

    const key = `${r.tool}:${signature(r.input)}`
    const prior = seen.get(key)
    if (prior) {
      prior.count++
      prior.anchor.to = r.n
      prior.anchor.reason = `${r.tool} called ${prior.count} times with identical input and no file change in between`
    } else {
      const anchor = { kind: "repeat", from: r.n, to: r.n, tool: r.tool, reason: "" }
      seen.set(key, { count: 1, anchor })
      anchors.push(anchor)
    }
  }
  return anchors.filter((a) => a.to > a.from)
}

/**
 * revert — the agent undid its own edits.
 *
 * Two signals, both from M0-verified payloads: an `edit` whose added lines come back as
 * another edit's removed lines, and a git command that discards work after we recorded
 * edits in this session.
 */
export function detectRevert(records) {
  const anchors = []
  const added = new Map() // file -> [{ n, lines }]
  let firstEdit = null

  for (const r of records) {
    if (r.k !== "tool") continue

    for (const f of r.files ?? []) {
      if (firstEdit === null) firstEdit = r.n
      const { plus, minus } = patchLines(f.patch)
      const prior = added.get(f.file) ?? []

      for (const entry of prior) {
        const undone = entry.lines.filter((l) => minus.includes(l))
        if (entry.lines.length && undone.length === entry.lines.length) {
          anchors.push({
            kind: "revert",
            from: entry.n,
            to: r.n,
            file: f.file,
            reason: `every line added to ${f.file} at step ${entry.n} was removed again at step ${r.n}`,
          })
        }
      }
      if (plus.length) prior.push({ n: r.n, lines: plus })
      added.set(f.file, prior)
    }

    if (r.tool === "shell" && firstEdit !== null && isDiscard(r.input?.command)) {
      anchors.push({
        kind: "revert",
        from: firstEdit,
        to: r.n,
        reason: `\`${String(r.input.command).trim()}\` discarded working-tree changes after edits in this session`,
      })
    }
  }
  return anchors
}

/**
 * skill -> failure — a skill told the agent to run something, and it failed.
 *
 * This is the motivating example (AGENTS.md "What we are building"), and the link has to
 * be exact rather than proximate: in one real session the skill was invoked at step 9 and
 * its command failed at step 18, with unrelated exploration in between, so any fixed
 * window is either too narrow or full of false positives.
 *
 * Instead we use what M0 found in the payload: the `skill` result carries the whole
 * SKILL.md. So we take the commands the skill actually prescribes and look for those
 * failing later in the session. A skill that prescribes no commands raises nothing, which
 * is correct — there is nothing to attribute.
 */
export function detectSkillFailure(records) {
  const anchors = []
  const active = [] // { n, name, target, commands }

  for (const r of records) {
    if (r.k !== "tool") continue

    if (r.tool === "skill") {
      active.push({
        n: r.n,
        name: r.skill?.name ?? r.input?.id ?? null,
        target: r.skill?.directory ?? null,
        commands: prescribedCommands(r.output),
      })
      continue
    }

    const failed = r.status === "error" || (typeof r.exit === "number" && r.exit !== 0)
    if (!failed || r.tool !== "shell") continue

    const command = normalise(r.input?.command)
    if (!command) continue

    for (const skill of active) {
      if (!skill.commands.some((c) => command.startsWith(c) || c.startsWith(command))) continue
      anchors.push({
        kind: "skill-failure",
        from: skill.n,
        to: r.n,
        skill: skill.name,
        target: skill.target,
        reason:
          `skill \`${skill.name}\` prescribes \`${String(r.input.command).trim()}\`, ` +
          `which failed at step ${r.n}` +
          (typeof r.exit === "number" ? ` with exit ${r.exit}` : ""),
      })
      break
    }
  }
  return anchors
}

/** Backtick-quoted spans in a skill body that look like something to run. */
export function prescribedCommands(content) {
  if (typeof content !== "string") return []
  const found = new Set()
  for (const [, span] of content.matchAll(/`([^`\n]{4,})`/g)) {
    const command = normalise(span)
    if (command && /\s/.test(command)) found.add(command)
  }
  return [...found]
}

const normalise = (command) => (typeof command === "string" ? command.trim().replace(/\s+/g, " ") : "")

const DISCARD = /\bgit\s+(checkout\s+(--|\.)|restore\b|reset\s+--hard\b|stash\b(?!\s+list)|revert\b|clean\s+-[a-z]*f)/

const isDiscard = (command) => typeof command === "string" && DISCARD.test(command)

/** Added and removed lines of a unified patch, trimmed and without the markers. */
export function patchLines(patch) {
  const plus = []
  const minus = []
  if (typeof patch !== "string") return { plus, minus }
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue
    if (line.startsWith("+")) {
      const body = line.slice(1).trim()
      if (body) plus.push(body)
    } else if (line.startsWith("-")) {
      const body = line.slice(1).trim()
      if (body) minus.push(body)
    }
  }
  return { plus, minus }
}

/** Stable key for "the same call": key order must not make two identical calls differ. */
export function signature(input) {
  if (input === null || typeof input !== "object") return JSON.stringify(input) ?? ""
  if (Array.isArray(input)) return `[${input.map(signature).join(",")}]`
  return `{${Object.keys(input)
    .sort()
    .map((k) => `${k}:${signature(input[k])}`)
    .join(",")}}`
}
