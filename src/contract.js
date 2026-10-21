/**
 * The output contract (AGENTS.md decision 14).
 *
 * It lives here, in source, and is wrapped around the user's prompt at call time. It is
 * never written to disk, so it cannot be edited away by accident — and the prompt file has
 * no do-not-touch region in it, because a file with one is a file someone will eventually
 * touch, and the breakage would be silent.
 *
 * Not written to disk anywhere: it is wrapped around the prompt at call time and lives
 * only here, which is why a user edit cannot break the parser.
 */
export const OUTPUT_CONTRACT = `
---

## How to answer

Reply with one fenced \`json\` block and nothing else. No preamble, no commentary.

\`\`\`json
{
  "lessons": [
    {
      "id": "short-kebab-case-slug",
      "statement": "One sentence. What is wrong with the harness, not what the agent did wrong.",
      "steps": [9, 18],
      "cost": 9,
      "confidence": 0.8,
      "matches": null,
      "proposal": { "target": "path/to/file", "change": "the smallest edit that applies this" },
      "ask": "A question for the human, if the decision is not yours to make.",
      "why": "A short paragraph of evidence: what happened, in order."
    }
  ]
}
\`\`\`

Rules:

- \`steps\` are step numbers from the log above — the \`[n]\` markers. Give the first and
  last step of the stretch the lesson is about.
- \`cost\` is how many steps this problem consumed. Count them; do not estimate.
- \`confidence\` is 0 to 1. Use below 0.5 when one more session would settle it.
- \`matches\` is the \`id\` of an existing lesson when this is the same problem recurring,
  otherwise \`null\`. Prefer matching over creating a near-duplicate.
- \`proposal\` is optional. Omit it, or use \`null\`, when you can name the problem but not
  the fix — that is a normal and useful answer.
- \`ask\` is optional and is for when the fix depends on something only the human knows.
- Return \`{"lessons": []}\` when the session went straight. An empty answer is the correct
  answer more often than not.
`

/**
 * Pulls lessons out of a model reply. Tolerant on purpose: a cheap model will wrap JSON in
 * prose, fence it twice, or trail a comma. What it must not do is fail silently — an
 * unparseable reply returns an error that reaches selfcheck.md.
 */
export function parseLessons(reply) {
  const text = String(reply ?? "")
  const candidates = []

  for (const [, block] of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(block)
  const brace = text.indexOf("{")
  if (brace !== -1) candidates.push(text.slice(brace))

  for (const candidate of candidates) {
    const parsed = tryParse(candidate)
    if (!parsed) continue
    const raw = Array.isArray(parsed) ? parsed : parsed.lessons
    if (!Array.isArray(raw)) continue
    return { ok: true, lessons: raw.map(normalise).filter(Boolean) }
  }
  return { ok: false, error: "no parseable json object in the reply", lessons: [] }
}

function tryParse(text) {
  const trimmed = text.trim()
  for (const attempt of [trimmed, trimmed.replace(/,(\s*[}\]])/g, "$1"), balance(trimmed)]) {
    if (!attempt) continue
    try {
      return JSON.parse(attempt)
    } catch {
      /* try the next repair */
    }
  }
  return null
}

/** Trims whatever follows the outermost balanced object, which is usually prose. */
function balance(text) {
  const start = text.indexOf("{")
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === "\\") escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === "{") depth++
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1)
  }
  return null
}

function normalise(lesson) {
  if (!lesson || typeof lesson !== "object") return null
  const statement = str(lesson.statement)
  if (!statement) return null

  // A model that answers `steps: 9` for a one-step lesson meant the same thing as `[9, 9]`.
  // Dropping a scalar turned a real citation into an empty range, and then into `cost: 1`.
  const rawSteps = Array.isArray(lesson.steps) ? lesson.steps : lesson.steps == null ? [] : [lesson.steps]
  const steps = rawSteps
    .map((n) => Number.parseInt(n, 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)

  const proposal =
    lesson.proposal && typeof lesson.proposal === "object" && str(lesson.proposal.change)
      ? { target: str(lesson.proposal.target) || null, change: str(lesson.proposal.change) }
      : null

  return {
    id: slug(str(lesson.id) || statement),
    statement,
    steps: steps.length ? [steps[0], steps.at(-1)] : [],
    cost: clampNumber(lesson.cost, 0, 10_000, steps.length ? steps.at(-1) - steps[0] + 1 : 1),
    confidence: clampNumber(lesson.confidence, 0, 1, 0.5),
    matches: str(lesson.matches) || null,
    proposal,
    ask: str(lesson.ask) || null,
    why: str(lesson.why) || "",
  }
}

const str = (value) => (typeof value === "string" ? value.trim() : "")

function clampNumber(value, min, max, fallback) {
  const n = typeof value === "number" ? value : Number.parseFloat(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export function slug(text) {
  const out = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 6)
    .join("-")
  return out || "lesson"
}
