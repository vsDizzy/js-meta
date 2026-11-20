// match(node, pattern): structural matching with pattern variables, the other
// half of `js`. A pattern is code: `$a` matches any node and captures it, `$$a`
// any run of list elements (an array), `$_` and `$$_` match without capturing.
// A variable may stand where a whole list element is: a statement (`{ $s }`),
// a shorthand property (`{ $$props }`), a class member, a JSX child (`{$$kids}`),
// and where a type is (`x as $T`, `A | $$Ts`): a reference to a lone `$` name.
// `$x: $T` is a variable with a type: the annotation must match too.
//
// Comments in the target don't matter unless the pattern has some. A comment in
// the pattern is a requirement on the comments in front of the node it leads:
//   /* @__PURE__ */ f()  a comment of the same kind and trimmed text
//   /* $c */, // $c      any one comment, captured as a Comment node
//   /** $doc */          any JSDoc comment (a Block comment starting with `*`)
//   /* $$cs */           all of them, an array (possibly empty)
// At the root, the comments before the target in its list come from the
// context: `match(node, pattern, ctx)`. The rules are the core's (match/match.ts).
//
// A pattern is compiled once into a core pattern (match/pat.ts): the variables
// become `pat/` nodes, the rest stays code and matches exactly.
import { attrsOf, make, Node, slotsOf, type Slot } from '../ast/node.ts'
import { commentsBefore, matchPattern, type Captures, type MatchContext } from '../match/match.ts'
import { p } from '../match/pat.ts'

export { commentsBefore, type Captures, type MatchContext }

interface Var {
  name: string
  seq: boolean
}

const VAR = /^\$(\$?)([A-Za-z_][\w$]*)$/

/** `$a` -> { name: 'a' }, `$$a` -> { name: 'a', seq: true }. */
export function variable(name: string): Var | undefined {
  const m = VAR.exec(name)
  return m ? { name: m[2], seq: m[1] === '$' } : undefined
}

function varName(n: Slot): Var | undefined {
  if (!n || Array.isArray(n) || (n.type !== 'Identifier' && n.type !== 'JSXIdentifier') || typeof n.name !== 'string') return undefined
  return variable(n.name)
}

const slotOf = (n: Node, name: string) => n.children[slotsOf(n.type)!.indexOf(name)] ?? null

/** The variable that pattern node `n` is, including the wrapper forms. */
function varOf(n: Node, inList: boolean): Var | undefined {
  if (n.type === 'ExpressionStatement' && !n.directive) {
    const v = varName(n.children[0])
    if (v) return v
  }
  // A type that is a lone name stands for any type: `x as $T`.
  if (n.type === 'TSTypeReference' && !slotOf(n, 'typeArguments')) {
    const v = varName(slotOf(n, 'typeName'))
    if (v) return v
  }
  if (inList) {
    if (n.type === 'Property' && n.shorthand) return varName(slotOf(n, 'value'))
    if (n.type === 'PropertyDefinition' && !n.computed && !n.static && !slotOf(n, 'value')) return varName(slotOf(n, 'key'))
    if (n.type === 'JSXExpressionContainer') return varName(n.children[0])
  }
  return varName(n)
}

const text = (c: Node) => String(c.value).trim()
const lead = (n: Node): Node[] => (n.comments as Node[] | undefined) ?? []

/** The name a comment holds alone, if any: `/* $c *\/` -> `$c`, `/** $doc *\/` -> `$doc`. */
export const commentName = (c: Node) => /^\*?\s*(\S+)$/.exec(text(c))?.[1]

/** A comment that is a variable (`/* $c *\/`, `// $c`, `/* $$cs *\/`, `/** $doc *\/`) as a `pat/comment`. */
function comment(c: Node): Node {
  const name = commentName(c)
  const v = name ? variable(name) : undefined
  return v ? p.comment(v.name, { seq: v.seq, doc: text(c).startsWith('*') }) : c
}

