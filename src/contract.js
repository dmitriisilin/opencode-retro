/**
 * The output contract (AGENTS.md decision 14).
 *
 * It lives here, in source, and is written into every work order after the user's prompt.
 * The prompt file never holds it, so an edit to the prompt cannot break it, and the file has
 * no do-not-touch region in it — a file with one is a file someone will eventually touch.
 *
 * The answer is a call to `retro_record`, whose schema (`RECORD_INPUT`) is the machine half
 * of this contract: OpenCode refuses a malformed call and tells the subagent why, so there is
 * no reply text to parse. What stays in prose is what a schema cannot say — what the fields
 * mean, and how to read a shadow log.
 *
 * It describes the log rather than containing it. The order names the file; reading it is
 * the subagent's job, and it has the tools for that.
 */
export const OUTPUT_CONTRACT = `
---

## How to answer

Call the \`retro_record\` tool exactly once, with \`session\` set to the session id at the
top of this file, \`lessons\` set to what you found, and \`through\` set to the last step
number you actually read:

\`\`\`json
{
  "session": "ses_…",
  "through": 42,
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

Read the log named above first — all of it that this order asks for. It is one JSON object
per line, and the fields you need are:

- \`n\` — the step number. This is the coordinate a lesson cites.
- \`k\` — what the step is: \`prompt\` (a person's instruction), \`text\` (the agent's reply),
  \`tool\` (a tool call, with \`tool\`, \`input\`, \`status\`, \`exit\` and \`output\`), \`step\`
  (an edit, with the files it touched), \`handover\` (text this plugin wrote into the session
  itself — see the rule on reviews below), \`session\` (a turn starting or ending).
- \`from\` — on a step that came from a subagent's session rather than the person's: its
  session id. A \`prompt\` with \`from\` is a delegation's instruction, not the person's. A
  \`subagent\` call's \`child\` is the session it started, whose steps carry that \`from\`.
- \`exit\` on a tool call — **read this, not \`status\`.** A shell command that failed is
  \`status: "completed"\` with a non-zero \`exit\`. An analysis that reads \`status\` sees a
  clean session.
- \`output\` may say that its middle was elided: very large tool results are clamped when
  the log is written, and the notice says how much went.

Read it in whatever way suits its size — all at once, or the head and then on.

\`through\` is how far you got, and it is required: nothing else knows. Give the last step
number the order names when you read all of it, or the last one you actually reached when you
did not — the rest is then asked about again instead of being counted as read. Do not round
it up to make the answer look complete; an honest partial read loses nothing, and a false
full one loses the part nobody will ever come back to.

Do not edit anything, do not run commands, and do not go looking through the project: you
are judging the log, not redoing the work, and not checking whether the problem is still
there. When the call has been made, reply with one word: done.

Rules:

- \`steps\` are the \`n\` of the first and last step of the stretch the lesson is about.
- \`cost\` is how many steps this problem consumed. Count them; do not estimate.
- \`confidence\` is 0 to 1. Use below 0.5 when one more session would settle it.
- \`matches\` is the \`id\` of an existing lesson when this is the same problem recurring,
  otherwise \`null\`. Prefer matching over creating a near-duplicate. When this session ran
  into a problem that is already recorded, report it again with \`matches\` set — that is
  how recurrence is counted, and leaving it out makes a problem that happens in every session
  look as if it happened once. Already recorded is not the same as already answered.
- Work that follows a \`handover\` step with \`"about": "lesson"\` and checks or applies the
  lesson it handed over is the review of that lesson, not the problem happening again: do not
  report it as a recurrence, and do not count its steps as cost. Counting it would make every
  lesson that gets reviewed look more important for having been reviewed. Only
  \`"about": "lesson"\` means that — and not a hand-over that a later notice with
  \`"undelivered": true\` names by its step (\`of\`): that one never arrived, and what follows it
  is ordinary work.
- **The plugin's own work is not the session's — leave it out.** A \`handover\` with
  \`"about": "work"\` asks for a round of this plugin's own: the agent starting readers like
  you, their records coming back, \`retro_propose\`. The order names, step by step, everything
  in this log that is the plugin's own — its rounds, its calls to \`retro_record\` and
  \`retro_propose\`, a \`subagent\` call whose prompt is a work order's line, and whatever such
  a reader did. Leave exactly those steps out: take no lesson from them, count none of them as
  cost, and read nothing in them as a recurrence — a reader in there may be quoting another
  session's problems, and they are that session's. Where the order names none, there are none.
  A \`handover\` with \`"about": "notice"\` is this plugin saying something else — nothing to
  review, a command that failed — and what follows it is ordinary work, but for the agent's
  text in answer to it, and what a subagent it started for that answer was told and said:
  those are the plugin's exchange and hold nothing of the session's.
- \`proposal\` is optional. Omit it, or use \`null\`, when you can name the problem but not
  the fix — that is a normal and useful answer.
- \`ask\` is optional and is for when the fix depends on something only the human knows.
- Record \`"lessons": []\` when the session went straight. An empty answer is the correct
  answer more often than not — but it still has to be recorded, or the log is asked about
  again.
`

/** The `retro_record` tool's input: the machine half of the contract. */
export const RECORD_INPUT = {
  type: "object",
  properties: {
    session: { type: "string", description: "The session id named at the top of the work order." },
    lessons: {
      type: "array",
      description: "What this session should have taught the project. Empty when it went straight.",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          statement: { type: "string" },
          steps: { type: "array", items: { type: "number" } },
          cost: { type: "number" },
          confidence: { type: "number" },
          matches: { type: ["string", "null"] },
          proposal: {
            type: ["object", "null"],
            properties: { target: { type: ["string", "null"] }, change: { type: "string" } },
          },
          ask: { type: ["string", "null"] },
          why: { type: "string" },
        },
        required: ["statement"],
      },
    },
    through: {
      type: "number",
      description:
        "The last step number you actually read. The order says how far the log goes; say " +
        "that number when you read all of it, or a smaller one when you did not.",
    },
  },
  required: ["session", "lessons", "through"],
}

/**
 * Lessons as the store wants them, from whatever shape a record carried.
 *
 * The schema asks for an array, and OpenCode enforces it — but a model handed a nested
 * structure will put it in a string often enough that refusing one would throw away a
 * perfectly good answer. A string is read with the same tolerant parser a reply used to
 * need: fenced, prose-wrapped, trailing-comma JSON all survive.
 */
export const normaliseLessons = (raw) => {
  if (Array.isArray(raw)) return raw.map(normalise).filter(Boolean)
  if (typeof raw === "string") return parseLessons(raw).lessons
  return []
}

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
  // A bare array, last of all: the `steps` of a well-formed object answer start with a `[`
  // too, so this must only ever be reached once every object candidate has failed.
  const bracket = text.indexOf("[")
  if (bracket !== -1) candidates.push(text.slice(bracket))

  for (const candidate of candidates) {
    const parsed = tryParse(candidate)
    if (!parsed) continue
    const raw = Array.isArray(parsed) ? parsed : parsed.lessons
    if (!Array.isArray(raw)) continue
    // Lessons are objects. An array of numbers is a `steps` list that happened to parse,
    // and reading it as an answer would report "nothing to learn" about a session nobody read.
    if (raw.some((l) => !l || typeof l !== "object")) continue
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
