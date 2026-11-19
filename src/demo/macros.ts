// The demo's macros, as the runtime's `transform`: src/app.ts boots with it, and the
// scope corpus test expands src/demo with it, so a macro is never a free name.
import { emit, js, rule, rules, walk, type Node } from '../index.ts'

export const macros = rules(
  // `assert(cond)` -> a check whose message is the condition's own code.
  rule(js.stmt`assert($cond)`, (m) => js.stmt`if (!(${m.cond})) throw new Error(${`assertion failed: ${emit(m.cond).trim()}`})`),
)

export const transform = (ast: Node): Node | null => walk(ast, macros)
