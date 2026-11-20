// The ESTree family's hooks that know node types by name (family.ts registers
// them): where a child stands (`position`), which slots pass a return value
// through (`tail`), the name that heads a form (`head`) and the import it
// refers to (`resolve`). `walk` and `rules` stay free of type names.
import { slotsOf, type Node, type Slot } from './node.ts'
import { accessor } from './slots.ts'
import type { Ctx } from './walk.ts'

type Where = 'statement' | 'expression'
type Rule = Where | ((parent: Node, child: Node | null, up: Ctx) => Where | undefined)

const S = 'statement'
const E = 'expression'

/** Slot `name` (an accessor name: `content` for JSX children) of `n`. */
function slot(n: Node, name: string | number): Slot | undefined {
  if (typeof name === 'number') return n.children[name]
  const i = slotsOf(n.type)?.findIndex((s) => accessor(s) === name) ?? -1
  return i < 0 ? undefined : n.children[i]
}

const single = (s: Slot | undefined): Node | null => (s && !Array.isArray(s) ? s : null)
const computed: Rule = (p) => (p.computed ? E : undefined)
/** An arrow's body is an expression, or a block. */
const arrowBody = (p: Node) => single(slot(p, 'body'))
const isBlock = (n: Node | null) => n?.type === 'BlockStatement'

/**
 * Per parent type and slot: where its children stand. 'statement': where any
 * statement goes, or the expression of an expression statement (its value is
 * discarded). 'expression': its value is used. Slots not here (binding
 * patterns, types, non-computed keys, labels, function bodies, a try's blocks)
 * are neither.
 */
const POSITIONS: Record<string, Record<string, Rule>> = {
  Program: { body: S },
  BlockStatement: { body: S },
  StaticBlock: { body: S },
  TSModuleBlock: { body: S },
  SwitchCase: { test: E, consequent: S },
  IfStatement: { test: E, consequent: S, alternate: S },
  ForStatement: { init: (_, c) => (c?.type === 'VariableDeclaration' ? undefined : E), test: E, update: E, body: S },
  ForInStatement: { right: E, body: S },
  ForOfStatement: { right: E, body: S },
  WhileStatement: { test: E, body: S },
  DoWhileStatement: { body: S, test: E },
  LabeledStatement: { body: S },
  WithStatement: { object: E, body: S },
  ExpressionStatement: { expression: S },
  ExportNamedDeclaration: { declaration: S },
  // `export default function f() {}` declares; `export default f()` is a value.
  ExportDefaultDeclaration: { declaration: (_, c) => (c && /Declaration$/.test(c.type) ? S : E) },
  ReturnStatement: { argument: E },
  ThrowStatement: { argument: E },
  SwitchStatement: { discriminant: E },
  VariableDeclarator: { init: E },
  ArrayExpression: { elements: E },
  AssignmentExpression: { right: E },
  AssignmentPattern: { right: E },
  AwaitExpression: { argument: E },
  BinaryExpression: { left: E, right: E },
  LogicalExpression: { left: E, right: E },
  ConditionalExpression: { test: E, consequent: E, alternate: E },
  CallExpression: { callee: E, arguments: E },
  NewExpression: { callee: E, arguments: E },
  ChainExpression: { expression: E },
  ImportExpression: { source: E, options: E },
  MemberExpression: { object: E, property: computed },
  SequenceExpression: { expressions: E },
  SpreadElement: { argument: E },
  TaggedTemplateExpression: { tag: E },
  TemplateLiteral: { expressions: E },
  UnaryExpression: { argument: E },
  YieldExpression: { argument: E },
  ArrowFunctionExpression: { body: (p) => (isBlock(arrowBody(p)) ? undefined : E) },
  ClassDeclaration: { superClass: E },
  ClassExpression: { superClass: E },
  Decorator: { expression: E },
  // In an object pattern the value is a binding; a method's value is its function.
  Property: { key: computed, value: (p, _, up) => (up.parent?.type === 'ObjectExpression' && p.kind === 'init' && !p.method ? E : undefined) },
  PropertyDefinition: { key: computed, value: E },
  AccessorProperty: { key: computed, value: E },
  MethodDefinition: { key: computed },
  TSAbstractMethodDefinition: { key: computed },
  TSAbstractPropertyDefinition: { key: computed },
  TSAbstractAccessorProperty: { key: computed },
  JSXExpressionContainer: { expression: E },
  JSXSpreadAttribute: { argument: E },
  JSXSpreadChild: { expression: E },
  TSAsExpression: { expression: E },
  TSSatisfiesExpression: { expression: E },
  TSNonNullExpression: { expression: E },
  TSTypeAssertion: { expression: E },
  TSInstantiationExpression: { expression: E },
  TSEnumMember: { initializer: E },
  TSExportAssignment: { expression: E },
}

