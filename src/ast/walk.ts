// walk(ast, visitor) -> new root. Visits every node in source order, comments
// included: a node's leading comments (its `comments` attribute) come right
// after its `enter`, before its children, with `key: 'comments'`. Returning from
// a handler transforms the tree:
//   a node   -> replaces the current one
//   null     -> removes it (from a list; a single slot becomes null)
//   nothing  -> keeps it
// A replacement from `enter` is walked into (prewalk: its children are visited,
// it is not entered again); one from `leave` is final (postwalk). Unchanged
// subtrees are shared: if nothing changed, the result is `===` the input.
// A replacement keeps what the replaced node had and it lacks: the origin (a
// macro expansion maps to its call site) and the leading comments (`x = /* why */
// add(1, 2)` -> `x = /* why */ 1 + 2`). The comments go on a copy, so a shared
// node (a capture put in two places) never changes; not if the replacement
// already holds them (it wraps the replaced node), and not on removal.
//
// A handler can also walk a child first (`ctx.expand`), as a macro that needs
// its arguments expanded before deciding; what it gets back is done for this
// walk, and the walk passes over it when it gets there. Values go up from inside
// such an expansion with `ctx.send` to a `ctx.receive` around it.
import { familyOf } from './family.ts'
import { originOf, setOrigin } from './origin.ts'
import { freshName, scope, type ScopeInfo } from './scope.ts'
import { ALIASES, accessor } from './slots.ts'
import { Node, slotsOf, toNode, withChildren, type Slot } from './node.ts'

export interface Ctx {
  /** Parent node in this walk; null at the root. */
  readonly parent: Node | null
  /**
   * Slot name in the parent (`'left'`, `'body'`); a number for types without a
   * slot table; `'comments'` for a leading comment of the parent.
   */
  readonly key: string | number | null
  /** Position in the list, if the node sits in a list. */
  readonly index: number | null
  /** Siblings in the list (comments too); null at the ends or outside lists. */
  readonly prev: Node | null
  readonly next: Node | null
  /** From the root down to the parent. */
  readonly ancestors: Node[]
  /** Don't visit the children of this node (its `leave` still runs). */
  skip(): void
  /**
   * `scope()` of the tree this walk started with, computed on first use. A
   * snapshot: nodes made during the walk (by templates) are not in it, while
   * nodes moved into a replacement (captures) are, as they were.
   */
  readonly scope: ScopeInfo
  /**
   * A name for something new (a temporary, a helper): `base`, or `base_1`, ...,
   * the first that is not in `ctx.scope.names` and was not given out by
   * `ctx.freshName` before in this walk (the snapshot doesn't see those).
   */
  freshName(base: string): string
  /**
   * Where the node stands, from its parent's family: 'statement' (a statement
   * goes there, or its value is discarded: `f(x)` alone), 'expression' (its
   * value is used), null (a binding, a type, a key, ...; the root).
   */
  readonly position: 'statement' | 'expression' | null
  /** The node's value is what its function returns: `return x`, `() => x`, `return a ? x : y`. */
  readonly tail: boolean
  /** The value given to `walk(…, { env })`, or to the nearest `ctx.expand(…, env)` above. */
  readonly env: any
  /**
   * Walks `node` with this walk's visitor as if it stood here (same parent, key
   * and index) and returns the result. Done for this walk: when the walk reaches
   * that node later (in a replacement, say), it passes over it as it is.
   * `env`: a new `ctx.env` for it and below.
   */
  expand(node: Node, env?: unknown): Node | null
  /** Sends `value` with `tag` to the innermost `ctx.receive(tag, …)` running; false if there is none. */
  send(tag: unknown, value?: unknown): boolean
  /** Runs `fn` and returns its result with the values sent with `tag` while it ran (from expansions inside it). */
  receive<T>(tag: unknown, fn: () => T): [T, any[]]
}

export interface WalkOptions {
  /** `ctx.env` for every node (until a `ctx.expand(node, env)` gives another). */
  env?: unknown
}

type Result = Node | null | undefined | void | object
export type Handler = (node: Node, ctx: Ctx) => Result
export type Entry = Handler | { enter?: Handler; leave?: Handler }
export type Visitor = Handler | ({ enter?: Handler; leave?: Handler } & { [type: string]: Entry | undefined })

interface Handlers {
  enter: Handler[]
  leave: Handler[]
}

