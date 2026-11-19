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
    ['if (/* c */ x) y()', '/* c */\nif (x) y()'],
    ['<a>{/* c */}</a>', '<a>{/* c */}</a>'],
    ['a()\n// tail', 'a()\n// tail'],
  ])
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
