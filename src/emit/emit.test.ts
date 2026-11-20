import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { read } from '../read/index.ts'
import { emit } from './index.ts'

const fmt = (src: string, filename = 'input.js') => emit(read(src, { filename }))

/** Exact output: `src` -> `out` (a trailing newline is added to `out`). */
const cases = (list: [src: string, out: string, filename?: string][]) => {
  for (const [src, out, filename] of list) {
    test(JSON.stringify(src), () => assert.equal(fmt(src, filename), out + '\n'))
  }
}

describe('emit: style', () => {
  cases([
    ['const a=1;let b', 'const a = 1\nlet b'],
    ["import {a as a, b as c} from 'x';", "import { a, b as c } from 'x'"],
    ["import {} from 'x'", "import 'x'"],
    ['export default function () {}', 'export default function () {}'],
    ['if(a){b()}else if(c){d()}else{e()}', 'if (a) {\n  b()\n} else if (c) {\n  d()\n} else {\n  e()\n}'],
    ['if (a) b(); else c()', 'if (a) b()\nelse c()'],
    ['const a = 1\nfunction f() {}\nconst b = 2', 'const a = 1\n\nfunction f() {}\n\nconst b = 2'],
    ['const f = x => x', 'const f = (x) => x'],
    ['function* g() {}', 'function* g() {}'],
    ['switch (x) { case 1: a(); default: }', 'switch (x) {\n  case 1:\n    a()\n  default:\n}'],
  ])
})

describe('emit: no semicolons, ASI-safe', () => {
  cases([
    ['a();(b||c).d()', 'a()\n;(b || c).d()'],
    ['(a||b).c()', '(a || b).c()'],
    ['let x = 1;[1].map(f)', 'let x = 1\n;[1].map(f)'],
    ['a;`x`', 'a\n;`x`'],
    ['function f() {}\n[1].map(f)', 'function f() {}\n\n[1].map(f)'],
    ['if (a) {}\n[1].map(f)', 'if (a) {}\n[1].map(f)'],
    ['if (a) b()\n;[1].map(f)', 'if (a) b()\n;[1].map(f)'],
    ['class A { x = 1; [k] = 2; m() {} [j]() {} }', 'class A {\n  x = 1\n  ;[k] = 2\n\n  m() {}\n\n  [j]() {}\n}'],
  ])
})

describe('emit: parentheses', () => {
  cases([
    ['({a} = b)', '({ a } = b)'],
    ['(function(){})()', '(function () {})()'],
    ['(class {})', '(class {})'],
    ['let x = () => ({})', 'let x = () => ({})'],
    ['(a+b)*c', '(a + b) * c'],
    ['a+(b*c)', 'a + b * c'],
    ['a-(b-c)', 'a - (b - c)'],
    ['(a**b)**c', '(a ** b) ** c'],
    ['(-a)**b', '(-a) ** b'],
    ['(a??b)||c', '(a ?? b) || c'],
    ['a ?? (b && c)', 'a ?? (b && c)'],
    ['new (f())()', 'new (f())()'],
    ['new (a.b().c)', 'new (a.b().c)()'],
    ['new A', 'new A()'],
    ['(a?.b).c', '(a?.b).c'],
    ['f((a,b))', 'f((a, b))'],
    ['-(-x)', '- -x'],
    ['(1).toString()', '(1).toString()'],
    ['(a ? b : c) ? d : e', '(a ? b : c) ? d : e'],
    ['for (let i = ("a" in o); ;) {}', 'for (let i = ("a" in o);;) {}'],
    ['export default (function () {})', 'export default (function () {})'],
    ['(a as any).b', '(a as any).b', 'a.ts'],
    ['type A = (B | C)[]', 'type A = (B | C)[]', 'a.ts'],
    ['type F = (() => void) | null', 'type F = (() => void) | null', 'a.ts'],
    ['const f = <T>(x: T) => x', 'const f = <T,>(x: T) => x', 'a.ts'],
  ])
})

