export function sum(numbers) {
  return numbers.reduce((a, b) => a + b, 0)
}

export function mean(numbers) {
  return numbers.length ? sum(numbers) / numbers.length : NaN
}
