// match(node, pattern): structural matching with pattern variables, the other
// half of `js`. A pattern is code: `$a` matches any node and captures it, `$$a`
// any run of list elements (an array), `$_` and `$$_` match without capturing.
// A variable may stand where a whole list element is: a statement (`{ $s }`),
// a shorthand property (`{ $$props }`), a class member, a JSX child (`{$$kids}`).
//
// Comments in the target don't matter unless the pattern has some. A comment in
// the pattern is a requirement on the comments in front of the node it leads
// (that node's `comments` attribute plus the Comment siblings right before it
// in its list):
//   /* @__PURE__ */ f()  a comment of the same kind and trimmed text
//   /* $c */, // $c      any one comment, captured as a Comment node
//   /** $doc */          any JSDoc comment (a Block comment starting with `*`)
//   /* $$cs */           all of them, an array (possibly empty)
// Several are found in order among the target's, which may have others: a single
// one takes the earliest that fits, a `$$` one the whole gap between the matches
// of its neighbours. Pattern comments at the end of a list are looked for among
// the trailing comments of the target list. At the root, the comments before the
// target in its list come from the context: `match(node, pattern, ctx)`.
//
// A `$$a` run is a slice of the target list, comments included. Comments go with
// the element they are in front of: a run takes those of its own elements, not
// those of the element after it (they are that element's front, `$$a, $b`). A run
// that ends the pattern list also takes the list's trailing comments, unless the
// pattern has comments there. A repeated `$$a` compares code only.
import { attrsOf, Node, slotsOf, type Slot } from '../ast/node.ts'
import { accessor } from '../ast/slots.ts'
import type { Ctx } from '../ast/walk.ts'

export type Captures = Record<string, any>

/**
 * Where the target sits, for the comments right before it in its list: a walk
 * `ctx`, or those comments themselves.
 */
export type MatchContext = Pick<Ctx, 'parent' | 'key' | 'index'> | { before: readonly Node[] }

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

/** The variable that pattern node `p` is, including the wrapper forms. */
function varOf(p: Node, inList: boolean): Var | undefined {
  if (p.type === 'ExpressionStatement' && !p.directive) {
    const v = varName(p.children[0])
    if (v) return v
  }
  if (inList) {
    if (p.type === 'Property' && p.shorthand) return varName(slotOf(p, 'value'))
    if (p.type === 'PropertyDefinition' && !p.computed && !p.static && !slotOf(p, 'value')) return varName(slotOf(p, 'key'))
    if (p.type === 'JSXExpressionContainer') return varName(p.children[0])
  }
  return varName(p)
}

/** Declarations and expressions of a function or class match each other. */
const kind = (type: string) =>
  type === 'FunctionDeclaration' ? 'FunctionExpression' : type === 'ClassDeclaration' ? 'ClassExpression' : type

/** Attrs that don't change what the code means; `comments` is checked on its own. */
const IGNORED = new Set(['raw', 'shorthand', 'value', 'regex', 'bigint', 'expression', 'declare', 'comments'])
const isDefault = (v: unknown) => v === undefined || v === null || v === false || (Array.isArray(v) && v.length === 0)

function sameAttrs(p: Node, t: Node): boolean {
  if (p.type === 'Literal') {
    const pr = p.regex as { pattern: string; flags: string } | undefined
    const tr = t.regex as { pattern: string; flags: string } | undefined
    if (pr || tr) return !!pr && !!tr && pr.pattern === tr.pattern && pr.flags === tr.flags
    if (p.bigint !== undefined || t.bigint !== undefined) return p.bigint === t.bigint
    if (!Object.is(p.value, t.value)) return false
  }
  if (p.type === 'TemplateElement') {
    if ((p.value as { cooked?: string })?.cooked !== (t.value as { cooked?: string })?.cooked) return false
  }
  if (p.type === 'JSXText' && p.value !== t.value) return false
  if (p.type === 'Comment') return sameComment(p, t)
  const pa = attrsOf(p)
  const ta = attrsOf(t)
  for (const key of new Set([...Object.keys(pa), ...Object.keys(ta)])) {
    if (IGNORED.has(key)) continue
    const a = pa[key]
    const b = ta[key]
    if (isDefault(a) && isDefault(b)) continue
    if (a !== b && JSON.stringify(a) !== JSON.stringify(b)) return false
  }
  return true
}

// --- comments ---

