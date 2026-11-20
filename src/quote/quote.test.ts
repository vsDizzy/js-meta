import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { emit, emitWithMap } from '../emit/index.ts'
import { walk } from '../ast/walk.ts'
import { read } from '../read/index.ts'
import { js, match, rule, rules } from './index.ts'

const print = (n: unknown): string => (Array.isArray(n) ? n.map(print).join('\n') : emit(n as never).trimEnd())

describe('js: grammar', () => {
  test('an expression first, else one statement, js.stmt / js.stmts when it matters', () => {
    assert.equal(js`a + 1`.type, 'BinaryExpression')
    assert.equal(js`{ a }`.type, 'ObjectExpression')
    assert.equal(js`function f() {}`.type, 'FunctionExpression')
    assert.equal(js`if (a) b()`.type, 'IfStatement')
    assert.equal(js`import x from './x.js'`.type, 'ImportDeclaration')
    assert.equal(js.stmt`{ a }`.type, 'BlockStatement')
    assert.equal(js.stmt`function f() {}`.type, 'FunctionDeclaration')
    assert.deepEqual(js.stmts`a; let b = 1`.map((n) => n.type), ['ExpressionStatement', 'VariableDeclaration'])
    assert.throws(() => js`a; b`, /several statements .*: use js\.stmts/)
  })

  test('syntax errors show the template', () => {
    assert.throws(() => js`f(${1}`, /in js`f\(\$\{…\}`/)
  })

  test('parsed once per call site; results have no origin', () => {
    const f = (x: unknown) => js`g(${x})`
    const a = f(1)
    const b = f(2)
    assert.equal(a.callee, b.callee, 'untouched subtrees are shared')
    assert.equal(print(b), 'g(2)')
  })
})

