import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { originOf, read, type Node } from './index.ts'

/** Compact view of a list: comments as text, identifiers by name, the rest by type. */
const shape = (list: unknown) =>
  (list as Node[]).map((n) => {
    if (n === null) return null
    if (n.type === 'Comment') return n.kind === 'Line' ? `//${n.value}` : `/*${n.value}*/`
    if (n.type === 'Identifier') return n.name
    if (n.type === 'Literal') return n.value
    return n.type
  })

const body = (src: string, filename?: string) => shape(read(src, { filename }).body)
const expr = (src: string) => (read(src).body.at(-1) as any).expression
/** The leading comments of `node` (its `comments` attribute), as text. */
const lead = (node: Node) => shape(node.comments ?? [])

describe('comments as nodes', () => {
  test('leading comment stands before its statement', () => {
    assert.deepEqual(body('// lead\nconst x = 1'), ['// lead', 'VariableDeclaration'])
  })

  test('trailing comment on the same line moves before its statement', () => {
    assert.deepEqual(body('const x = 1 // note\nconst y = 2'), ['// note', 'VariableDeclaration', 'VariableDeclaration'])
  })

  test('own-line comment belongs to the next statement', () => {
    assert.deepEqual(body('a()\n// about b\nb()'), ['ExpressionStatement', '// about b', 'ExpressionStatement'])
  })

  test('several comments keep source order', () => {
    assert.deepEqual(body('// 1\n/* 2 */ a() // 3\n// 4\nb()'), [
      '// 1',
      '/* 2 */',
      '// 3',
      'ExpressionStatement',
      '// 4',
      'ExpressionStatement',
    ])
  })

  test('comment after the last statement stays at the end', () => {
    assert.deepEqual(body('a()\n// tail'), ['ExpressionStatement', '// tail'])
    const block = (read('{\n  a()\n  // tail\n}').body[0] as any).body
    assert.deepEqual(shape(block), ['ExpressionStatement', '// tail'])
  })

  test('comment-only program and empty block', () => {
    assert.deepEqual(body('// only'), ['// only'])
    assert.deepEqual(body(''), [])
    const fn = read('function g() { /* inner */ }').body[0] as any
    assert.deepEqual(shape(fn.body.body), ['/* inner */'])
  })

  test('inside if: a block comment leads the test, a line comment the consequent', () => {
    const src = 'if (/* c */ x) // why\n  y()\nz()'
    assert.deepEqual(body(src), ['IfStatement', 'ExpressionStatement'])
    const ifs = read(src).body[0] as any
    assert.deepEqual(lead(ifs.test), ['/* c */'])
    assert.deepEqual(lead(ifs.consequent), ['// why'])
  })

  test('comment inside a block of if stays in the block', () => {
    const ifs = read('if (x) {\n  y() // after y\n}').body[0] as any
    assert.deepEqual(shape(ifs.consequent.body), ['// after y', 'ExpressionStatement'])
  })

  test('arguments: comma decides the owner', () => {
    assert.deepEqual(shape(expr('f(a /* a */, b)').arguments), ['/* a */', 'a', 'b'])
    assert.deepEqual(shape(expr('f(a, /* b */ b)').arguments), ['a', '/* b */', 'b'])
    assert.deepEqual(shape(expr('f(/* a */ a)').arguments), ['/* a */', 'a'])
  })

  test('comment between ) and { leads the body, not into params', () => {
    const f = read('function f(a) /* x */ {}').body[0] as any
    assert.deepEqual(shape(f.params), ['a'])
    assert.deepEqual(lead(f.body), ['/* x */'])
    assert.deepEqual(lead((read('function /* x */ f(a) {}').body[0] as any).id), ['/* x */'])
  })

  test('nested expression without a list: a comment of either kind leads the node after it', () => {
    const arrow = expr('f(() => a /* x */ + b)').arguments[0]
    assert.deepEqual(lead(arrow.body.right), ['/* x */'])
    const call = expr('f(() => a // x\n + b)')
    assert.deepEqual(shape(call.arguments), ['ArrowFunctionExpression'])
    assert.deepEqual(lead(call.arguments[0].body.right), ['// x'])
  })

  test('object properties and array elements', () => {
    assert.deepEqual(shape(expr('({\n  a: 1, // a\n  // b\n  b: 2,\n})').properties), [
      '// a',
      'Property',
      '// b',
      'Property',
    ])
    assert.deepEqual(shape(expr('[1, 2, // end\n]').elements), [1, '// end', 2])
    assert.deepEqual(shape(expr('[ /* empty */ ]').elements), ['/* empty */'])
  })

  test('template literal parts are never interleaved with comments', () => {
    const src = '`a${/* c */ x}b`'
    assert.deepEqual(body(src), ['ExpressionStatement'])
    const tpl = expr(src)
    assert.equal(tpl.quasis.length, tpl.expressions.length + 1)
    assert.deepEqual(lead(tpl.expressions[0]), ['/* c */'])
    // Template text never takes one: it would end up inside the string.
    assert.deepEqual(body('`a${x /* c */}b`'), ['/* c */', 'ExpressionStatement'])
  })

  test('JSX: {/* c */} becomes a Comment child', () => {
    const el = expr('<a>x{/* c */}<b /></a>')
    assert.deepEqual(shape(el.content), ['JSXText', '/* c */', 'JSXElement'])
    const attrs = expr('<a /* c */ b={1} />').openingElement.attributes
    assert.deepEqual(shape(attrs), ['/* c */', 'JSXAttribute'])
  })

  test('class members', () => {
    const cls = read('class A {\n  // x\n  x = 1 // one\n  m() {}\n}').body[0] as any
    assert.deepEqual(shape(cls.body.body), ['// x', '// one', 'PropertyDefinition', 'MethodDefinition'])
  })

  test('switch cases', () => {
    const sw = read('switch (x) {\n  case 1:\n    // in case\n    a()\n  // before 2\n  case 2:\n}').body[0] as any
    assert.deepEqual(shape(sw.cases[0].consequent), ['// in case', 'ExpressionStatement'])
    assert.deepEqual(shape(sw.cases), ['SwitchCase', '// before 2', 'SwitchCase'])
  })

  test('JSDoc stays before a declaration with types', () => {
    assert.deepEqual(body('/** doc */\nexport function f(a: number): string {}', 'a.ts'), [
      '/** doc */',
      'ExportNamedDeclaration',
    ])
  })

  test('comment nodes have an origin', () => {
    const src = 'a() // here'
    const c = read(src).body[0] as Node
    const o = originOf(c)!
    assert.equal(src.slice(o.start, o.end), '// here')
  })
})

