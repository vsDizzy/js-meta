// Entry of the demo: loaded by bootstrap(), read, lowered and run by js-meta.
import { count, inc } from './counter.js'
import { greet } from './greet.ts'

const before = count
inc()
inc()
console.log(`[demo] ${greet('js-meta')}: count ${before} -> ${count} (live binding)`)
console.log(`[demo] import.meta.url = ${import.meta.url}`)

export const where = new Error('stack check').stack?.split('\n')[1]?.trim()
