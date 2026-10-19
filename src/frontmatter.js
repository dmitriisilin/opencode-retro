/**
 * A deliberately small YAML subset: enough for the lesson format in README, no more.
 *
 * We own the writer, so the emitter only has to produce shapes we choose. The reader has
 * to be a little more forgiving, because users will open these files and edit them by hand
 * (AGENTS.md "Conventions"). It handles scalars, one level of nested maps, lists of maps,
 * inline arrays and `|` block scalars. Anything else is left as a string rather than
 * guessed at.
 */

export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text ?? "")
  if (!match) return { data: {}, body: (text ?? "").trim() }
  return { data: parseBlock(match[1].split(/\r?\n/)), body: text.slice(match[0].length).trim() }
}

export function stringifyFrontmatter(data, body = "") {
  const yaml = emitBlock(data, 0).join("\n")
  return `---\n${yaml}\n---\n\n${body.trim()}\n`
}

/* ------------------------------------------------------------------ reading */

function parseBlock(lines) {
  const [value] = parseLines(lines, 0, 0)
  return value ?? {}
}

/** Returns [value, nextIndex]. `indent` is the indentation this block sits at. */
function parseLines(lines, start, indent) {
  const isList = () => {
    for (let i = start; i < lines.length; i++) {
      const line = lines[i]
      if (!line.trim() || line.trim().startsWith("#")) continue
      return indentOf(line) === indent && line.trim().startsWith("- ")
    }
    return false
  }

  if (isList()) return parseList(lines, start, indent)

  const map = {}
  let i = start
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith("#")) {
      i++
      continue
    }
    if (indentOf(line) < indent) break
    if (indentOf(line) > indent) {
      i++ // stray deeper line with no key to hang off; skip rather than guess
      continue
    }

    const colon = splitKey(line.trim())
    if (!colon) {
      i++
      continue
    }
    const [key, rest] = colon
    i++

    if (rest === "|" || rest === "|-") {
      const [text, next] = parseBlockScalar(lines, i, indent)
      map[key] = rest === "|-" ? text.replace(/\n+$/, "") : text
      i = next
      continue
    }
    if (rest === "") {
      const childIndent = nextIndent(lines, i, indent)
      if (childIndent === null) {
        map[key] = null
        continue
      }
      const [value, next] = parseLines(lines, i, childIndent)
      map[key] = value
      i = next
      continue
    }
    map[key] = parseScalar(rest)
  }
  return [map, i]
}

function parseList(lines, start, indent) {
  const items = []
  let i = start
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith("#")) {
      i++
      continue
    }
    if (indentOf(line) < indent) break
    const trimmed = line.trim()
    if (indentOf(line) !== indent || !trimmed.startsWith("- ")) break

    const inline = trimmed.slice(2)
    const colon = splitKey(inline)
    if (colon) {
      // "- key: value" plus any further keys indented under it
      const rebuilt = [" ".repeat(indent + 2) + inline, ...lines.slice(i + 1)]
      const [value, consumed] = parseLines(rebuilt, 0, indent + 2)
      items.push(value)
      i = i + consumed
    } else {
      items.push(parseScalar(inline))
      i++
    }
  }
  return [items, i]
}

function parseBlockScalar(lines, start, indent) {
  const body = []
  let i = start
  let inner = null
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() && indentOf(line) <= indent) break
    if (inner === null && line.trim()) inner = indentOf(line)
    body.push(line.trim() ? line.slice(inner ?? indent + 2) : "")
    i++
  }
  while (body.length && !body.at(-1).trim()) body.pop()
  return [body.join("\n") + "\n", i]
}

/** Splits `key: value`, leaving colons inside quotes and URLs alone. */
function splitKey(text) {
  const m = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(text)
  if (!m) return null
  return [m[1], (m[2] ?? "").trim()]
}

function parseScalar(raw) {
  if (raw === "" || raw === "~" || raw === "null") return null
  if (raw === "true") return true
  if (raw === "false") return false
  if (/^-?\d+$/.test(raw)) return Number(raw)
  if (/^-?\d*\.\d+$/.test(raw)) return Number(raw)
  if (/^\[.*\]$/.test(raw)) {
    const inner = raw.slice(1, -1).trim()
    return inner ? inner.split(",").map((p) => parseScalar(p.trim())) : []
  }
  if (/^".*"$/.test(raw) || /^'.*'$/.test(raw)) return raw.slice(1, -1)
  return raw
}

const indentOf = (line) => line.length - line.trimStart().length

function nextIndent(lines, start, indent) {
  for (let i = start; i < lines.length; i++) {
    if (!lines[i].trim()) continue
    const got = indentOf(lines[i])
    return got > indent ? got : null
  }
  return null
}

/* ------------------------------------------------------------------ writing */

function emitBlock(value, indent) {
  const pad = " ".repeat(indent)
  const lines = []
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    if (item === null) {
      lines.push(`${pad}${key}:`)
    } else if (Array.isArray(item)) {
      if (item.length === 0) lines.push(`${pad}${key}: []`)
      else if (item.every((v) => typeof v === "number" || typeof v === "boolean")) {
        lines.push(`${pad}${key}: [${item.join(", ")}]`)
      } else {
        lines.push(`${pad}${key}:`)
        for (const entry of item) {
          if (entry && typeof entry === "object" && !Array.isArray(entry)) {
            const sub = emitBlock(entry, indent + 4)
            lines.push(`${pad}  - ${sub[0].trimStart()}`, ...sub.slice(1))
          } else {
            lines.push(`${pad}  - ${emitScalar(entry)}`)
          }
        }
      }
    } else if (typeof item === "object") {
      lines.push(`${pad}${key}:`, ...emitBlock(item, indent + 2))
    } else if (typeof item === "string" && item.includes("\n")) {
      lines.push(`${pad}${key}: |`)
      for (const line of item.replace(/\n+$/, "").split("\n")) lines.push(line ? `${pad}  ${line}` : "")
    } else {
      lines.push(`${pad}${key}: ${emitScalar(item)}`)
    }
  }
  return lines
}

function emitScalar(value) {
  if (typeof value !== "string") return String(value)
  const needsQuotes = value === "" || /^[\s>|*&!%@`#-]|:\s|\s$|^(true|false|null|~)$|^-?\d+(\.\d+)?$/.test(value)
  return needsQuotes ? JSON.stringify(value) : value
}