describe('emit: comments', () => {
  cases([
    ['const x = 1 // note\nconst y = 2', '// note\nconst x = 1\nconst y = 2'],
    ['f(a, /* b */ b)', 'f(a, /* b */ b)'],
    ['f(a, // about a\n b)', 'f(\n  // about a\n  a,\n  b,\n)'],
    ['f(a,\n // about b\n b)', 'f(\n  a,\n  // about b\n  b,\n)'],
    ['({}).toString()', '({}).toString()'],
    ['let f = () => ({}).x', 'let f = () => ({}).x'],
    ['export default (class {}).name', 'export default (class {}).name'],
    ['f(a,\n /* end */\n)', 'f(\n  a,\n  /* end */\n)'],
    ['function g() { /* inner */ }', 'function g() {\n  /* inner */\n}'],
    ['if (/* c */ x) y()', 'if (/* c */ x) y()'],
    ['<a>{/* c */}</a>', '<a>{/* c */}</a>'],
    ['a()\n// tail', 'a()\n// tail'],
  ])
})

describe('emit: leading comments', () => {
  /** Exact output, plus both round-trip properties on it. */
  const leading: [src: string, out: string, filename?: string][] = [
    ['if (/* c */ a == 0) b()', 'if (/* c */ a == 0) b()'],
    ['const x = /* @__PURE__ */ f()', 'const x = /* @__PURE__ */ f()'],
    ['import(/* webpackChunkName: "x" */ "./x.js")', 'import(/* webpackChunkName: "x" */ "./x.js")'],
    ['x = /* c */ a + b', 'x = /* c */ a + b'],
    ['a + /* why */ b', 'a + /* why */ b'],
    ['function f(a) /* x */ {}', 'function f(a) /* x */ {}'],
    ['if (x /* c */) y()', 'if (x) /* c */ y()'],
    ['`${/* c */ x}`', '`${/* c */ x}`'],
    ['f(/* timeout */ 100)', 'f(/* timeout */ 100)'],
    // Line comments hoist as before (this layout is the existing one for a line comment in `let a, b`).
    ['const x = a + // why\n b', 'const \n  // why\n  x = a + b\n'],
    ['x = a + // why\n b', '// why\nx = a + b'],
    ['x = /* a */ /* b */ y', 'x = /* a */ /* b */ y'],
    // A comment at the start of its parent's text stays inside parens.
    ['(/* c */ a) + b', '(/* c */ a) + b'],
    ['(/* c */ a + b) * 2', '(/* c */ a + b) * 2'],
    ['(/* c */ f())', '(/* c */ f())'],
    ['(/* c */ a).b()', '(/* c */ a).b()'],
    ['(/* c */ function () {})()', '(/* c */ function () {})()'],
    ['a()\n;(/* c */ b).c()', 'a()\n;(/* c */ b).c()'],
    ['x = (/* c */ a ?? b) || c', 'x = (/* c */ a ?? b) || c'],
    ['type A = (/* c */ T)[]', 'type A = (/* c */ T)[]', 'a.ts'],
    // Checks on how a text starts see through comments.
    ['export default (/* c */ function () {})', 'export default (/* c */ function () {})'],
    ['export default /* c */ function () {}', 'export default /* c */ function () {}'],
    ['let f = () => (/* c */ {})', 'let f = () => (/* c */ {})'],
    ['let f = () => /* c */ {}', 'let f = () => /* c */ {}'],
    ['- /* c */ -x', '- /* c */ -x'],
    ['import { a as /* c */ a } from "x"', 'import { a as /* c */ a } from "x"'],
    // A line break after `return` would end the statement.
    ['function g() { return (/* a\n b */ x) }', 'function g() {\n  return (/* a\n b */ x)\n}'],
    ['function g() { return /* a */ x }', 'function g() {\n  return /* a */ x\n}'],
    // Children printed in parts.
    ['class A { m /* c */ () /* d */ {} }', 'class A {\n  m /* c */ () /* d */ {}\n}'],
    ['let f = (a) => /* c */ a', 'let f = (a) => /* c */ a'],
    ['let x /* c */ : T', 'let x /* c */ : T', 'a.ts'],
    ['function f /* c */ <T>() {}', 'function f /* c */ <T>() {}', 'a.ts'],
    ['type F = (a) /* c */ => R', 'type F = (a) /* c */ => R', 'a.ts'],
    ['let x = <a>{/* c */ y}</a>', 'let x = <a>{/* c */ y}</a>'],
    ['let x = <a></ /* c */ a>', 'let x = <a></ /* c */ a>'],
  ]
  for (const [src, out, filename = 'input.js'] of leading) {
    test(JSON.stringify(src), () => {
      const ast = read(src, { filename })
      const code = emit(ast)
      assert.equal(code, out + '\n')
      assert.deepEqual(read(code, { filename }), ast, 'read(emit(ast)) must equal ast')
      assert.equal(emit(read(code, { filename })), code, 'emit must be a fixed point')
    })
  }
})