export function position(parent: Node, key: string | number, index: number | null, up: Ctx): Where | undefined {
  const rule = POSITIONS[parent.type]?.[key]
  if (!rule) return undefined
  const s = slot(parent, key)
  const child = Array.isArray(s) ? (index === null ? null : (s[index] ?? null)) : (s ?? null)
  // `...xs` in a list of values is not a value itself.
  if (child?.type === 'SpreadElement') return undefined
  return typeof rule === 'string' ? rule : rule(parent, child, up)
}

/** Wrappers whose value is their expression's. */
const PASS = new Set(['ChainExpression', 'TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSInstantiationExpression'])

export function tail(parent: Node, key: string | number, index: number | null): 'return' | 'pass' | undefined {
  switch (parent.type) {
    case 'ReturnStatement':
      return key === 'argument' ? 'return' : undefined
    case 'ArrowFunctionExpression':
      return key === 'body' && !isBlock(arrowBody(parent)) ? 'return' : undefined
    case 'ConditionalExpression':
      return key === 'consequent' || key === 'alternate' ? 'pass' : undefined
    case 'LogicalExpression':
      return key === 'right' ? 'pass' : undefined
    case 'SequenceExpression': {
      // The last expression, comments aside.
      const list = slot(parent, 'expressions')
      if (!Array.isArray(list) || index === null) return undefined
      let last = list.length - 1
      while (last >= 0 && list[last]?.type === 'Comment') last--
      return index === last ? 'pass' : undefined
    }
    default:
      return PASS.has(parent.type) && key === 'expression' ? 'pass' : undefined
  }
}

/** The callee of `f()` and `new F()`, the tag of tag`...`, the name of `<F />`: when it is a plain name. */
export function head(node: Node): { node: Node; name: string } | undefined {
  let h: Slot | undefined
  switch (node.type) {
    case 'CallExpression':
    case 'NewExpression':
    case 'TaggedTemplateExpression':
      h = node.children[0]
      break
    case 'JSXElement': {
      const opening = single(node.children[0])
      h = opening?.children[0]
      break
    }
    default:
      return undefined
  }
  const n = single(h)
  return n && (n.type === 'Identifier' || n.type === 'JSXIdentifier') && typeof n.name === 'string' ? { node: n, name: n.name } : undefined
}

/**
 * The import a head refers to, as `source#name` (`default`, `*`, or the
 * exported name; the source as written). A head that `ctx.scope` doesn't know
 * was made during the walk (by a template): it is looked up by name from the
 * nearest enclosing scope that is in the snapshot.
 */
export function resolve(head: Node, ctx: Ctx): string | undefined {
  const info = ctx.scope
  let binding = info.bindingOf(head)
  if (binding === undefined) {
    const name = head.name
    // `<div>` is a tag, not a name (scope.ts).
    if (typeof name !== 'string' || (head.type === 'JSXIdentifier' && !/^[A-Z_$]/.test(name))) return undefined
    const ancestors = ctx.ancestors
    let s = info.root
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const found = info.scopeOf(ancestors[i])
      if (found) {
        s = found
        break
      }
    }
    binding = s.lookup(name)
  }
  return binding?.import ? `${binding.import.source}#${binding.import.name}` : undefined
}
