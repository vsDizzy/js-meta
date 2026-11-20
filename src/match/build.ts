// build(template, captures): the other half of matchPattern. The template is a
// tree in which `pat/bind` stands for its capture and a named `pat/rep` for its
// run, spliced into the list it stands in; a `pat/comment` (in `comments`, or a
// list sibling) puts the captured comments. Nothing is converted: a capture goes
// in as it is, the same node, so it keeps its origin (a bind with comments of
// its own puts them on a copy). Untouched subtrees are shared.
import { Node, withChildren, type Slot } from '../ast/node.ts'
import type { Captures } from './match.ts'

const lead = (n: Node): Node[] => (n.comments as Node[] | undefined) ?? []

/** `node` with `comments` in front of its own, on a copy that keeps the origin. */
function withLead(node: Node, comments: Node[]): Node {
  if (!comments.length) return node
  const out = withChildren(node, node.children)
  out.comments = [...comments, ...lead(node).filter((c) => !comments.includes(c))]
  return out
}

export function build(template: Node, captures: Captures): Node
export function build(template: Node[], captures: Captures): Node[]
export function build(template: Node | Node[], captures: Captures): Node | Node[]
export function build(template: Node | Node[], captures: Captures): Node | Node[] {
  return buildAround(template, captures)
}

/**
 * Internal, for `rule`: `build`, passing over the nodes in `placed` as they are.
 * They are captures `substitute` put in first, which may hold `pat/` nodes of
 * their own (code about patterns): those are code, not holes.
 */
export function buildAround(template: Node | Node[], captures: Captures, placed?: ReadonlySet<Node>): Node | Node[] {
  const get = (p: Node) => {
    const name = p.name
    if (typeof name !== 'string' || name === '_') throw new TypeError(`build: a ${p.type} without a name has nothing to put in`)
    if (!(name in captures)) throw new TypeError(`build: "${name}" is not captured`)
    return captures[name]
  }

  /** What a `pat/comment` puts: the captured Comment, or the captured ones. */
  const comments = (p: Node): Node[] => {
    const value = get(p)
    const list = Array.isArray(value) ? value : [value]
    if (list.every((c) => c instanceof Node && c.type === 'Comment')) return list
    throw new TypeError(`build: "${p.name}" stands for comments, but it is not a Comment node or a list of them`)
  }

  /** A list with its runs spliced in; the same array if nothing changed. */
  const list = (items: (Node | null)[]): (Node | null)[] => {
    let changed = false
    const out: (Node | null)[] = []
    for (const el of items) {
      const v = !el || placed?.has(el) ? el : el.type === 'pat/comment' ? comments(el) : visit(el)
      if (v !== el) changed = true
      if (Array.isArray(v)) out.push(...v)
      else out.push(v)
    }
    return changed ? out : items
  }

  /** What node `n` builds to: a node, or the nodes of a run. */
  const visit = (n: Node): Node | (Node | null)[] => {
    if (placed?.has(n)) return n
    if (n.type === 'pat/bind') {
      const value = get(n)
      if (value instanceof Node) return withLead(value, list(lead(n)) as Node[])
      const what = Array.isArray(value) ? 'a list: splice it with p.rest' : `${value === null ? 'null' : `a ${typeof value}`}, not a node`
      throw new TypeError(`build: "${n.name}" is ${what}`)
    }
    if (n.type === 'pat/rep') {
      const value = get(n)
      if (Array.isArray(value) && value.every((x) => x === null || x instanceof Node)) return value
      throw new TypeError(`build: "${n.name}" is not a run (a list of nodes)`)
    }
    if (n.type.startsWith('pat/')) throw new TypeError(`build: a ${n.type} can't be built, only pat/bind, pat/rep and pat/comment`)
    const before = lead(n)
    const after = before.some((c) => c.type === 'pat/comment') ? (list(before) as Node[]) : before
    let changed = after !== before
    const children = n.children.map((slot): Slot => {
      if (Array.isArray(slot)) {
        const out = list(slot)
        if (out !== slot) changed = true
        return out
      }
      if (!slot) return slot
      const out = visit(slot)
      if (Array.isArray(out)) throw new TypeError(`build: run "${slot.name}" stands where a single node goes`)
      if (out !== slot) changed = true
      return out
    })
    if (!changed) return n
    const out = withChildren(n, children)
    if (after.length) out.comments = after
    else delete out.comments
    return out
  }

  if (Array.isArray(template)) return list(template) as Node[]
  const out = visit(template)
  // A run is spliced into a list; a single template has none around it.
  if (Array.isArray(out)) throw new TypeError(`build: run "${template.name}" stands where a single node goes`)
  return out
}
