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

  test('comments inside if hoist before it', () => {
    assert.deepEqual(body('if (/* c */ x) // why\n  y()\nz()'), [
      '/* c */',
      '// why',
      'IfStatement',
      'ExpressionStatement',
    ])
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

  test('comment between ) and { hoists, not into params', () => {
    assert.deepEqual(body('function f(a) /* x */ {}'), ['/* x */', 'FunctionDeclaration'])
    assert.deepEqual(body('function /* x */ f(a) {}'), ['/* x */', 'FunctionDeclaration'])
  })

  test('nested expression without a list hoists to the nearest list', () => {
    assert.deepEqual(shape(expr('f(() => a /* x */ + b)').arguments), ['/* x */', 'ArrowFunctionExpression'])
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
    assert.deepEqual(body(src), ['/* c */', 'ExpressionStatement'])
    const tpl = expr(src)
    assert.equal(tpl.quasis.length, tpl.expressions.length + 1)
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