describe('js: values by position', () => {
  const x = js`x`
  test('nodes, and primitives as literals', () => {
    assert.equal(print(js`${x} + ${1} + ${'s'} + ${true} + ${null} + ${-2} + ${10n} + ${/r/g}`), "x + 1 + 's' + true + null + -2 + 10n + /r/g")
    assert.equal(print(js`${"it's"}`), "'it\\'s'")
    assert.equal(print(js`f(${js.id('name')})`), 'f(name)')
  })

  test('arrays splice into lists', () => {
    const args = [js`a`, js`b`]
    assert.equal(print(js`f(${args}, c)`), 'f(a, b, c)')
    assert.equal(print(js`[${[]}]`), '[]')
    assert.equal(print(js`(${args}) => 0`), '(a, b) => 0')
    assert.equal(print(js`() => { ${[js`a()`, js.stmt`let b`]} }`), '() => {\n  a()\n  let b\n}')
    assert.equal(print(js`({ ${[(js`{ a: 1 }`.properties as any)[0], 'b']}, c })`), '{ a: 1, b, c }')
    assert.equal(print(js`class { ${(js`class { m() {} }`.body as any).body} }`), 'class {\n  m() {}\n}')
    assert.equal(print(js`<a>{${[js`<b />`, 'text']}}</a>`), "<a><b />{'text'}</a>")
  })

  test('strings are names where only a name goes', () => {
    assert.equal(print(js.stmt`function ${'f'}(${'a'}) { let ${'b'} = ${'b'} }`), "function f(a) {\n  let b = 'b'\n}")
    assert.equal(print(js`o.${'key'} + o.${'my-key'} + o.${js`k`} + o.${js`k + 1`}`), "o.key + o['my-key'] + o.k + o[k + 1]")
    assert.equal(print(js`({ ${'my-key'}: 1, ${js`k + 1`}: 2 })`), "{ 'my-key': 1, [k + 1]: 2 }")
    assert.equal(print(js`<${'Box'} />`), '<Box />')
  })

  test('nodes adapt: expressions become statements, functions become declarations', () => {
    assert.equal(print(js.stmts`${x}; ${js`function f() {}`}`), 'x\nfunction f() {}')
    assert.equal(print(js`[${js.stmt`function g() {}`}]`), '[function g() {}]')
    assert.equal(print(js`if (a) ${js`b()`}`), 'if (a) b()')
  })

  test('leading comments stay on their node; a hole passes its comments to the value', () => {
    const pure = js`/* @__PURE__ */ f()`
    assert.equal(pure.type, 'CallExpression')
    assert.deepEqual((pure.comments as any[]).map((c) => c.value), [' @__PURE__ '])
    assert.equal(print(js`const x = ${pure}`), 'const x = /* @__PURE__ */ f()')
    assert.equal(print(js`const x = /* @__PURE__ */ ${js`g()`}`), 'const x = /* @__PURE__ */ g()')
    assert.equal(print(js`if (/* why */ ${x}) y()`), 'if (/* why */ x) y()')
    assert.deepEqual(emitWithMap(pure).map.sources, [], 'template comments have no origin either')
  })

  test('mistakes are errors that name the hole', () => {
    assert.throws(() => js`f(${undefined})`, /\$\{\} #1 in js`f\(\$\{…\}\)` is undefined/)
    assert.throws(() => js`a + ${[x]}`, /is an array, but it stands where a single node goes/)
    assert.throws(() => js`a + ${js`if (a) b`}`, /IfStatement can't stand where an expression goes/)
    assert.throws(() => js`a + ${{ b: 1 }}`, /is an object, not a node/)
    assert.throws(() => js`'hi ${'x'}'`, /inside a string/)
  })
})

describe('match', () => {
  test('variables capture, literals and layout do not matter, repeats must agree', () => {
    const m = match(js`foo(1) + 0x2`, js`$a + 2`)
    assert.equal(print(m!.a), 'foo(1)')
    assert.equal(match(js`a - 2`, js`$a + 2`), null)
    assert.ok(match(js`f(x) * f(x)`, js`$a * $a`))
    assert.equal(match(js`f(x) * f(y)`, js`$a * $a`), null)
    assert.deepEqual(match(js`a`, js`$_`), {})
  })

  test('sequences in lists, with backtracking', () => {
    const m = match(js`f(1, 2, 3)`, js`f($$init, $last)`)!
    assert.equal(print(m.init), '1\n2')
    assert.equal(print(m.last), '3')
    assert.deepEqual(match(js`f()`, js`f($$args)`), { args: [] })
    const body = match(js.stmt`function g(a) { /* c */ log(a); return a }`, js.stmt`function $name($$params) { $$body; return $r }`)!
    assert.equal(print(body.name), 'g')
    assert.equal(print(body.body), 'log(a)')
    assert.equal(match(js.stmts`a(); b()`, js.stmts`$$_; b()`) !== null, true)
  })

  test('wrapper forms: properties, members, JSX children, names', () => {
    assert.equal(print(match(js`({ a: 1, ...b })`, js`({ $$props })`)!.props), 'a: 1\n...b')
    assert.equal(print(match(js`<a><b />text</a>`, js`<a>{$$kids}</a>`)!.kids), '<b />\ntext')
    assert.equal(print(match(js`<Box x={1} />`, js`<$C x={1} />`)!.C), 'Box')
    assert.equal(print(match(js`o.prop`, js`o.$p`)!.p), 'prop')
  })

  test('leading comments are ignored, on either side', () => {
    assert.equal(print(match(read('x = /* @__PURE__ */ f(1)').body[0], js`x = f($a)`)!.a), '1')
    assert.ok(match(js`f(1)`, js`/* any */ f($a)`))
    assert.ok(match(read('if (/* c */ a) b()').body[0], js`if (a) $_`))
  })

  test('expression patterns match expression statements; declarations match expressions', () => {
    assert.ok(match(read('f(1)').body[0], js`f($x)`))
    assert.ok(match(read('function f() {}').body[0], js`function $f() {}`))
  })

  test('a rewrite rule: match + js in walk, mapped to the call site', () => {
    const ast = read('const r = add(1, 2) + add(x, add(y, 3))')
    const out = walk(ast, {
      leave(node) {
        const m = match(node, js`add($a, $b)`)
        if (m) return js`(${m.a} + ${m.b})`
      },
    })
    assert.equal(print(out), 'const r = 1 + 2 + (x + (y + 3))')
  })
})

describe('rule', () => {
  test('a template replacement with the same variables; nested forms expand outer first', () => {
    const ast = read('const r = add(1, 2) + add(x, add(y, 3))')
    assert.equal(print(walk(ast, rule(js`add($a, $b)`, js`($a + $b)`))), 'const r = 1 + 2 + (x + (y + 3))')
  })

  test('rules: first that fires wins; a macro may expand into another; null removes', () => {
    const order: string[] = []
    const ast = read('log(1)\nconst v = twice(inc(n))\nlog(v)')
    const out = walk(
      ast,
      rules(
        rule(js`log($$_)`, null),
        rule(js`twice($x)`, (m) => (order.push('twice'), js`[${m.x}, ${m.x}]`)),
        rule(js`inc($x)`, (m) => (order.push('inc'), js`plus(${m.x}, 1)`)),
        rule(js`plus($a, $b)`, js`$a + $b`),
      ),
    )
    assert.equal(print(out), 'const v = [n + 1, n + 1]')
    assert.deepEqual(order, ['twice', 'inc', 'inc'], 'outer first; the capture expands in each place it is put')
  })

  test('a function may pass; replacements map to the call site', () => {
    const ast = read('f(1)\nf(2)', { filename: 'http://x/m.js' })
    const out = walk(ast, rule(js`f($n)`, (m) => (m.n.value === 2 ? js`g()` : undefined)))!
    assert.equal(print(out), 'f(1)\ng()')
    const { map } = emitWithMap(out)
    assert.ok(map.mappings.includes(';'), 'the second line is mapped')
  })

  test('the leading comments of a form go to its expansion, once', () => {
    assert.equal(print(walk(read('x = /* why */ add(1, 2)'), rule(js`add($a, $b)`, js`$a + $b`))), 'x = /* why */ 1 + 2')
    const chain = rules(rule(js`inc($x)`, js`plus($x, 1)`), rule(js`plus($a, $b)`, js`$a + $b`))
    assert.equal(print(walk(read('v = /* why */ inc(n)\nif (a) /* s */ inc(m)'), chain)), 'v = /* why */ n + 1\nif (a) /* s */ m + 1')
    // A capture as the whole replacement is copied, not changed.
    const ast = read('x = /* why */ id(y)\nz = [id(y), id(y)]')
    const y = (ast.body[0] as any).expression.right.arguments[0]
    assert.equal(print(walk(ast, rule(js`id($a)`, js`$a`))), 'x = /* why */ y\nz = [y, y]')
    assert.ok(!('comments' in y))
    // A template with its own leading comments keeps them.
    assert.equal(print(walk(read('x = /* why */ f()'), rule(js`f()`, js`/* @__PURE__ */ g()`))), 'x = /* @__PURE__ */ g()')
  })

  test('mistakes: an uncaptured variable, a rule that never settles', () => {
    assert.throws(() => walk(read('f(1)'), rule(js`f($a)`, js`g($b)`)), /\$b in a replacement is not captured/)
    assert.throws(() => walk(read('f(1)'), rule(js`f($a)`, js`f(f($a))`)) && 0, /keep firing/)
  })
})