const lists = new WeakMap<(Node | null)[], (Node | null)[]>()

/** A list with its variables compiled; the same array if it has none. */
function list(items: (Node | null)[]): (Node | null)[] {
  let out = lists.get(items)
  if (out) return out
  let changed = false
  out = items.map((el) => {
    const c = !el ? el : el.type === 'Comment' ? comment(el) : one(el, true)
    if (c !== el) changed = true
    return c
  })
  if (!changed) out = items
  lists.set(items, out)
  return out
}

/** `node` with `comments` in front: a copy, or `node` if they are its own. */
function withLead(node: Node, comments: Node[]): Node {
  const now = lead(node)
  if (now.length === comments.length && now.every((c, i) => c === comments[i])) return node
  const attrs = attrsOf(node)
  if (comments.length) attrs.comments = comments
  else delete attrs.comments
  return make(node.type, attrs, node.children)
}

/** The core pattern for variable `v`, written as `n`. */
function compileVar(n: Node, v: Var, inList: boolean): Node {
  // `$x: $T`: the annotation must match too; `$x` alone takes any.
  const annotation = n.type === 'Identifier' ? slotOf(n, 'typeAnnotation') : null
  const of = annotation && !Array.isArray(annotation) ? p.node(null, { typeAnnotation: one(annotation, false) }) : undefined
  const name = v.name === '_' ? undefined : v.name
  // `$$a` outside a list is one node.
  const pat = v.seq && inList ? p.rest(name, of) : name ? p.bind(name, of) : (of ?? p.any())
  return withLead(pat, list(lead(n)) as Node[])
}

const compiled = [new WeakMap<Node, Node>(), new WeakMap<Node, Node>()]

/** `n` compiled; `inList`: it is a list element (where the wrapper forms count). Untouched subtrees are shared. */
function one(n: Node, inList: boolean): Node {
  const cache = compiled[+inList]
  let out = cache.get(n)
  if (out) return out
  const v = varOf(n, inList)
  if (v) out = compileVar(n, v, inList)
  else {
    let changed = false
    const children = n.children.map((slot): Slot => {
      const c = Array.isArray(slot) ? list(slot) : slot && one(slot, false)
      if (c !== slot) changed = true
      return c
    })
    out = changed ? make(n.type, attrsOf(n), children) : n
    out = withLead(out, list(lead(n)) as Node[])
  }
  cache.set(n, out)
  return out
}

/**
 * The core pattern for a `js` pattern: `$a` -> p.bind('a'), `$_` -> p.any(),
 * `$$a` -> p.rest('a'), comment variables -> p.comment(...); the rest is code
 * and stays as it is. Cached: a `js` pattern without holes is compiled once.
 * `inList`: `pattern` is matched as a list element.
 */
export function compile(pattern: Node, inList?: boolean): Node
export function compile(pattern: Node[]): Node[]
export function compile(pattern: Node | Node[], inList?: boolean): Node | Node[]
export function compile(pattern: Node | Node[], inList = false): Node | Node[] {
  return Array.isArray(pattern) ? (list(pattern) as Node[]) : one(pattern, inList)
}

/**
 * The captures if `node` matches `pattern`, else null. `pattern` is usually
 * from `js`: `match(node, js\`$a + $b\`)` gives `{ a, b }`. Layout and literal
 * spelling (`0x1` and `1`) don't matter, nor do comments the pattern doesn't
 * ask for. A list of nodes matches a list pattern (`js.stmts`). `ctx` (a walk
 * ctx, or `{ before }`) gives the comments before `node` in its list, for a
 * pattern with comments in front: `match(node, js\`/** $doc *\/ function $f() {}\`, ctx)`.
 */
export function match(node: Node | Node[], pattern: Node | Node[], ctx?: MatchContext): Captures | null {
  return matchPattern(node, compile(pattern, Array.isArray(node)), ctx)
}
