import { config } from "./config.js"

export function greet(name) {
  return `${config.greeting}, ${name}!`
}