describe('emit: nodes built by hand', () => {
  test('literals without raw', () => {
    const lit = (value: unknown) => emit({ type: 'Literal', value })
    assert.equal(lit("it's\n"), "'it\\'s\\n'")
    assert.equal(lit(1.5), '1.5')
    assert.equal(lit(null), 'null')
    assert.equal(lit(10n), '10n')
  })

  test('negative number literal binds like unary minus', () => {
    const ast = {
      type: 'BinaryExpression',
      operator: '**',
      left: { type: 'Literal', value: -2 },
      right: { type: 'Literal', value: 2 },
    }
    assert.equal(emit(ast), '(-2) ** 2')
  })

  test('dangling else gets a block', () => {
    const id = (name: string) => ({ type: 'Identifier', name })
    const call = (name: string) => ({ type: 'ExpressionStatement', expression: { type: 'CallExpression', callee: id(name), arguments: [] } })
    const ast = {
      type: 'IfStatement',
      test: id('a'),
      consequent: { type: 'IfStatement', test: id('b'), consequent: call('c'), alternate: null },
      alternate: call('d'),
    }
    assert.equal(emit(ast), 'if (a) {\n  if (b) c()\n} else d()')
  })

  test('unknown node type is an error', () => {
    assert.throws(() => emit({ type: 'Nope' }), /unknown node type "Nope"/)
  })

  test('leading comments: printed before the node, in parens where it starts its parent', () => {
    const c = (value: string, kind = 'Block') => ({ type: 'Comment', kind, value })
    const id = (name: string, comments?: object[]) => ({ type: 'Identifier', name, comments })
    const pure = { type: 'CallExpression', callee: id('f'), arguments: [], optional: false, comments: [c(' @__PURE__ ')] }
    const decl = {
      type: 'VariableDeclaration',
      kind: 'const',
      declarations: [{ type: 'VariableDeclarator', id: id('x'), init: pure }],
    }
    assert.equal(emit(decl), 'const x = /* @__PURE__ */ f()')
    assert.equal(emit({ type: 'BinaryExpression', operator: '+', left: id('a', [c(' c ')]), right: id('b') }), '(/* c */ a) + b')
    assert.equal(emit({ type: 'ExpressionStatement', expression: pure }), '(/* @__PURE__ */ f())')
  })

  test('a Line comment cannot lead a node', () => {
    const ast = { type: 'Identifier', name: 'a', comments: [{ type: 'Comment', kind: 'Line', value: ' c' }] }
    assert.throws(() => emit(ast), /a Line comment can't lead Identifier/)
  })
})

// ---------------------------------------------------------------------------
// Round trip: printing doesn't change the tree, and the output is a fixed point.

const SRC = fileURLToPath(new URL('..', import.meta.url))
const filesIn = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesIn(join(dir, e.name)) : /\.(js|jsx|ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : [],
  )

describe('emit: round trip', () => {
  for (const file of filesIn(SRC)) {
    test(relative(SRC, file), () => {
      const filename = file.replaceAll('\\', '/')
      const ast = read(readFileSync(file, 'utf8'), { filename })
      const out = emit(ast)
      const again = read(out, { filename })
      assert.deepEqual(again, ast, 'read(emit(ast)) must equal ast')
      assert.equal(emit(again), out, 'emit must be a fixed point')
    })
  }
})
