import { test } from "node:test"
import assert from "node:assert/strict"
import { hiddenTools } from "../src/permissions.js"

const files = (map) => ({ home: "/home/x", directory: "/proj", read: (p) => {
  if (p in map) return map[p]
  throw new Error("ENOENT")
} })

test("a deny-all with an allowlist that leaves the plugin's tools out hides them, as OpenCode reads it", () => {
  // Issue #2's configuration, the rule OpenCode applies: the last matching rule decides, and a
  // deny with resource "*" drops the tool from every session's toolset.
  const config = JSON.stringify({ permissions: [
    { action: "*", resource: "*", effect: "deny" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "subagent", resource: "*", effect: "allow" },
  ] })
  const r = hiddenTools(files({ "/proj/opencode.json": config }))
  assert.deepEqual(r.hidden, ["retro_record", "retro_propose", "retro_decide"])
  assert.deepEqual(r.files, ["/proj/opencode.json"])
})

test("allow rules after the deny, or a project rule over a global one, make them visible", () => {
  const deny = { action: "*", resource: "*", effect: "deny" }
  const allow = ["retro_record", "retro_propose", "retro_decide"].map((action) => ({ action, resource: "*", effect: "allow" }))
  assert.deepEqual(hiddenTools(files({ "/proj/opencode.json": JSON.stringify({ permissions: [deny, ...allow] }) })).hidden, [])
  assert.deepEqual(
    hiddenTools(files({
      "/home/x/.config/opencode/opencode.json": JSON.stringify({ permissions: [deny] }),
      "/proj/opencode.jsonc": `{ // the project's own
        "permissions": [ { "action": "retro_*", "resource": "*", "effect": "allow" }, ] }`,
    })).hidden,
    [],
    "a glob, in a jsonc file with a comment and a trailing comma",
  )
  assert.deepEqual(hiddenTools(files({})).hidden, [], "no configuration hides nothing")
  assert.deepEqual(
    hiddenTools(files({ "/proj/opencode.json": JSON.stringify({ permissions: [{ action: "*", resource: "src/**", effect: "deny" }] }) })).hidden,
    [],
    "a deny on a narrower resource asks, it does not hide",
  )
})
