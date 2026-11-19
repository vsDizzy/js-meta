// walk(ast, visitor) -> new root. Visits every node in source order, comments
// included. Returning from a handler transforms the tree:
//   a node   -> replaces the current one
//   null     -> removes it (from a list; a single slot becomes null)
//   nothing  -> keeps it
// A replacement from `enter` is walked into (prewalk: its children are visited,
// it is not entered again); one from `leave` is final (postwalk). Unchanged
// subtrees are shared: if nothing changed, the result is `===` the input.
import { originOf, setOrigin } from './origin.ts'
import { ALIASES, accessor } from './slots.ts'
import { Node, slotsOf, toNode, withChildren, type Slot } from './node.ts'

export interface Ctx {
  /** Parent node in this walk; null at the root. */
  readonly parent: Node | null
  /** Slot name in the parent (`'left'`, `'body'`); a number for types without a slot table. */
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
 * takes the origin of the node it replaces (a macro expansion maps to its call).
 */
function answer(r: Result, replaced: Node): Node | null | undefined {
  if (r === undefined || r === null) return r as undefined | null
  const node = toNode(r)
  if (node !== replaced && !originOf(node)) {
    const origin = originOf(replaced)
    if (origin) setOrigin(node, origin)
  }
  return node
}

/** Ancestors as a linked chain: shared by siblings, valid after the walk too. */
interface Chain {
  node: Node
  up: Chain | null
}

export function walk(root: Node, visitor: Visitor): Node | null {
  const handlersFor = compile(visitor)

  function visit(node: Node, up: Chain | null, key: string | number | null, index: number | null, list: Slot[] | null): Node | null {
    let skipped = false
    const ctx: Ctx = {
      parent: up?.node ?? null,
      key,
      index,
      prev: list && index! > 0 ? ((list[index! - 1] as Node | null) ?? null) : null,
      next: list && index! < list.length - 1 ? ((list[index! + 1] as Node | null) ?? null) : null,
      get ancestors() {
        const out: Node[] = []
        for (let c = up; c; c = c.up) out.unshift(c.node)
        return out
      },
      skip() {
        skipped = true
      },
    }

    for (const enter of handlersFor(node.type).enter) {
      const r = answer(enter(node, ctx), node)
      if (r === null) return null
      if (r !== undefined) {
        node = r
        break
      }
    }

    if (!skipped) node = visitChildren(node, up)

    for (const leave of handlersFor(node.type).leave) {
      const r = answer(leave(node, ctx), node)
      if (r === null) return null
      if (r !== undefined) node = r
    }
    return node
  }

  function visitChildren(node: Node, up: Chain | null): Node {
    const slots = slotsOf(node.type)
    const here: Chain = { node, up }
    let changed = false
    const children = node.children.map((slot, i) => {
      const key = slots ? accessor(slots[i]) : i
      if (slot === null || slot === undefined) return null
      if (!Array.isArray(slot)) {
        const out = visit(slot, here, key, null, null)
        if (out !== slot) changed = true
        return out
      }
      const out: (Node | null)[] = []
      slot.forEach((el, j) => {
        if (el === null) return void out.push(null)
        const v = visit(el, here, key, j, slot)
        if (v !== el) changed = true
        if (v !== null) out.push(v)
      })
      return out
    })
    return changed ? withChildren(node, children) : node
  }

  return visit(toNode(root), null, null, null, null)
}