describe('leading comments: a block comment in no list leads the node after it', () => {
  const decl = (src: string) => (read(src).body[0] as any).declarations[0]

  test('stays where it was written, as an attribute of the next node', () => {
    const ifs = read('if (/* some comment */ a == 0) b()').body[0] as any
    assert.equal(ifs.test.type, 'BinaryExpression', 'slots are untouched')
    assert.deepEqual(lead(ifs.test), ['/* some comment */'])
    assert.deepEqual(body('if (/* some comment */ a == 0) b()'), ['IfStatement'])
    assert.deepEqual(lead(decl('const x = /* @__PURE__ */ f()').init), ['/* @__PURE__ */'])
    const imp = decl('const m = import(/* webpackChunkName: "x" */ "./x.js")').init
    assert.deepEqual(lead(imp.source), ['/* webpackChunkName: "x" */'])
  })

  test('the owner is the outermost node that starts after the comment', () => {
    const sum = expr('x = /* c */ a + b').right
    assert.deepEqual(lead(sum), ['/* c */'])
    assert.deepEqual(lead(sum.left), [])
    assert.deepEqual(lead(expr('a + /* why */ b').right), ['/* why */'])
  })

  test('the next child, whatever slot: consequent, body, template expression', () => {
    assert.deepEqual(lead((read('if (x /* c */) y()').body[0] as any).consequent), ['/* c */'])
    assert.deepEqual(lead((read('function f(a) /* x */ {}').body[0] as any).body), ['/* x */'])
    assert.deepEqual(lead(expr('`${/* c */ x}`').expressions[0]), ['/* c */'])
  })

  test('several keep source order', () => {
    assert.deepEqual(lead(expr('x = /* a */ /* b */ y').right), ['/* a */', '/* b */'])
  })

  test('lists keep their rule; nothing after it in the node: hoisted', () => {
    assert.deepEqual(shape(expr('f(/* timeout */ 100)').arguments), ['/* timeout */', 100])
    assert.deepEqual(body('x = a /* c */'), ['/* c */', 'ExpressionStatement'])
    assert.deepEqual(body('x = (a // c\n)'), ['// c', 'ExpressionStatement'])
  })

  test('grouping parentheses before a list element do not count', () => {
    assert.deepEqual(shape(expr('f(/* c */ (a))').arguments), ['/* c */', 'a'])
    assert.deepEqual(shape(expr('[ // c\n (a, b)]').elements), ['// c', 'SequenceExpression'])
  })

  test('a node that is keywords around one list: before the next element', () => {
    const sw = read('switch (x) { default /* c */: y }').body[0] as any
    assert.deepEqual(shape(sw.cases[0].consequent), ['/* c */', 'ExpressionStatement'])
    assert.deepEqual(shape(expr('[ /* empty */ ]').elements), ['/* empty */'])
  })

  test('leading comments are Comment nodes with an origin; no attr when there are none', () => {
    const src = 'x = /* c */ y'
    const right = expr(src).right
    const [c] = right.comments as Node[]
    assert.equal(c.type, 'Comment')
    assert.equal(c.kind, 'Block')
    const o = originOf(c)!
    assert.equal(src.slice(o.start, o.end), '/* c */')
    assert.ok(!('comments' in expr('x = y').right))
  })
})

