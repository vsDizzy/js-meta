// edit(ast, draft => { ... }): write mutations, get a new value back. Like a
// Clojure transient (or Immer): the draft takes JS assignments, the result is an
// immutable tree in which everything untouched is still `===` the original.
//
// Drafts are shallow copies made lazily as the code walks down through named
// accessors (`draft.body[0].left`): reading a slot of a draft drafts the child,
// reading a list slot drafts the list and its elements. At the end every draft
// that ends up equal to its original (same attrs, same children by identity) is
// replaced by the original, so only changed paths are new.
import { originOf, setOrigin } from './origin.ts'
import { attrsOf, editing, make, Node, toNode, type Session, type Slot } from './node.ts'

class Drafts implements Session {
  /** draft -> the node it was copied from */
  originals = new Map<Node, Node>()
  /** List arrays that belong to a draft (already copied, elements drafted). */
  owned = new WeakSet<unknown[]>()

  draft(node: Node): Node {
    // Lists are copied too, so raw `draft.children[i].push(x)` can't touch the original.
    const copy = make(node.type, attrsOf(node), node.children.map((s) => (Array.isArray(s) ? [...s] : s)))
    const origin = originOf(node)
    if (origin) setOrigin(copy, origin)
    this.originals.set(copy, node)
    return copy
  }

  read(node: Node, i: number): Slot | undefined {
    if (!this.originals.has(node)) return undefined
    const value = node.children[i] ?? null
    if (Array.isArray(value)) {
      if (this.owned.has(value)) return value
      const list = value.map((v) => (v === null || this.originals.has(v) ? v : this.draft(v)))
      this.owned.add(list)
      return (node.children[i] = list)
    }
    if (value === null || this.originals.has(value)) return value
    return (node.children[i] = this.draft(value))
  }

  write(node: Node, i: number, value: Slot): boolean {
    if (!this.originals.has(node)) return false
    if (Array.isArray(value)) this.owned.add(value)
    node.children[i] = value
    return true
  }

  /** The final node for `node`: the original if nothing changed. */
  finish(node: Node, done = new Map<Node, Node>()): Node {
    const original = this.originals.get(node)
    if (!original) return node
    const cached = done.get(node)
    if (cached) return cached

    const slot = (s: unknown): Slot => {
      if (s === null || s === undefined) return null
      if (Array.isArray(s)) return s.map((v) => (v === null || v === undefined ? null : this.finish(toNode(v), done)))
      return this.finish(toNode(s), done)
    }
    const children = node.children.map(slot)
    const same = sameAttrs(node, original) && sameChildren(children, original.children)
    const result = same ? original : node
    if (!same) node.children = children
    done.set(node, result)
    return result
  }
}

function sameAttrs(a: Node, b: Node) {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((k) => k === 'children' || (k in b && Object.is(a[k], b[k])))
}

function sameChildren(a: Slot[], b: Slot[]) {
  if (a.length !== b.length) return false
  return a.every((x, i) => {
    const y = b[i] ?? null
    if (!Array.isArray(x) || !Array.isArray(y)) return x === y
    return x.length === y.length && x.every((v, j) => v === y[j])
  })
}

/**
 * Runs `fn` on a draft of `node` and returns the new node: what `fn` returns,
 * or the draft. Unchanged subtrees are shared with `node`.
 */
export function edit<T extends Node>(node: T, fn: (draft: T) => unknown): T {
  const drafts = new Drafts()
  const outer = editing.session
  editing.session = drafts
  try {
    const root = drafts.draft(toNode(node))
    const returned = fn(root as T)
    return drafts.finish(returned === undefined ? root : toNode(returned)) as T
  } finally {
    editing.session = outer
  }
}