function compile(visitor: Visitor): (type: string) => Handlers {
  if (typeof visitor === 'function') {
    const all: Handlers = { enter: [visitor], leave: [] }
    return () => all
  }
  const generic = { enter: visitor.enter, leave: visitor.leave }
  const groups = Object.entries(ALIASES).filter(([alias]) => visitor[alias])
  const cache = new Map<string, Handlers>()
  const add = (h: Handlers, entry: Entry | undefined) => {
    if (!entry) return
    if (typeof entry === 'function') h.enter.push(entry)
    else {
      if (entry.enter) h.enter.push(entry.enter)
      if (entry.leave) h.leave.unshift(entry.leave)
    }
  }
  return (type) => {
    let h = cache.get(type)
    if (h) return h
    h = { enter: [], leave: [] }
    // enter: generic, groups, type; leave in the reverse order.
    add(h, generic)
    for (const [alias, types] of groups) if (types.includes(type)) add(h, visitor[alias])
    if (type !== 'enter' && type !== 'leave') add(h, visitor[type])
    cache.set(type, h)
    return h
  }
}

/**
 * A handler's answer: undefined keeps the node. A replacement without an origin
 * takes the origin of the node it replaces; one without a `comments` attribute
 * takes its leading comments, on a copy (the returned node may be shared). A
 * copy of a node that is done is done too.
 */
function answer(r: Result, replaced: Node, done: WeakSet<Node>): Node | null | undefined {
  if (r === undefined || r === null) return r as undefined | null
  let node = toNode(r)
  if (node === replaced) return node
  const comments = replaced.comments
  if (Array.isArray(comments) && comments.length && node.comments === undefined && !holds(node, comments)) {
    const finished = done.has(node)
    node = withChildren(node, node.children) // keeps the origin, if any
    node.comments = comments
    if (finished) done.add(node)
  }
  if (!originOf(node)) {
    const origin = originOf(replaced)
    if (origin) setOrigin(node, origin)
  }
  return node
}

/** `node` or a node inside it already has one of `comments`: it wraps the replaced node. */
function holds(node: Node, comments: Node[]): boolean {
  if (comments.includes(node)) return true
  if (Array.isArray(node.comments) && node.comments.some((c) => comments.includes(c))) return true
  return node.children.some((slot) =>
    Array.isArray(slot) ? slot.some((el) => el !== null && holds(el, comments)) : slot !== null && slot !== undefined && holds(slot, comments),
  )
}

/** Ancestors as a linked chain: shared by siblings, valid after the walk too. */
interface Chain {
  node: Node
  /** The node's own ctx. */
  ctx: Context
  up: Chain | null
}

/** What every ctx of one walk shares. */
interface Walk {
  /** The tree the walk started with, for `ctx.scope`. */
  root: Node
  info?: ScopeInfo
  /** The tree's names and those `ctx.freshName` gave out; made on first use. */
  taken?: Set<string>
  /** Results of `ctx.expand`: passed over as they are. */
  done: WeakSet<Node>
  /** Per tag, the values of each `ctx.receive` running, innermost last. */
  receivers: Map<unknown, unknown[][]>
  visit(node: Node, up: Chain | null, key: string | number | null, index: number | null, list: Slot[] | null, env: unknown): Node | null
}

class Context implements Ctx {
  readonly parent: Node | null
  readonly key: string | number | null
  readonly index: number | null
  readonly prev: Node | null
  readonly next: Node | null
  readonly env: any
  readonly #walk: Walk
  readonly #up: Chain | null
  readonly #list: Slot[] | null
  #skipped = false
  #tail: boolean | undefined

  constructor(walk: Walk, up: Chain | null, key: string | number | null, index: number | null, list: Slot[] | null, env: unknown) {
    this.parent = up?.node ?? null
    this.key = key
    this.index = index
    this.prev = list && index! > 0 ? ((list[index! - 1] as Node | null) ?? null) : null
    this.next = list && index! < list.length - 1 ? ((list[index! + 1] as Node | null) ?? null) : null
    this.env = env
    this.#walk = walk
    this.#up = up
    this.#list = list
  }

  static skipped(ctx: Context) {
    return ctx.#skipped
  }

