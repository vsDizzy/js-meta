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
//
// Comments in front of the pattern (`/* $$cs */ f($$a)`) are also looked for
// among the Comment siblings right before the node in its list. Those siblings
// stay where they are: a rule replaces the node, not its neighbours. So where
// the replacement puts them back in front of itself (`/* $$cs */ g($$a)`), they
// are dropped from it rather than doubled; put anywhere else, they are copies.
import { make, Node, withChildren } from '../ast/node.ts'
import type { Ctx } from '../ast/walk.ts'
import { substitute } from './index.ts'
import { commentsBefore, match, type Captures } from './match.ts'

type Replacement = Node | null | ((m: Captures, node: Node, ctx: Ctx) => Node | null | undefined | void)

/** A walk handler; also usable on its own: `r(node, ctx)`. */
export interface Rule {
  (node: Node, ctx: Ctx): Node | null | undefined
  /** One try at this node: the replacement, or undefined if the rule doesn't fire. */
  once(node: Node, ctx: Ctx): Node | null | undefined
}

const LIMIT = 100

const isStatement = (n: Node) => /Statement$|Declaration$/.test(n.type)

/** `node` without the leading comments in `gone` (they are already in front of it). */
function without(node: Node, gone: Node[]): Node {
  const comments = node.comments as Node[] | undefined
  if (!gone.length || !comments?.some((c) => gone.includes(c))) return node
  const out = withChildren(node, node.children)
  const rest = comments.filter((c) => !gone.includes(c))
  if (rest.length) out.comments = rest
  else delete out.comments
  return out
}

/**
 * A rule: where `pattern` matches, put `replace` — a template with the same
 * `$` variables, a function of the captures (return nothing to pass), or null
 * to remove the node.
 */
export function rule(pattern: Node, replace: Replacement): Rule {
  const once = (node: Node, ctx: Ctx) => {
    const m = match(node, pattern, ctx)
    if (!m) return undefined
    let out = replace === null ? null : typeof replace === 'function' ? (replace(m, node, ctx) ?? undefined) : (substitute(replace, m) as Node)
    if (out) out = without(out, commentsBefore(ctx))
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
