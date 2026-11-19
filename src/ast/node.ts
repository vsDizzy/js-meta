// Nodes: `{ type, ...attrs, children }`, one class per type. The class adds named
// accessors over the positional slots (`node.left` is `node.children[0]` of a
// BinaryExpression), so the data stays ordered and the code stays readable.
// Values are immutable outside `edit()` (edit.ts): setters only work on drafts.
import { originOf, setOrigin } from './origin.ts'
import { accessor, SLOTS } from './slots.ts'

/** What a slot holds: a node, nothing, or a list (with `null` holes, as in `[a, , b]`). */
export type Slot = Node | null | (Node | null)[]

export class Node {
  declare type: string
  declare children: Slot[]
  [key: string]: unknown
}

/** Edit-session hooks, installed by edit.ts while `edit()` runs. */
export interface Session {
  /** Slot `i` of `node` if `node` is a draft of this session, else undefined. */
  read(node: Node, i: number): Slot | undefined
  /** Writes slot `i` if `node` is a draft of this session; false otherwise. */
  write(node: Node, i: number, value: Slot): boolean
}
export const editing: { session: Session | null } = { session: null }

const classes = new Map<string, typeof Node>()

/** ESTree slot names of `type`; undefined for a type the table doesn't know. */
export const slotsOf = (type: string): readonly string[] | undefined => SLOTS[type]

/** Registers a new node type (a macro form, say) with its slots in source order. */
export function define(type: string, slots: readonly string[]) {
  if (SLOTS[type]) throw new Error(`node type "${type}" is already defined`)
  SLOTS[type] = slots
}

function classFor(type: string): typeof Node {
  let cls = classes.get(type)
  if (cls) return cls
  cls = class extends Node {}
  Object.defineProperty(cls, 'name', { value: type })
  ;(slotsOf(type) ?? []).forEach((slot, i) => {
    Object.defineProperty(cls.prototype, accessor(slot), {
      get(this: Node) {
        const fromDraft = editing.session?.read(this, i)
        return fromDraft !== undefined ? fromDraft : (this.children[i] ?? null)
      },
      set(this: Node, value: unknown) {
        if (editing.session?.write(this, i, toSlot(value))) return
        throw new Error(`${type}.${accessor(slot)}: nodes are immutable, change them inside edit(ast, draft => { ... })`)
      },
    })
  })
  classes.set(type, cls)
  return cls
}

/** A node from its parts. Own keys in the order type, attrs, children. */
export function make(type: string, attrs: Record<string, unknown>, children: Slot[]): Node {
  const node = new (classFor(type))()
  node.type = type
  Object.assign(node, attrs)
  node.children = children
  return node
}

/** Same type and attrs, new children; keeps the origin. */
export function withChildren(node: Node, children: Slot[]): Node {
  const out = make(node.type, attrsOf(node), children)
  const origin = originOf(node)
  if (origin) setOrigin(out, origin)
  return out
}

export function attrsOf(node: object): Record<string, unknown> {
  const attrs: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node)) if (k !== 'type' && k !== 'children') attrs[k] = v
  return attrs
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object'
const looksLikeNode = (v: unknown): v is Record<string, unknown> & { type: string } =>
  isObject(v) && typeof v.type === 'string'
const holdsNodes = (v: unknown) => looksLikeNode(v) || (Array.isArray(v) && v.some(looksLikeNode))

/** Positions from other parsers (acorn, babel); never attributes. */
const POSITION_KEYS = new Set(['range', 'loc', 'start', 'end', 'parent'])

function toSlot(value: unknown): Slot {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return value.map((v) => (v === null || v === undefined ? null : toNode(v)))
  return toNode(value)
}

/**
 * A node from any of the three shapes: a Node (returned as is), our plain form
 * `{ type, ...attrs, children }`, or an ESTree object `{ type, left, right, ... }`.
 */
export function toNode(value: unknown): Node {
  if (value instanceof Node) return value
  if (!looksLikeNode(value)) throw new TypeError(`not a node: ${JSON.stringify(value)}`)
  const { type } = value
  const slots = slotsOf(type)
  const esKeys = slots?.filter((s) => s !== 'children') ?? []
  const ours = Array.isArray(value.children) && !esKeys.some((k) => k in value)

  if (ours) {
    const children = (value.children as unknown[]).map(toSlot)
    if (slots) {
      if (children.length > slots.length) throw new TypeError(`${type}: ${children.length} children, ${slots.length} slots`)
      while (children.length < slots.length) children.push(null)
    }
    return make(type, attrsOf(value), children)
  }

  const attrs: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (k === 'type' || POSITION_KEYS.has(k) || slots?.includes(k)) continue
    if (holdsNodes(v)) {
      throw new TypeError(slots ? `${type}.${k}: holds nodes but is not a slot` : `unknown node type "${type}" with child "${k}": use define() or { type, children }`)
    }
    attrs[k] = v
  }
  return make(type, attrs, (slots ?? []).map((s) => toSlot(value[s])))
}

/** Plain ESTree objects (named fields, no classes): for tools that speak ESTree. */
export function toEstree(node: Node): Record<string, unknown> {
  const out: Record<string, unknown> = { type: node.type, ...attrsOf(node) }
  const conv = (s: Slot): unknown => (Array.isArray(s) ? s.map(conv) : s === null ? null : toEstree(s))
  const slots = slotsOf(node.type)
  if (!slots) out.children = node.children.map(conv)
  else slots.forEach((slot, i) => (out[slot] = conv(node.children[i] ?? null)))
  return out
}

/**
 * Builders: `b.BinaryExpression({ operator: '+', left, right })`. Fields by
 * ESTree name; children may be nodes, ESTree objects or plain-form objects.
 */
export const b: Record<string, (fields?: Record<string, unknown>) => Node> = new Proxy(
  {},
  { get: (_, type) => (typeof type === 'string' ? (fields = {}) => toNode({ ...fields, type }) : undefined) },
)