  get ancestors() {
    const out: Node[] = []
    for (let c = this.#up; c; c = c.up) out.unshift(c.node)
    return out
  }

  skip() {
    this.#skipped = true
  }

  get scope() {
    return (this.#walk.info ??= scope(this.#walk.root))
  }

  freshName(base: string): string {
    const taken = (this.#walk.taken ??= new Set(this.scope.names))
    const name = freshName(base, taken)
    taken.add(name)
    return name
  }

  get position(): 'statement' | 'expression' | null {
    const up = this.#up
    if (!up || this.key === null) return null
    return familyOf(up.node.type).position(up.node, this.key, this.index, up.ctx) ?? null
  }

  get tail(): boolean {
    if (this.#tail === undefined) {
      const up = this.#up
      const t = up && this.key !== null ? familyOf(up.node.type).tail(up.node, this.key, this.index) : undefined
      this.#tail = t === 'return' || (t === 'pass' && up!.ctx.tail)
    }
    return this.#tail
  }

  expand(node: Node, env?: unknown): Node | null {
    const w = this.#walk
    const out = w.visit(toNode(node), this.#up, this.key, this.index, this.#list, env === undefined ? this.env : env)
    if (out) w.done.add(out)
    return out
  }

  send(tag: unknown, value?: unknown): boolean {
    const stack = this.#walk.receivers.get(tag)
    if (!stack?.length) return false
    stack[stack.length - 1].push(value)
    return true
  }

  receive<T>(tag: unknown, fn: () => T): [T, any[]] {
    const receivers = this.#walk.receivers
    let stack = receivers.get(tag)
    if (!stack) receivers.set(tag, (stack = []))
    const values: unknown[] = []
    stack.push(values)
    try {
      return [fn(), values]
    } finally {
      stack.pop()
    }
  }
}

export function walk(root: Node, visitor: Visitor, options: WalkOptions = {}): Node | null {
  const handlersFor = compile(visitor)
  const start = toNode(root)
  const state: Walk = { root: start, done: new WeakSet(), receivers: new Map(), visit }

  function visit(node: Node, up: Chain | null, key: string | number | null, index: number | null, list: Slot[] | null, env: unknown): Node | null {
    if (state.done.has(node)) return node
    const ctx = new Context(state, up, key, index, list, env)

    for (const enter of handlersFor(node.type).enter) {
      const r = answer(enter(node, ctx), node, state.done)
      if (r === null) return null
      if (r !== undefined) {
        node = r
        break
      }
    }
    // Expanded already (`ctx.expand` here): final as it is.
    if (state.done.has(node)) return node

    if (!Context.skipped(ctx)) node = visitChildren(node, up, ctx, env)

    for (const leave of handlersFor(node.type).leave) {
      const r = answer(leave(node, ctx), node, state.done)
      if (r === null) return null
      if (r !== undefined) node = r
    }
    return node
  }

  /** The leading comments of `node`, walked; the same array if none changed. */
  function visitComments(node: Node, here: Chain, env: unknown): Node[] | undefined {
    const list = node.comments
    if (!Array.isArray(list) || !list.length) return undefined
    let changed = false
    const out: Node[] = []
    list.forEach((c: Node, j) => {
      const v = visit(c, here, 'comments', j, list, env)
      if (v !== c) changed = true
      if (v !== null) out.push(v)
    })
    return changed ? out : list
  }

  function visitChildren(node: Node, up: Chain | null, ctx: Context, env: unknown): Node {
    const slots = slotsOf(node.type)
    const here: Chain = { node, ctx, up }
    const comments = visitComments(node, here, env)
    let changed = comments !== undefined && comments !== node.comments
    const children = node.children.map((slot, i) => {
      const key = slots ? accessor(slots[i]) : i
      if (slot === null || slot === undefined) return null
      if (!Array.isArray(slot)) {
        const out = visit(slot, here, key, null, null, env)
        if (out !== slot) changed = true
        return out
      }
      const out: (Node | null)[] = []
      slot.forEach((el, j) => {
        if (el === null) return void out.push(null)
        const v = visit(el, here, key, j, slot, env)
        if (v !== el) changed = true
        if (v !== null) out.push(v)
      })
      return out
    })
    if (!changed) return node
    const out = withChildren(node, children)
    // Emptied: no attr at all, as `read` would give.
    if (comments?.length) out.comments = comments
    else delete out.comments
    return out
  }

  return visit(start, null, null, null, null, options.env)
}
