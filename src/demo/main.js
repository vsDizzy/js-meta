// Entry of the demo: loaded by bootstrap(), read, expanded, lowered and run by js-meta.
import { count, inc, label } from './counter.js'
import { greet } from './greet.ts'

const before = count
inc()
inc()
// `assert` is a macro (src/demo/macros.ts): it expands to a check that quotes its own code.
assert(count === before + 2)
console.log(`[demo] ${greet('js-meta')}: count ${before} -> ${count} (live binding)`)
console.log(`[demo] import.meta.url = ${import.meta.url}`)

/** A callback handed out once; it keeps reaching the current definitions. */
export const click = () => {
  inc()
  return label()
}