const isComment = (n: Slot | undefined): n is Node => !!n && !Array.isArray(n) && n.type === 'Comment'
/** The `comments` attribute: the leading comments of a node outside a list. */
const lead = (n: Node | null): Node[] => (n?.comments as Node[] | undefined) ?? []
const text = (c: Node) => String(c.value).trim()
const isDoc = (c: Node) => c.kind === 'Block' && String(c.value).startsWith('*')
/** Same kind and trimmed text: `/*@__PURE__*\/` is `/* @__PURE__ *\/`. */
const sameComment = (a: Node, b: Node) => a.kind === b.kind && text(a) === text(b)

/** The name a comment holds alone, if any: `/* $c *\/` -> `$c`, `/** $doc *\/` -> `$doc`. */
export const commentName = (c: Node) => /^\*?\s*(\S+)$/.exec(text(c))?.[1]

/** A comment that is a variable: `/* $c *\/`, `// $c`, `/* $$cs *\/`, `/** $doc *\/` (JSDoc only). */
function commentVar(c: Node): (Var & { doc: boolean }) | undefined {
  const name = commentName(c)
  const v = name ? variable(name) : undefined
  return v && { ...v, doc: text(c).startsWith('*') }
}

function bindComments(v: Var, value: Node | Node[], caps: Captures): boolean {
  if (v.name === '_') return true
  if (!(v.name in caps)) {
    caps[v.name] = value
    return true
  }
  const was = asList(caps[v.name])
  const now = asList(value)
  return was.length === now.length && was.every((c, i) => isComment(c) && isComment(now[i]) && sameComment(c, now[i]!))
}

/** The Comment siblings right before the node that `ctx` is about, in its list. */
export function commentsBefore(ctx: MatchContext | undefined): Node[] {
  if (!ctx) return []
  if ('before' in ctx) return [...ctx.before]
  const { parent, key, index } = ctx
  if (!parent || key === null || index === null || key === 'comments') return []
  const list = parent.children[typeof key === 'number' ? key : (slotsOf(parent.type) ?? []).findIndex((s) => accessor(s) === key)]
  if (!Array.isArray(list)) return []
  let from = index
  while (from > 0 && isComment(list[from - 1])) from--
  return list.slice(from, index) as Node[]
}

interface Item {
  node: Node | null
  /** The Comment siblings right before `node`. */
  front: Node[]
  /** Where the item starts in the list, its front included. */
  start: number
}

/** A list as elements with their front comments, plus the comments after the last one. */
function group(list: (Node | null)[]) {
  const items: Item[] = []
  let front: Node[] = []
  list.forEach((n, i) => {
    if (isComment(n)) return void front.push(n)
    items.push({ node: n, front, start: i - front.length })
    front = []
  })
  return { items, trailing: front, end: list.length - front.length }
}

class Matcher {
  /** False when comparing two captures: there `$x` is just a name, and comments don't matter. */
  readonly vars: boolean
  constructor(vars: boolean) {
    this.vars = vars
  }

  bind(v: Var, value: Node | (Node | null)[], caps: Captures): boolean {
    if (v.name === '_') return true
    if (!(v.name in caps)) {
      caps[v.name] = value
      return true
    }
    const was = caps[v.name]
    return Array.isArray(was) || Array.isArray(value) ? exact.list(asList(was), asList(value), {}) !== null : exact.node(was, value, {})
  }

  /**
   * `p` against `t`. `pFront` and `tFront` are the Comment siblings right
   * before them in their lists (or, for `t` at the root, from the context).
   */
  node(p: Node | null, t: Node | null, caps: Captures, inList = false, pFront: Node[] = [], tFront: Node[] = []): boolean {
    if (!p || !t) return p === t && this.front(pFront, tFront, caps)
    const v = this.vars ? varOf(p, inList) : undefined
    if (v) return this.front([...pFront, ...lead(p)], [...tFront, ...lead(t)], caps) && this.bind(v, t, caps)
    // An expression pattern matches an expression statement: `match(stmt, js\`f($$a)\`)`.
    if (t.type === 'ExpressionStatement' && !/Statement$|Declaration$/.test(p.type)) {
      return this.node(p, t.children[0] as Node, caps, false, pFront, [...tFront, ...lead(t)])
    }
    if (kind(p.type) !== kind(t.type) || !sameAttrs(p, t)) return false
    if (!this.front([...pFront, ...lead(p)], [...tFront, ...lead(t)], caps)) return false
    const n = Math.max(p.children.length, t.children.length)
    for (let i = 0; i < n; i++) {
      const ps = p.children[i] ?? null
      const ts = t.children[i] ?? null
      if (Array.isArray(ps) || Array.isArray(ts)) {
        const found = this.list(asList(ps), asList(ts), caps)
        if (!found) return false
        Object.assign(caps, found)
      } else if (!this.node(ps, ts, caps)) return false
    }
    return true
  }

