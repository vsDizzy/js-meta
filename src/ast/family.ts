// Node families: what `match`, `rules` and `walk` need to know about the nodes
// of one language. The family of a node type is its prefix, the text before the
// first `/` (`lua/CallExpression` -> `lua`, `clj/list` -> `clj`); a type with no
// `/` is ESTree. Prefixes keep type names apart: Lua's `CallExpression` is not
// ESTree's. `Comment` is one type shared by all families; `walk` and `match` know it.
import * as estree from './estree.ts'
import type { Node } from './node.ts'
import type { Ctx } from './walk.ts'

/** The node that names a form, and its name: the callee of `f(x)`, the symbol in `(when ...)`. */
export interface Head {
  node: Node
  name: string
}

export interface FamilySpec {
  /** Attributes that don't change what the code means (`raw`). `match` checks `comments` apart. */
  ignored?: readonly string[]
  /** Per node type, the comparison of two atoms, instead of comparing all their attributes. */
  equal?: Readonly<Record<string, (a: Node, b: Node) => boolean>>
  /** One name for the types that match each other (a function declaration and expression). */
  canon?: (type: string) => string
  /** The expression `node` holds, if it is a statement that only wraps one. */
  unwrap?: (node: Node) => Node | undefined
  isStatement?: (type: string) => boolean
  /**
   * The head of form `node`, when it is a plain name. `rules` files a rule under
   * the head of its pattern, so two nodes that match must have the same head name.
   */
  head?: (node: Node) => Head | undefined
  /** What head `head` refers to through its binding, as a qualified name (`source#name`): for `rule(…, { from })`. */
  resolve?: (head: Node, ctx: Ctx) => string | undefined
  /**
   * Where a child of `parent` (in slot `key`, at `index` in a list) stands: for
   * `ctx.position`. `up` is the parent's own ctx (an object property: in an
   * object or in a pattern).
   */
  position?: (parent: Node, key: string | number, index: number | null, up: Ctx) => 'statement' | 'expression' | undefined
  /**
   * For `ctx.tail`: 'return' if the child's value is what its function returns
   * (`return x`), 'pass' if it is the parent's value whenever it is evaluated
   * (`a ? x : y`), so it is in tail position when the parent is.
   */
  tail?: (parent: Node, key: string | number, index: number | null) => 'return' | 'pass' | undefined
}

/** A family with every field present. */
export type Family = { readonly [K in keyof FamilySpec]-?: NonNullable<FamilySpec[K]> }

const DEFAULTS: Family = {
  ignored: [],
  equal: {},
  canon: (type) => type,
  unwrap: () => undefined,
  isStatement: () => false,
  head: () => undefined,
  resolve: () => undefined,
  position: () => undefined,
  tail: () => undefined,
}

const families = new Map<string, Family>()

/** The prefix of `type`: '' for ESTree. */
const prefix = (type: string) => {
  const i = type.indexOf('/')
  return i < 0 ? '' : type.slice(0, i)
}

/** The family of node type `type`; a prefix no one defined gets the defaults. */
export const familyOf = (type: string): Family => families.get(prefix(type)) ?? DEFAULTS

/** Registers family `name`, the prefix of its node types: `defineFamily('lua', { ... })`. */
export function defineFamily(name: string, spec: FamilySpec) {
  if (families.has(name)) throw new Error(`node family "${name}" is already defined`)
  if (name.includes('/')) throw new Error(`node family "${name}": a name without "/"`)
  const given = Object.fromEntries(Object.entries(spec).filter(([, v]) => v !== undefined))
  families.set(name, { ...DEFAULTS, ...given })
}

// --- ESTree ---

type Regex = { pattern: string; flags: string } | undefined
const cooked = (n: Node) => (n.value as { cooked?: string } | undefined)?.cooked

defineFamily('', {
  ignored: ['raw', 'shorthand', 'expression'],
  equal: {
    /** By value, not spelling: `0x1` is `1`. */
    Literal(a, b) {
      const ar = a.regex as Regex
      const br = b.regex as Regex
      if (ar || br) return !!ar && !!br && ar.pattern === br.pattern && ar.flags === br.flags
      if (a.bigint !== undefined || b.bigint !== undefined) return a.bigint === b.bigint
      return Object.is(a.value, b.value)
    },
    TemplateElement: (a, b) => cooked(a) === cooked(b) && !a.tail === !b.tail,
    JSXText: (a, b) => a.value === b.value,
  },
  canon: (type) => (type === 'FunctionDeclaration' ? 'FunctionExpression' : type === 'ClassDeclaration' ? 'ClassExpression' : type),
  // A directive too: `'use strict'` matches the directive, as it always has.
  unwrap: (node) => (node.type === 'ExpressionStatement' ? ((node.children[0] as Node | null) ?? undefined) : undefined),
  isStatement: (type) => /Statement$|Declaration$/.test(type),
  // `f(x)` alone has the head of `f(x)`.
  head(node) {
    if (node.type !== 'ExpressionStatement') return estree.head(node)
    const e = node.children[0] as Node | null
    return e ? familyOf(e.type).head(e) : undefined
  },
  resolve: estree.resolve,
  position: estree.position,
  tail: estree.tail,
})
