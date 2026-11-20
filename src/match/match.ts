// The matcher: `matchPattern(node, pattern, ctx?)` gives the captures or null.
// A pattern is a tree in which nodes of the `pat/` family may stand (pat.ts).
// Every other node in it is a literal and matches exactly: the same kind (up to
// its family's `canon`), the same attributes that count (the family's `ignored`
// and `equal`), and slot by slot the same children, list for list. A `pat/node`
// checks the kind and only the fields it names. Nothing here knows a language:
// that comes from the node families (ast/family.ts).
//
// An expression pattern matches the statement that only wraps it (the family's
// `unwrap`): a literal that is not a statement, or a `pat/node` none of whose
// kinds takes the statement. `pat/bind` and `pat/any` take the statement itself.
//
// Comments in the target don't matter unless the pattern has some. A comment in
// the pattern is a requirement on the comments in front of the node it leads
// (that node's `comments` attribute plus the Comment siblings right before it
// in its list); any pattern node may carry them, `pat/` ones included:
//   a Comment              one of the same kind and trimmed text
//   p.comment('c')         any one comment, captured as a Comment node
//   { doc: true }          any JSDoc comment (a Block comment starting with `*`)
//   { seq: true }          all of them, an array (possibly empty)
// Several are found in order among the target's, which may have others: a single
// one takes the earliest that fits, a `seq` one the whole gap between the matches
// of its neighbours. Pattern comments at the end of a list are looked for among
// the trailing comments of the target list. At the root, the comments before the
// target in its list come from the context: `matchPattern(node, pattern, ctx)`.
//
// A run (`pat/rep`) is a slice of the target list, comments included. Comments go
// with the element they are in front of: a run takes those of its own elements,
// not those of the element after it. A run that ends the pattern list also takes
// the list's trailing comments, unless the pattern has comments there. Backtracking
// stays inside one list; `pat/or` commits to the first alternative that fits. A
// repeated name must hold equal code, compared without variables or comments.
import { familyOf, type Family } from '../ast/family.ts'
import { attrsOf, Node, slotsOf, type Slot } from '../ast/node.ts'
import { accessor } from '../ast/slots.ts'
import type { Ctx } from '../ast/walk.ts'
import { isPat, type Test } from './pat.ts'

export type Captures = Record<string, any>

/**
 * Where the target sits, for the comments right before it in its list: a walk
 * `ctx`, or those comments themselves.
 */
export type MatchContext = Pick<Ctx, 'parent' | 'key' | 'index'> | { before: readonly Node[] }

const isDefault = (v: unknown) => v === undefined || v === null || v === false || (Array.isArray(v) && v.length === 0)

/** Two attribute values mean the same: equal, or both absent (undefined, null, false, []). */
const sameValue = (a: unknown, b: unknown) =>
  (isDefault(a) && isDefault(b)) || a === b || (typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b))

/** The attrs of `p` and `t` (of families `pf`, `tf`) mean the same; the families say which count. */
function sameAttrs(p: Node, t: Node, pf: Family, tf: Family): boolean {
  if (p.type === 'Comment') return sameComment(p, t)
  const equal = pf.equal[p.type] ?? tf.equal[t.type]
  if (equal) return equal(p, t)
  const pa = attrsOf(p)
  const ta = attrsOf(t)
  for (const key of new Set([...Object.keys(pa), ...Object.keys(ta)])) {
    // `comments` is checked on its own.
    if (key === 'comments' || pf.ignored.includes(key) || tf.ignored.includes(key)) continue
    const a = pa[key]
    const b = ta[key]
    if (isDefault(a) && isDefault(b)) continue
    if (a !== b && JSON.stringify(a) !== JSON.stringify(b)) return false
  }
  return true
}

// --- comments ---

const isComment = (n: Slot | undefined): n is Node => !!n && !Array.isArray(n) && (n.type === 'Comment' || n.type === 'pat/comment')
/** The `comments` attribute: the leading comments of a node outside a list. */
const lead = (n: Node | null): Node[] => (n?.comments as Node[] | undefined) ?? []
const text = (c: Node) => String(c.value).trim()
const isDoc = (c: Node) => c.kind === 'Block' && String(c.value).startsWith('*')
/** Same kind and trimmed text: `/*@__PURE__*\/` is `/* @__PURE__ *\/`. */
const sameComment = (a: Node, b: Node) => a.kind === b.kind && text(a) === text(b)

interface CommentVar {
  name: string
  seq: boolean
  doc: boolean
}

const commentVar = (c: Node): CommentVar | undefined =>
  c.type === 'pat/comment' ? { name: c.name as string, seq: !!c.seq, doc: !!c.doc } : undefined