  /** Captures after matching list `ps` against list `ts` exactly, or null; backtracks over sequences. */
  list(ps: (Node | null)[], ts: (Node | null)[], caps: Captures): Captures | null {
    const P = group(ps)
    const T = group(ts)
    /** Where target item `k` starts in `ts`, its front comments included. */
    const at = (k: number) => (k < T.items.length ? T.items[k].start : T.end)
    const go = (i: number, j: number, caps: Captures): Captures | null => {
      if (i === P.items.length) {
        if (j !== T.items.length) return null
        const next = { ...caps }
        return this.front(P.trailing, T.trailing, next) ? next : null
      }
      const { node: p, front } = P.items[i]
      const v = p && this.vars ? varOf(p, true) : undefined
      if (v?.seq) {
        // The last run takes the trailing comments, if the pattern has none there.
        const last = i === P.items.length - 1 && !P.trailing.length
        for (let k = j; k <= T.items.length; k++) {
          const next = { ...caps }
          const first = j < k ? T.items[j] : undefined
          // Comments in front of `$$a` are looked for in front of the run's first element.
          if (!this.front(front, first ? [...first.front, ...lead(first.node)] : [], next)) continue
          if (this.bind(v, ts.slice(at(j), k === T.items.length && last ? ts.length : at(k)), next)) {
            const found = go(i + 1, k, next)
            if (found) return found
          }
        }
        return null
      }
      if (j === T.items.length) return null
      const next = { ...caps }
      const t = T.items[j]
      return this.node(p, t.node, next, true, front, t.front) ? go(i + 1, j + 1, next) : null
    }
    return go(0, 0, caps)
  }

  /** Pattern comments `need` found in order among the target's `have`; captures go into `caps`. */
  front(need: Node[], have: Node[], caps: Captures): boolean {
    if (!this.vars || !need.length) return true
    const go = (i: number, j: number, caps: Captures): Captures | null => {
      if (i === need.length) return caps
      const v = commentVar(need[i])
      if (!v?.seq) {
        for (let k = j; k < have.length; k++) {
          const next = { ...caps }
          if (this.comment(need[i], have[k], next)) {
            const found = go(i + 1, k + 1, next)
            if (found) return found
          }
        }
        return null
      }
      // A `$$` comment takes the gap up to where the next single one matches (or
      // the end); `$$` ones right after it get nothing.
      let n = i + 1
      while (n < need.length && commentVar(need[n])?.seq) n++
      const gap = (k: number) => {
        const next = { ...caps }
        for (let s = i; s < n; s++) {
          const sv = commentVar(need[s])!
          if (!bindComments(sv, s === i ? have.slice(j, k).filter((c) => !sv.doc || isDoc(c)) : [], next)) return null
        }
        return next
      }
      if (n === need.length) {
        const next = gap(have.length)
        return next && go(n, have.length, next)
      }
      for (let k = j; k < have.length; k++) {
        const next = gap(k)
        if (next && this.comment(need[n], have[k], next)) {
          const found = go(n + 1, k + 1, next)
          if (found) return found
        }
      }
      return null
    }
    const found = go(0, 0, caps)
    if (found) Object.assign(caps, found)
    return !!found
  }

  /** One pattern comment against one target comment. */
  comment(p: Node, t: Node, caps: Captures): boolean {
    const v = commentVar(p)
    if (!v) return sameComment(p, t)
    return (!v.doc || isDoc(t)) && bindComments(v, t, caps)
  }
}

const asList = (s: unknown): (Node | null)[] => (Array.isArray(s) ? s : s === null || s === undefined ? [] : [s as Node])

const withVars = new Matcher(true)
const exact = new Matcher(false)

/**
 * The captures if `node` matches `pattern`, else null. `pattern` is usually
 * from `js`: `match(node, js\`$a + $b\`)` gives `{ a, b }`. Layout and literal
 * spelling (`0x1` and `1`) don't matter, nor do comments the pattern doesn't
 * ask for. A list of nodes matches a list pattern (`js.stmts`). `ctx` (a walk
 * ctx, or `{ before }`) gives the comments before `node` in its list, for a
 * pattern with comments in front: `match(node, js\`/** $doc *\/ function $f() {}\`, ctx)`.
 */
export function match(node: Node | Node[], pattern: Node | Node[], ctx?: MatchContext): Captures | null {
  if (Array.isArray(pattern) || Array.isArray(node)) return withVars.list(asList(pattern), asList(node), {})
  const caps: Captures = {}
  return withVars.node(pattern, node, caps, false, [], commentsBefore(ctx)) ? caps : null
}
