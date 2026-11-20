// Rewrite rules for walk:
//
//   walk(ast, rule(js`add($a, $b)`, js`($a + $b)`))
//   walk(ast, rules(
//     rule(js`add($a, $b)`, (m) => js`(${m.a} + ${m.b})`),
//     rule(js`log($$args)`, null),          // remove
//   ))
//
// A rule fires on enter, outer forms first (like macroexpand): `walk` then goes
// into the replacement's children, so nested forms expand too. At the node
// itself rules repeat until none fires: a macro may expand into another macro.
//
// Comments in front of the pattern (`/* $$cs */ f($$a)`) are also looked for
// among the Comment siblings right before the node in its list. Those siblings
// stay where they are: a rule replaces the node, not its neighbours. So where
// the replacement puts them back in front of itself (`/* $$cs */ g($$a)`), they
// are dropped from it rather than doubled; put anywhere else, they are copies.
//
// `rules` doesn't try every rule at every node: each rule has a key, from the
// root of its pattern (the kinds it can match, with the head name when the
// pattern names one: `assert` in `assert($c)`), and a node looks up the rules
// filed under its own kind and head, those of the node it unwraps to (`f(x)`
// alone), and those with no key. They are tried in the order given, so the
// first that fires wins, as without the index.
//
// `{ from }` matches the head through its binding instead of by name: the rule
// fires where the head is that import, under any local name, and nowhere else.
import { familyOf } from '../ast/family.ts'
import { attrsOf, make, Node, withChildren, type Slot } from '../ast/node.ts'
import type { Ctx } from '../ast/walk.ts'
import { buildAround } from '../match/build.ts'
import { matchPattern } from '../match/match.ts'
import { isPat } from '../match/pat.ts'
import { substitute, substituteTracking } from './index.ts'
import { commentsBefore, compile, type Captures } from './match.ts'

type Replacement = Node | null | ((m: Captures, node: Node, ctx: Ctx) => Node | null | undefined | void)

/** A walk handler; also usable on its own: `r(node, ctx)`. */
export interface Rule {
  (node: Node, ctx: Ctx): Node | null | undefined
  /** One try at this node: the replacement, or undefined if the rule doesn't fire. */
  once(node: Node, ctx: Ctx): Node | null | undefined
}

export interface RuleOptions {
  /**
   * Fire only where the head of the form (the callee of `f(x)`) is this import,
   * under any local name, never on a local or global of the same name: a module
   * specifier as written in the import (`'./macros.js'`), or `{ source, name }`
   * when the exported name is not the one in the pattern (`'default'` for a
   * default import).
   */
  from?: string | { source: string; name?: string }
}

const LIMIT = 100

const isStatement = (n: Node) => familyOf(n.type).isStatement(n.type)

/**
 * Expression `out` in a statement of the kind `node` is, if `node` is one that
 * only wraps an expression (its family's `unwrap`): `f(x)` alone, a Lua
 * CallStatement. Otherwise `out` as it is.
 */
function rewrap(node: Node, out: Node): Node {
  const inner = familyOf(node.type).unwrap(node)
  const i = inner ? node.children.indexOf(inner) : -1
  return i < 0 ? out : make(node.type, {}, node.children.map((s, j) => (j === i ? out : s)))
}

/** `node` without the leading comments in `gone` (they are already in front of it). */
function without(node: Node, gone: Node[]): Node {
  const comments = node.comments as Node[] | undefined
  if (!gone.length || !comments?.some((c) => gone.includes(c))) return node
  const out = withChildren(node, node.children)
  const rest = comments.filter((c) => !gone.includes(c))
  if (rest.length) out.comments = rest
  else delete out.comments
  return out
}

// --- keys ---

type Once = (node: Node, ctx: Ctx) => Node | null | undefined

/** What a pattern says about the nodes it can match: canonical kinds with a head name (null: any head), or ANY. */
type Key = readonly { kind: string; head: string | null }[] | typeof ANY
const ANY = 'any'

/** One rule as `rules` keeps it: `rules(a, rules(b, c))` holds a, b and c. */
interface Entry {
  key: Key
  once: Once
  /** The rule made for it: `rule(...)`'s result, or a Rule given to `rules`. */
  rule: Rule
}

const entriesOf = new WeakMap<Rule, readonly Entry[]>()

const first = (n: Node) => (n.children[0] ?? null) as Slot

