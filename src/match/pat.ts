// Pattern nodes: the `pat/` family. A pattern is an ordinary tree of nodes in
// which these may stand; any other node in it is a literal (match.ts). They are
// real nodes, with slots, so `walk` goes through a pattern like through code.
//
//   builder                     type          attrs                    slots
//   p.bind(name, of?)           pat/bind      name                     of
//   p.any()                     pat/any
//   p.node(kind?, fields?)      pat/node      kinds?                   fields: pat/field[]
//                               pat/field     name                     pattern: node, list or null
//   p.rest(name?, of?)          pat/rep       name?, min, max?         of
//   p.rep(of, { min, max, name })  p.opt(of)
//   p.group(...items)           pat/group                              items
//   p.or(...alts)               pat/or                                 alts
//   p.not(of)                   pat/not                                of
//   p.guard(of, test)           pat/guard     test                     of
//   p.comment(name, opts?)      pat/comment   name, seq, doc
//   'a', 1, true (in fields, p.or, ...)  pat/value  value
//
// Where a pattern applies to an attribute value (a field that is not a slot),
// a primitive stands for itself: `p.node('BinaryExpression', { operator: p.or('+', '-') })`.
import { defineFamily } from '../ast/family.ts'
import { define, make, Node, toNode } from '../ast/node.ts'
import { ALIASES } from '../ast/slots.ts'

defineFamily('pat', {})
define('pat/bind', ['of'])
define('pat/any', [])
define('pat/node', ['fields'])
define('pat/field', ['pattern'])
define('pat/rep', ['of'])
define('pat/group', ['items'])
define('pat/or', ['alts'])
define('pat/not', ['of'])
define('pat/guard', ['of'])
define('pat/comment', [])
define('pat/value', [])

export const isPat = (n: Node) => n.type.startsWith('pat/')

/** A guard's condition: the captures so far, the node (or attribute value) matched, the matcher's ctx. */
export type Test = (captures: Record<string, any>, value: any, ctx: any) => unknown

const looksLikeNode = (v: unknown) => typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string'

/** A pattern from what a builder was given: a node as is, null or undefined as null, anything else a `pat/value`. */
function pattern(x: unknown): Node | null {
  if (x === null || x === undefined) return null
  if (x instanceof Node || looksLikeNode(x)) return toNode(x)
  return make('pat/value', { value: x }, [])
}

/** A type name, a list of them, or a group name (`Function`), as the list of types. */
function kindsOf(kind: string | readonly string[]): string[] {
  return (typeof kind === 'string' ? [kind] : [...kind]).flatMap((k) => ALIASES[k] ?? [k])
}

export interface RepOptions {
  /** Fewest repetitions (0). */
  min?: number
  /** Most repetitions (no limit). */
  max?: number
  /** Captures the run, the slice of the target list, as `p.rest(name)` does. */
  name?: string
}

function rep(of: unknown, { min = 0, max, name }: RepOptions): Node {
  if (!(min >= 0) || (max !== undefined && !(max >= min))) throw new TypeError(`p.rep: min ${min}, max ${max}`)
  const attrs: Record<string, unknown> = { min }
  if (name !== undefined) attrs.name = name
  if (max !== undefined && max !== Infinity) attrs.max = max
  return make('pat/rep', attrs, [pattern(of)])
}

/** Pattern builders. Each returns a Node. */
export const p = {
  /** Any node, captured as `name`; with `of`, only a node `of` matches. `_` captures nothing. */
  bind: (name: string, of?: unknown): Node => make('pat/bind', { name }, [pattern(of)]),

  /** Any node, not captured. */
  any: (): Node => make('pat/any', {}, []),

  /**
   * A node of one of the kinds (a type, a list of types, or a group such as
   * `Function`; any kind if omitted) whose named fields match; the rest don't
   * matter. A field that is a slot of the target takes a pattern, an array for a
   * list (`p.rest()` for its tail), or null for an empty slot. Any other field is
   * an attribute: a value it must equal, or a pattern applied to its value
   * (`{ operator: p.bind('op') }` captures the string).
   */
  node(kind?: string | readonly string[] | null, fields: Record<string, unknown> = {}): Node {
    const list = Object.entries(fields).map(([name, v]) =>
      make('pat/field', { name }, [Array.isArray(v) ? v.map(pattern) : pattern(v)]),
    )
    return make('pat/node', kind === undefined || kind === null ? {} : { kinds: kindsOf(kind) }, [list])
  },

  /** A run of list elements, shortest first (`$$a`); with `of`, each element matches it. */
  rest: (name?: string, of?: unknown): Node => rep(of, { name }),

  /** `of` (an element pattern or a `p.group`) repeated; what it captures becomes arrays, one entry per repetition. */
  rep: (of: unknown, options: RepOptions = {}): Node => rep(of, options),

  /** `of` or nothing. */
  opt: (of: unknown): Node => rep(of, { min: 0, max: 1 }),

  /** Several consecutive list elements as one unit, for `p.rep`. */
  group: (...items: unknown[]): Node => make('pat/group', {}, [items.map(pattern)]),

  /** The first alternative that matches; captures come from it. No going back to the others later. */
  or: (...alts: unknown[]): Node => make('pat/or', {}, [alts.map(pattern)]),

  /** Matches where `of` doesn't; captures nothing. */
  not: (of: unknown): Node => make('pat/not', {}, [pattern(of)]),

  /** `of` matches and `test(captures, node, ctx)` is truthy; `ctx` is the one given to the matcher. */
  guard: (of: unknown, test: Test): Node => make('pat/guard', { test }, [pattern(of)]),

  /**
   * A comment variable, where a comment stands (in a node's `comments`, or a
   * list sibling): any one comment, all of them with `seq` (an array), JSDoc
   * only with `doc`. `_` captures nothing.
   */
  comment: (name: string, { seq = false, doc = false }: { seq?: boolean; doc?: boolean } = {}): Node =>
    make('pat/comment', { name, seq, doc }, []),
}