function bindComments(v: CommentVar, value: Node | Node[], caps: Captures): boolean {
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
export function commentsBefore(ctx: MatchContext | object | undefined): Node[] {
  if (!ctx) return []
  if ('before' in ctx) return [...(ctx.before as readonly Node[])]
  const { parent, key, index } = ctx as Partial<Pick<Ctx, 'parent' | 'key' | 'index'>>
  if (!parent || key === null || key === undefined || index === null || index === undefined || key === 'comments') return []
  const list = parent.children[typeof key === 'number' ? key : (slotsOf(parent.type) ?? []).findIndex((s) => accessor(s) === key)]
  if (!Array.isArray(list)) return []
  let from = index
  while (from > 0 && isComment(list[from - 1])) from--
  return list.slice(from, index) as Node[]
}

interface Item {
  node: Node | null
  /** The comment siblings right before `node`. */
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

/** A `pat/group` standing in a list is its items there; its comments go in front of them. */
const splice = (list: (Node | null)[]): (Node | null)[] =>
  list.flatMap((n) => (n?.type === 'pat/group' ? [...lead(n), ...splice(asList(n.children[0]))] : [n]))

const asList = (s: unknown): (Node | null)[] => (Array.isArray(s) ? s : s === null || s === undefined ? [] : [s as Node])

const names = new WeakMap<Node, string[]>()

/** The names `p` captures, `p.not` excepted: inside a repetition they become arrays. */
function namesIn(p: Node): string[] {
  let out = names.get(p)
  if (out) return out
  const found = new Set<string>()
  const visit = (n: Node | null) => {
    if (!n) return
    lead(n).forEach(visit)
    if (n.type === 'pat/not') return
    if ((n.type === 'pat/bind' || n.type === 'pat/rep' || n.type === 'pat/comment') && typeof n.name === 'string' && n.name !== '_') found.add(n.name)
    for (const s of n.children) Array.isArray(s) ? s.forEach(visit) : visit(s)
  }
  visit(p)
  names.set(p, (out = [...found]))
  return out
}

type Done = (j: number, caps: Captures) => Captures | null

/** Keeps the captures of an attempt that matched (made on a copy). */
const keep = (caps: Captures, found: Captures) => (Object.assign(caps, found), true)

class Matcher {
  /** False when comparing two captures: there a `pat/` node is just a node, and comments don't matter. */
  readonly vars: boolean
  /** Given to guards. */
  readonly ctx: unknown
  constructor(vars: boolean, ctx?: unknown) {
    this.vars = vars
    this.ctx = ctx
  }

  /** Binds `name` (none or `_`: nothing) to `value`; a name bound before must hold equal code. */
  bind(name: unknown, value: unknown, caps: Captures): boolean {
    if (typeof name !== 'string' || name === '_') return true
    if (!(name in caps)) {
      caps[name] = value
      return true
    }
    return same(caps[name], value)
  }

  /**
   * `p` against `t`. `pFront` and `tFront` are the comment siblings right
   * before them in their lists (or, for `t` at the root, from the context).
   */
  node(p: Node | null, t: Node | null, caps: Captures, pFront: Node[] = [], tFront: Node[] = []): boolean {
    if (p && this.vars && isPat(p)) return this.pat(p, t, caps, pFront, tFront)
    if (!p || !t) return p === t && this.front(pFront, tFront, caps)
    const pf = familyOf(p.type)
    const tf = familyOf(t.type)
    // An expression pattern matches an expression statement: `f($$a)` matches `f(1)` alone.
    const inner = tf.unwrap(t)
    if (inner && !pf.isStatement(p.type)) return this.node(p, inner, caps, pFront, [...tFront, ...lead(t)])
    // Equivalent types (a function declaration and expression) match, across families too.
    if (pf.canon(p.type) !== tf.canon(t.type) || !sameAttrs(p, t, pf, tf)) return false
    if (!this.front([...pFront, ...lead(p)], [...tFront, ...lead(t)], caps)) return false
    return this.slots(p.children, t.children, caps)
  }

  /** Slot by slot: a list against a list, a node against a node. */
  slots(ps: Slot[], ts: Slot[], caps: Captures): boolean {
    const n = Math.max(ps.length, ts.length)
    for (let i = 0; i < n; i++) {
      const p = ps[i] ?? null
      const t = ts[i] ?? null
      if (Array.isArray(p) || Array.isArray(t)) {
        const found = this.list(asList(p), asList(t), caps)
        if (!found) return false
        Object.assign(caps, found)
      } else if (!this.node(p, t, caps)) return false
    }
    return true
  }

  /** A `pat/` node against `t`. Its own comments join the requirements in front of it. */
  pat(p: Node, t: Node | null, caps: Captures, pFront: Node[], tFront: Node[]): boolean {
    const need = [...pFront, ...lead(p)]
    const have = () => [...tFront, ...lead(t)]
    const of = (p.children[0] ?? null) as Node | null
    switch (p.type) {
      case 'pat/any':
        return !!t && this.front(need, have(), caps)
      case 'pat/bind':
        if (!t || !(of ? this.node(of, t, caps, need, tFront) : this.front(need, have(), caps))) return false
        return this.bind(p.name, t, caps)
      case 'pat/node':
        return !!t && this.fields(p, t, caps, need, tFront)
      case 'pat/or':
        for (const alt of asList(p.children[0])) {
          const next = { ...caps }
          if (this.node(alt, t, next, need, tFront)) return keep(caps, next)
        }
        return false
      case 'pat/not':
        return this.front(need, have(), caps) && !this.node(of, t, { ...caps }, [], tFront)
      case 'pat/guard': {
        const next = { ...caps }
        if (!this.node(of, t, next, need, tFront) || !(p.test as Test)(next, t, this.ctx)) return false
        return keep(caps, next)
      }
      case 'pat/rep':
      case 'pat/group': {
        // Outside a list: a list of the one node, or of none.
        const found = this.list([...pFront, p], asList(t), caps)
        return !!found && keep(caps, found)
      }
      case 'pat/value':
        return false // a node never equals a plain value
      case 'pat/comment':
        throw new TypeError('a pat/comment stands where a comment goes (in comments, or in a list), not where a node is matched')
      default:
        throw new TypeError(`${p.type} can't stand where a node is matched`)
    }
  }

  /** A `pat/node`: the kind, then each field by name, a slot of `t` or else an attribute. */
  fields(p: Node, t: Node, caps: Captures, need: Node[], tFront: Node[]): boolean {
    const kinds = p.kinds as string[] | undefined
    const tf = familyOf(t.type)
    const kind = !kinds || kinds.some((k) => familyOf(k).canon(k) === tf.canon(t.type))
    // A statement that only wraps an expression: if no kind takes the statement, the expression.
    const inner = kind ? undefined : tf.unwrap(t)
    if (inner) return this.fields(p, inner, caps, need, [...tFront, ...lead(t)])
    if (!kind) return false
    if (!this.front(need, [...tFront, ...lead(t)], caps)) return false
    const slots = slotsOf(t.type) ?? []
    for (const f of asList(p.children[0])) {
      if (!f) continue
      const name = f.name as string
      const pattern = (f.children[0] ?? null) as Slot
      const i = slots.findIndex((s) => accessor(s) === name)
      if (i >= 0) {
        if (!this.slots([pattern], [t.children[i] ?? null], caps)) return false
        continue
      }
      const value = name !== 'children' && Object.hasOwn(t, name) ? t[name] : undefined
      if (Array.isArray(pattern)) {
        const vs = Array.isArray(value) ? value : isDefault(value) ? [] : undefined
        if (!vs || vs.length !== pattern.length || !pattern.every((q, k) => this.attr(q, vs[k], caps))) return false
      } else if (!this.attr(pattern, value, caps)) return false
    }
    return true
  }

  /**
   * Pattern `q` against attribute value `v`: a string, a number, an object, a
   * node. An attribute the target doesn't have (undefined) is no value to take.
   */
  attr(q: Node | null, v: unknown, caps: Captures): boolean {
    if (v instanceof Node) return this.node(q, v, caps)
    if (!q) return isDefault(v)
    if (!this.vars || !isPat(q)) return false
    const of = (q.children[0] ?? null) as Node | null
    switch (q.type) {
      case 'pat/value':
        return sameValue(q.value, v)
      case 'pat/any':
        return v !== undefined
      case 'pat/bind':
        return v !== undefined && (!of || this.attr(of, v, caps)) && this.bind(q.name, v, caps)
      case 'pat/or':
        for (const alt of asList(q.children[0])) {
          const next = { ...caps }
          if (this.attr(alt, v, next)) return keep(caps, next)
        }
        return false
      case 'pat/not':
        return !this.attr(of, v, { ...caps })
      case 'pat/guard': {
        const next = { ...caps }
        if (!this.attr(of, v, next) || !(q.test as Test)(next, v, this.ctx)) return false
        return keep(caps, next)
      }
      default:
        return false
    }
  }

  /** Captures after matching list `ps` against list `ts` exactly, or null; backtracks over runs. */
  list(ps: (Node | null)[], ts: (Node | null)[], caps: Captures): Captures | null {
    const P = group(this.vars ? splice(ps) : ps)
    const T = group(ts)
    /** Where target item `k` starts in `ts`, its front comments included. */
    const at = (k: number) => (k < T.items.length ? T.items[k].start : T.end)

    /** Pattern items `items[i..]` from target item `j` on, then `done`. `last`: they end the pattern list. */
    const seq = (items: Item[], i: number, j: number, caps: Captures, done: Done, last: boolean): Captures | null => {
      if (i === items.length) return done(j, caps)
      const { node: p, front } = items[i]
      const then: Done = (k, next) => seq(items, i + 1, k, next, done, last)
      if (p && this.vars && p.type === 'pat/rep') return rep(p, front, j, caps, then, last && i === items.length - 1)
      if (j === T.items.length) return null
      const next = { ...caps }
      const t = T.items[j]
      return this.node(p, t.node, next, front, t.front) ? then(j + 1, next) : null
    }

    /** Run `p` from target item `j`: shortest first, then `done` at its end. */
    const rep = (p: Node, front: Node[], j: number, caps: Captures, done: Done, last: boolean): Captures | null => {
      const min = (p.min as number | undefined) ?? 0
      const max = (p.max as number | undefined) ?? Infinity
      const of = (p.children[0] ?? null) as Node | null
      const unit = of && group(splice([of]))
      const need = [...front, ...lead(p)]
      // Bound inside, so one entry per repetition; a name bound before is a back reference.
      const inner = of ? namesIn(of).filter((n) => !(n in caps)) : []
      /** The run ends before target item `k`, after `runs` (the captures of each repetition). */
      const stop = (k: number, runs: Captures[]): Captures | null => {
        const next = { ...caps }
        const first = j < k ? T.items[j] : undefined
        // Comments in front of the run are looked for in front of its first element.
        if (!this.front(need, first ? [...first.front, ...lead(first.node)] : [], next)) return null
        for (const name of inner) next[name] = runs.map((r) => r[name])
        // The last run takes the trailing comments, if the pattern has none there.
        const slice = ts.slice(at(j), k === T.items.length && last ? ts.length : at(k))
        return this.bind(p.name, slice, next) ? done(k, next) : null
      }
      if (!unit) {
        for (let k = j + min; k <= Math.min(T.items.length, j + max); k++) {
          const found = stop(k, [])
          if (found) return found
        }
        return null
      }
      const step = (n: number, k: number, runs: Captures[]): Captures | null => {
        const found = n >= min ? stop(k, runs) : null
        if (found || n >= max) return found
        // One more repetition, from the captures before the run; it must take something.
        return seq(unit.items, 0, k, { ...caps }, (e, c) => {
          if (e === k || !this.front(unit.trailing, e < T.items.length ? T.items[e].front : T.trailing, c)) return null
          return step(n + 1, e, [...runs, c])
        }, false)
      }
      return step(0, j, [])
    }

    const end: Done = (j, caps) => {
      if (j !== T.items.length) return null
      const next = { ...caps }
      return this.front(P.trailing, T.trailing, next) ? next : null
    }
    return seq(P.items, 0, 0, caps, end, !P.trailing.length)
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
      // A `seq` comment takes the gap up to where the next single one matches (or
      // the end); `seq` ones right after it get nothing.
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

const exact = new Matcher(false)

/** Two captures hold equal code (comments aside), or equal values. */
function same(a: unknown, b: unknown): boolean {
  const isNode = (v: unknown): v is Node => v instanceof Node
  if (Array.isArray(a) || Array.isArray(b)) {
    const as = asList(a)
    const bs = asList(b)
    const nodes = (l: unknown[]) => l.every((n) => n === null || isNode(n))
    if (nodes(as) && nodes(bs)) return exact.list(as, bs, {}) !== null
    return as.length === bs.length && as.every((x, i) => same(x, bs[i]))
  }
  if (isNode(a) && isNode(b)) return exact.node(a, b, {})
  return !isNode(a) && !isNode(b) && sameValue(a, b)
}

/**
 * The captures if `node` matches `pattern`, else null. A list of nodes matches a
 * list pattern. `ctx` (a walk ctx, or `{ before }`) gives the comments before
 * `node` in its list, for a pattern with comments in front; guards get it as is.
 */
export function matchPattern(node: Node | Node[], pattern: Node | Node[], ctx?: MatchContext | object): Captures | null {
  const m = new Matcher(true, ctx)
  if (Array.isArray(pattern) || Array.isArray(node)) return m.list(asList(pattern), asList(node), {})
  const caps: Captures = {}
  return m.node(pattern, node, caps, [], commentsBefore(ctx)) ? caps : null
}