/** The key of compiled pattern `p`: the kinds and heads its root allows; through bind, guard and or. */
function keyOf(p: Node): Key {
  const of = first(p)
  switch (p.type) {
    case 'pat/bind':
    case 'pat/guard':
      return of && !Array.isArray(of) ? keyOf(of) : ANY
    case 'pat/node': {
      const kinds = p.kinds as string[] | undefined
      return kinds ? kinds.map((k) => ({ kind: familyOf(k).canon(k), head: null })) : ANY
    }
    case 'pat/or': {
      const out: { kind: string; head: string | null }[] = []
      // A null alternative matches no node.
      for (const alt of Array.isArray(of) ? of : []) {
        if (!alt) continue
        const k = keyOf(alt)
        if (k === ANY) return ANY
        out.push(...k)
      }
      return out
    }
  }
  if (isPat(p)) return ANY
  const f = familyOf(p.type)
  const h = f.head(p)
  return [{ kind: f.canon(p.type), head: h && !isPat(h.node) ? h.name : null }]
}

// --- the index ---

interface Item {
  /** Position in the list given to `rules`. */
  order: number
  once: Once
  rule: Rule
}

const NONE: readonly Item[] = []

class Index {
  readonly any: Item[] = []
  readonly kinds = new Map<string, { none: Item[]; heads: Map<string, Item[]> }>()

  constructor(entries: readonly Entry[]) {
    entries.forEach(({ key, once, rule }, order) => {
      const item = { order, once, rule }
      if (key === ANY) return void this.any.push(item)
      // A rule filed twice under one bucket (`p.or(f(1), f(2))`) is tried once.
      const filed = new Set<Item[]>()
      for (const { kind, head } of key) {
        let k = this.kinds.get(kind)
        if (!k) this.kinds.set(kind, (k = { none: [], heads: new Map() }))
        let bucket = k.none
        if (head !== null) {
          bucket = k.heads.get(head)!
          if (!bucket) k.heads.set(head, (bucket = []))
        }
        if (!filed.has(bucket)) bucket.push(item)
        filed.add(bucket)
      }
    })
  }

  /** The rules that could match `node`, in order: by its kind and head, and those of the nodes it unwraps to. */
  candidates(node: Node): readonly Item[] {
    const lists: Item[][] = []
    if (this.any.length) lists.push(this.any)
    for (let n: Node | undefined = node; n; n = familyOf(n.type).unwrap(n)) {
      const f = familyOf(n.type)
      const k = this.kinds.get(f.canon(n.type))
      if (!k) continue
      if (k.none.length) lists.push(k.none)
      if (k.heads.size) {
        const h = f.head(n)
        const bucket = h && k.heads.get(h.name)
        if (bucket) lists.push(bucket)
      }
    }
    if (lists.length <= 1) return lists[0] ?? NONE
    const all = new Set(lists.flat())
    return [...all].sort((a, b) => a.order - b.order)
  }
}

/** Entries as one Rule: at each node the first that fires wins, until none does. `linear`: try them all, no index. */
function combine(entries: readonly Entry[], linear = false): Rule {
  const index = linear ? undefined : new Index(entries)
  const once = (node: Node, ctx: Ctx) => {
    for (const e of index ? index.candidates(node) : entries) {
      const out = e.once(node, ctx)
      if (out !== undefined) return out
    }
    return undefined
  }
  const apply = (node: Node, ctx: Ctx) => {
    let current = node
    for (let i = 0; i < LIMIT; i++) {
      const out = once(current, ctx)
      if (out === null) return null
      if (out === undefined || out === current) return current === node ? undefined : current
      current = out
    }
    throw new Error(`rules keep firing at the same node (${LIMIT} times): a rule expands into its own pattern`)
  }
  const r: Rule = Object.assign(apply, { once })
  entriesOf.set(r, entries)
  return r
}

// --- heads through bindings ---

/** `n` with node `old` replaced by `by` wherever it is; the rest shared. */
function replaceIn(n: Node, old: Node, by: Node): Node {
  if (n === old) return by
  let changed = false
  const one = (el: Node | null) => {
    const out = el && replaceIn(el, old, by)
    if (out !== el) changed = true
    return out
  }
  const children = n.children.map((s): Slot => (Array.isArray(s) ? s.map(one) : one(s)))
  return changed ? withChildren(n, children) : n
}

/** Compiled pattern `p` with its head (through bind, guard, or) matching any node, and the head names; undefined if it has none. */
function headless(p: Node): { pattern: Node; names: string[] } | undefined {
  const of = first(p)
  switch (p.type) {
    case 'pat/bind':
    case 'pat/guard': {
      const inner = of && !Array.isArray(of) ? headless(of) : undefined
      return inner && { pattern: make(p.type, attrsOf(p), [inner.pattern]), names: inner.names }
    }
    case 'pat/or': {
      const alts = (Array.isArray(of) ? of : []).map((alt) => alt && headless(alt))
      if (!alts.length || alts.some((a) => !a)) return undefined
      return { pattern: make(p.type, attrsOf(p), [alts.map((a) => a!.pattern)]), names: alts.flatMap((a) => a!.names) }
    }
  }
  if (isPat(p)) return undefined
  const h = familyOf(p.type).head(p)
  if (!h || isPat(h.node)) return undefined
  const any = make('pat/any', h.node.comments ? { comments: h.node.comments } : {}, [])
  return { pattern: replaceIn(p, h.node, any), names: [h.name] }
}

