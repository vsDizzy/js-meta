// Rewrite rules for walk:
//
//   walk(ast, rule(js`add($a, $b)`, js`($a + $b)`))
//   walk(ast, rules(
//     rule(js`add($a, $b)`, (m) => js`(${m.a} + ${m.b})`),
//     rule(js`log($$args)`, null),          // remove
//   ))
//
// A rule fires on enter, outer forms first (like macroexpand): `walk` then goes
// into the replacement's children, so nested forms expand too. At the node
// itself rules repeat until none fires: a macro may expand into another macro.
import { make, Node } from '../ast/node.ts'
import type { Ctx } from '../ast/walk.ts'
import { substitute } from './index.ts'
import { match, type Captures } from './match.ts'

type Replacement = Node | null | ((m: Captures, node: Node, ctx: Ctx) => Node | null | undefined | void)

/** A walk handler; also usable on its own: `r(node, ctx)`. */
export interface Rule {
  (node: Node, ctx: Ctx): Node | null | undefined
  /** One try at this node: the replacement, or undefined if the rule doesn't fire. */
  once(node: Node, ctx: Ctx): Node | null | undefined
}

const LIMIT = 100

const isStatement = (n: Node) => /Statement$|Declaration$/.test(n.type)

/**
 * A rule: where `pattern` matches, put `replace` — a template with the same
 * `$` variables, a function of the captures (return nothing to pass), or null
 * to remove the node.
 */
export function rule(pattern: Node, replace: Replacement): Rule {
  const once = (node: Node, ctx: Ctx) => {
    const m = match(node, pattern)
    if (!m) return undefined
    const out = replace === null ? null : typeof replace === 'function' ? (replace(m, node, ctx) ?? undefined) : (substitute(replace, m) as Node)
    // An expression pattern also fires on its statement (`log(x)` alone): null
    // removes the statement, an expression stays one.
    if (out && node.type === 'ExpressionStatement' && !isStatement(out)) return make('ExpressionStatement', {}, [out])
    return out
  }
  return rules({ once } as Rule)
}

/** Several rules: at each node the first that fires wins, until none does. */
export function rules(...list: Rule[]): Rule {
  const once = (node: Node, ctx: Ctx) => {
    for (const r of list) {
      const out = r.once(node, ctx)
      if (out !== undefined) return out
    }
    return undefined
  }
  const apply = (node: Node, ctx: Ctx) => {
    let current = node
    for (let i = 0; i < LIMIT; i++) {
      const out = once(current, ctx)
      if (out === null) return null
      if (out === undefined || out === current) return current === node ? undefined : current
      current = out
    }
    throw new Error(`rules keep firing at the same node (${LIMIT} times): a rule expands into its own pattern`)
  }
  return Object.assign(apply, { once })
}
