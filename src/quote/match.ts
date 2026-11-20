// match(node, pattern): structural matching with pattern variables, the other
// half of `js`. A pattern is code: `$a` matches any node and captures it, `$$a`
// any run of list elements (an array), `$_` and `$$_` match without capturing.
// A variable may stand where a whole list element is: a statement (`{ $s }`),
// a shorthand property (`{ $$props }`), a class member, a JSX child (`{$$kids}`).
import { attrsOf, Node, slotsOf, type Slot } from '../ast/node.ts'

export type Captures = Record<string, any>

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

/** Attrs that don't change what the code means (`comments`: leading comments). */
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

const code = (list: (Node | null)[]) => list.filter((n) => !(n && n.type === 'Comment'))

class Matcher {
  /** False when comparing two captures: there `$x` is just a name. */
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

  node(p: Node | null, t: Node | null, caps: Captures): boolean {
    if (!p || !t) return p === t
    const v = this.vars ? varOf(p, false) : undefined
    if (v) return this.bind(v, t, caps)
    // An expression pattern matches an expression statement: `match(stmt, js\`f($$a)\`)`.
    if (t.type === 'ExpressionStatement' && !/Statement$|Declaration$/.test(p.type)) return this.node(p, t.children[0] as Node, caps)
    if (kind(p.type) !== kind(t.type) || !sameAttrs(p, t)) return false
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
    ps = code(ps)
    ts = code(ts)
    const go = (i: number, j: number, caps: Captures): Captures | null => {
      if (i === ps.length) return j === ts.length ? caps : null
      const p = ps[i]
      const v = p && this.vars ? varOf(p, true) : undefined
      if (v?.seq) {
        for (let k = j; k <= ts.length; k++) {
          const next = { ...caps }
          if (this.bind(v, ts.slice(j, k), next)) {
            const found = go(i + 1, k, next)
            if (found) return found
          }
        }
        return null
      }
      if (j === ts.length) return null
      const next = { ...caps }
      const t = ts[j]
      const ok = v ? t !== null && this.bind(v, t, next) : this.node(p, t, next)
      return ok ? go(i + 1, j + 1, next) : null
    }
    return go(0, 0, caps)
  }
}

const asList = (s: unknown): (Node | null)[] => (Array.isArray(s) ? s : s === null || s === undefined ? [] : [s as Node])

const withVars = new Matcher(true)
const exact = new Matcher(false)

/**
 * The captures if `node` matches `pattern`, else null. `pattern` is usually
 * from `js`: `match(node, js\`$a + $b\`)` gives `{ a, b }`. Comments, layout
 * and literal spelling (`0x1` and `1`) don't matter. A list of nodes matches a
 * list pattern (`js.stmts`).
 */
export function match(node: Node | Node[], pattern: Node | Node[]): Captures | null {
  if (Array.isArray(pattern) || Array.isArray(node)) return withVars.list(asList(pattern), asList(node), {})
  const caps: Captures = {}
  return withVars.node(pattern, node, caps) ? caps : null
}