/** The qualified name the head of `node` (or of what it unwraps to) refers to, from its family. */
function resolveHead(node: Node, ctx: Ctx): string | undefined {
  for (let n: Node | undefined = node; n; n = familyOf(n.type).unwrap(n)) {
    const f = familyOf(n.type)
    const h = f.head(n)
    if (h) return f.resolve(h.node, ctx)
  }
  return undefined
}

/** The qualified name `from` asks for, and the pattern with its head left to it. */
function fromImport(pattern: Node, from: NonNullable<RuleOptions['from']>): { pattern: Node; target: string } {
  const { source, name } = typeof from === 'string' ? { source: from, name: undefined } : from
  const found = headless(pattern)
  if (!found) throw new TypeError(`rule with { from: '${source}' }: the pattern has no head to look up, a name like the callee of f(...)`)
  const names = [...new Set(found.names)]
  if (name === undefined && names.length > 1) {
    throw new TypeError(`rule with { from: '${source}' }: the alternatives have different heads (${names.join(', ')}); say which export with { source, name }`)
  }
  return { pattern: found.pattern, target: `${source}#${name ?? names[0]}` }
}

// --- templates ---

/** `n` holds a `pat/` node: itself, in its leading comments, or below. */
function hasPat(n: Node): boolean {
  if (isPat(n)) return true
  if (Array.isArray(n.comments) && (n.comments as Node[]).some(hasPat)) return true
  return n.children.some((s) => (Array.isArray(s) ? s.some((el) => !!el && hasPat(el)) : !!s && hasPat(s)))
}

/**
 * How template `t` is filled: `$` variables by `substitute`, then `pat/` nodes
 * by `build`. `build` passes over what `substitute` put in, so a capture is put
 * in as it is, whatever it holds. Decided once: without `pat/` nodes, only `substitute`.
 */
function filler(t: Node): (m: Captures) => Node {
  if (!hasPat(t)) return (m) => substitute(t, m)
  return (m) => {
    const placed = new Set<Node>()
    return buildAround(substituteTracking(t, m, placed), m, placed) as Node
  }
}

// --- rule, rules ---

/**
 * A rule: where `pattern` matches, put `replace` — a template, a function of
 * the captures (return nothing to pass), or null to remove the node. A
 * template has the pattern's variables: `$a` (the `js` sugar), core `pat/`
 * nodes (`p.bind('a')`, `p.rest('a')`, `p.comment('c')`, for any family), or
 * both. `options.from`: the head must be that import.
 */
export function rule(pattern: Node, replace: Replacement, options: RuleOptions = {}): Rule {
  let compiled = compile(pattern)
  let target: string | undefined
  if (options.from !== undefined) ({ pattern: compiled, target } = fromImport(compiled, options.from))
  const fill = replace === null || typeof replace === 'function' ? undefined : filler(replace)
  const once = (node: Node, ctx: Ctx) => {
    const m = matchPattern(node, compiled, ctx)
    if (!m) return undefined
    // After the match: `ctx.scope` is computed only where a form could fire.
    if (target !== undefined && resolveHead(node, ctx) !== target) return undefined
    let out = replace === null ? null : typeof replace === 'function' ? (replace(m, node, ctx) ?? undefined) : fill!(m)
    if (out) out = without(out, commentsBefore(ctx))
    // An expression pattern also fires on its statement (`log(x)` alone): null
    // removes the statement, an expression stays one.
    return out && !isStatement(out) ? rewrap(node, out) : out
  }
  const entry: Entry = { key: keyOf(compiled), once, rule: undefined as unknown as Rule }
  return (entry.rule = combine([entry]))
}

/** The entries of `list`, nested `rules` flattened; a Rule of unknown make has no key. */
const flatten = (list: Rule[]): Entry[] =>
  list.flatMap((r) => entriesOf.get(r) ?? [{ key: ANY, once: (node: Node, ctx: Ctx) => r.once(node, ctx), rule: r }])

/** Several rules: at each node the first that fires wins, until none does. */
export function rules(...list: Rule[]): Rule {
  return combine(flatten(list))
}

/** Internal, for tests: `rules` without the index, every rule tried at every node. */
export function linear(...list: Rule[]): Rule {
  return combine(flatten(list), true)
}

/** Internal, for tests: the rules of `r` that the index would try at `node`, in order. */
export function candidates(r: Rule, node: Node): Rule[] {
  return new Index(entriesOf.get(r) ?? flatten([r])).candidates(node).map((i) => i.rule)
}