describe('leading comments: a line comment in no list leads the node after it too', () => {
  test('stays where it was written', () => {
    const d = read('const x = a + // why\n b').body[0] as any
    assert.deepEqual(shape(d.declarations), ['VariableDeclarator'])
    assert.deepEqual(lead(d.declarations[0].init.right), ['// why'])
    assert.deepEqual(lead(expr('x = a ? // c\n b : c').right.consequent), ['// c'])
    assert.deepEqual(lead(expr('x = a // c\n .b').right.property), ['// c'])
    assert.deepEqual(lead((read('class A { static // c\n m() {} }').body[0] as any).body.body[0].key), ['// c'])
  })

  test('hoisted where the printed line break would change the code', () => {
    // Printed after `async`, the comment would end the line: a field `async` and a method.
    const cls = read('class A { static // c\n async m() {} }').body[0] as any
    assert.deepEqual(shape(cls.body.body), ['// c', 'MethodDefinition'])
    assert.deepEqual(lead(cls.body.body[1].key), [])
  })
})

describe('JSDoc casts: `/** @type {T} */ (x)` leads the expression in the parentheses', () => {
  const T = '/** @type {T} */'

  test('the node that fills the parentheses', () => {
    assert.deepEqual(lead(expr(`x = ${T} (a).b`).right.object), [T])
    assert.deepEqual(lead(expr(`x = ${T} (a.b)`).right), [T])
    assert.deepEqual(lead(expr(`x = ${T} ((a))`).right), [T])
    assert.deepEqual(lead(expr(`x = ${T} (a, b)`).right), [T])
    assert.deepEqual(lead(expr(`x = ${T} (a)(b)`).right.callee), [T])
    assert.deepEqual(lead(expr(`${T} (function () {})()`).callee), [T])
    assert.deepEqual(lead(expr(`x = ${T} (a?.b)`).right), [T], 'the chain, not the member in it')
    assert.deepEqual(lead(expr('x = /** @satisfies {T} */ ({})').right), ['/** @satisfies {T} */'])
    assert.deepEqual(lead(expr('x = /**\n * @type {T}\n */ (a)').right), ['/**\n * @type {T}\n */'])
  })

  test('wins over the list rule', () => {
    const call = expr(`f(${T} (x))`)
    assert.deepEqual(shape(call.arguments), ['x'])
    assert.deepEqual(lead(call.arguments[0]), [T])
    assert.deepEqual(body(`${T} (x).foo()`), ['ExpressionStatement'])
    assert.deepEqual(lead(expr(`${T} (x).foo()`).callee.object), [T])
  })

  test('only grouping parentheses: not those of a call, parameters or `if`', () => {
    assert.deepEqual(shape(expr(`f ${T} (x)`).arguments), [T, 'x'])
    const arrow = expr(`x = ${T} (a) => a`).right
    assert.deepEqual([lead(arrow), lead(arrow.params[0])], [[T], []], 'leads the arrow, as any comment there')
    // Before `if`'s own `(` it leads the test as any comment there; inside, it is a cast of the same node.
    assert.deepEqual(lead((read(`if ${T} (x) y()`).body[0] as any).test), [T])
    assert.deepEqual(lead((read(`if (${T} (x)) y()`).body[0] as any).test), [T])
  })

  test('not across a line break, not other tags, not with a comment between', () => {
    assert.deepEqual(body(`${T}\n(x).foo()`), [T, 'ExpressionStatement'])
    assert.deepEqual(body('/** @param {T} x */ (x).foo()'), ['/** @param {T} x */', 'ExpressionStatement'])
    assert.deepEqual(shape(expr(`f(${T} /* c */ (x))`).arguments), [T, '/* c */', 'x'])
  })

  test('not in patterns or types', () => {
    assert.deepEqual(shape(expr(`[${T} (a)] = b`).left.elements), [T, 'a'])
    const prop = expr(`({ a: ${T} (b) } = c)`).left.properties[0]
    assert.deepEqual(lead(prop.value), [T], 'leads the value, as any comment there')
    const alias = read(`type A = ${T} (B)`, { filename: 'a.ts' }).body[0] as any
    assert.deepEqual(lead(alias.typeAnnotation), [T])
  })
})
