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

  test('inside if: a block comment leads the test, a line comment hoists before the if', () => {
    const src = 'if (/* c */ x) // why\n  y()\nz()'
    assert.deepEqual(body(src), ['// why', 'IfStatement', 'ExpressionStatement'])
    assert.deepEqual(lead((read(src).body[1] as any).test), ['/* c */'])
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

  test('nested expression without a list: a block comment leads, a line comment hoists to the nearest list', () => {
    const arrow = expr('f(() => a /* x */ + b)').arguments[0]
    assert.deepEqual(lead(arrow.body.right), ['/* x */'])
    assert.deepEqual(shape(expr('f(() => a // x\n + b)').arguments), ['// x', 'ArrowFunctionExpression'])
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

  test('lists keep their rule; line comments still hoist', () => {
    assert.deepEqual(shape(expr('f(/* timeout */ 100)').arguments), ['/* timeout */', 100])
    const d = read('const x = a + // why\n b').body[0] as any
    assert.deepEqual(shape(d.declarations), ['// why', 'VariableDeclarator'])
    assert.equal(d.declarations[1].init.comments, undefined)
    // Nothing after it in the node: hoisted as before.
    assert.deepEqual(body('x = a /* c */'), ['/* c */', 'ExpressionStatement'])
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
