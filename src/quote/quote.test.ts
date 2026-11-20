import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { emit, emitWithMap } from '../emit/index.ts'
import { walk } from '../ast/walk.ts'
import { read } from '../read/index.ts'
import type { Node } from '../ast/node.ts'
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
    assert.equal(print(body.body), '/* c */\nlog(a)', 'a run carries its comments')
    assert.equal(match(js.stmts`a(); b()`, js.stmts`$$_; b()`) !== null, true)
  })

  test('wrapper forms: properties, members, JSX children, names', () => {
    assert.equal(print(match(js`({ a: 1, ...b })`, js`({ $$props })`)!.props), 'a: 1\n...b')
    assert.equal(print(match(js`<a><b />text</a>`, js`<a>{$$kids}</a>`)!.kids), '<b />\ntext')
    assert.equal(print(match(js`<Box x={1} />`, js`<$C x={1} />`)!.C), 'Box')
    assert.equal(print(match(js`o.prop`, js`o.$p`)!.p), 'prop')
  })

  test('comments in the target are ignored; a comment in the pattern is required', () => {
    assert.equal(print(match(read('x = /* @__PURE__ */ f(1)').body[0], js`x = f($a)`)!.a), '1')
    assert.ok(match(read('if (/* c */ a) b()').body[0], js`if (a) $_`))
    assert.equal(match(js`f(1)`, js`/* any */ f($a)`), null)
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

/** Matches the `i`th statement of `src`, with the context that gives the comments before it. */
const matchAt = (src: string, i: number, pattern: Node) => {
  const ast = read(src)
  return match(ast.body[i], pattern, { parent: ast, key: 'body', index: i })
}
const values = (cs: any[]) => cs.map((c) => c.value)

// Templates are read from their raw text, so line breaks in them are written out.
describe('comments: js', () => {
  test('comments around the root go in front of it', () => {
    assert.deepEqual(values(js`/* a */ f()`.comments as any[]), [' a '])
    assert.deepEqual(values(js`// a
      f() // b`.comments as any[]), [' a', ' b'])
    const s = js.stmt`/** doc */ function f() {}`
    assert.equal(s.type, 'FunctionDeclaration')
    assert.deepEqual(values(s.comments as any[]), ['* doc '])
    assert.deepEqual(js.stmts`/* a */ f()`.map((n) => n.type), ['Comment', 'ExpressionStatement'], 'in a list they stay siblings')
  })

  test('a value put in a list brings its comments as siblings, as read gives them', () => {
    const note = js.stmt`// note
      f()`
    const body = js.stmts`${note}; ${js`/* c */ g()`}`
    assert.deepEqual(body.map((n) => n.type), ['Comment', 'ExpressionStatement', 'Comment', 'ExpressionStatement'])
    assert.equal(print(body), '// note\nf()\n/* c */\ng()')
    const same = (a: unknown, b: unknown) => assert.equal(JSON.stringify(a), JSON.stringify(b))
    same(body, read(print(body)).body)
    assert.equal(print(js`g(${js`/* c */ a`})`), 'g(/* c */ a)')
    same(js`g(${js`/* c */ a`})`, (read('g(/* c */ a)').body[0] as any).expression)
    assert.equal(print(js`if (a) ${js`/* c */ f()`}`), 'if (a) /* c */ f()', 'elsewhere the statement leads with them')
  })

  test('a comment that is just a hole stands for comments', () => {
    const [hi, there] = read('/* hi */ /* there */ x').body
    assert.equal(print(js`x = /* ${hi} */ f()`), 'x = /* hi */ f()')
    assert.equal(print(js`f(/* ${[hi, there]} */ a, /* ${[]} */ b)`), 'f(/* hi */ /* there */ a, b)')
    assert.equal(print(js`f(${[hi, js`a`]})`), 'f(/* hi */ a)', 'a comment in an array stays a comment in a list')
    assert.throws(() => js`/* see ${1} */ f()`, /a \$\{\} inside a comment/)
    assert.throws(() => js`/* ${1} */ f()`, /\$\{\} #1 .* stands for a comment, but it is number/)
    assert.throws(() => js`x = ${hi}`, /is a Comment: it goes in a list/)
  })
})

describe('comments: match', () => {
  const pure = js`x = /* @__PURE__ */ $call`
  test('a literal comment: same kind and trimmed text, among others', () => {
    assert.equal(print(match(read('x = /*@__PURE__*/ f()').body[0], pure)!.call), '/*@__PURE__*/ f()')
    assert.ok(match(read('x = /* a */ /* @__PURE__ */ f()').body[0], pure))
    assert.equal(match(read('x = f()').body[0], pure), null)
    assert.equal(match(read('x = /* other */ f()').body[0], pure), null)
    const note = js`// note
      f()`
    assert.ok(matchAt('// note\nf()', 1, note))
    assert.equal(matchAt('/* note */ f()', 1, note), null, 'Line and Block differ')
  })

  test('variables: /* $c */ any one, /** $doc */ JSDoc only, /* $$cs */ all', () => {
    assert.equal(match(read('x = /* hi */ f()').body[0], js`x = /* $c */ $_`)!.c.value, ' hi ')
    assert.equal(matchAt('// hi\nf()', 1, js`/* $c */ f()`)!.c.kind, 'Line', 'a variable takes any kind')
    assert.equal(match(read('x = f()').body[0], js`x = /* $c */ $_`), null)
    assert.equal(match(read('x = /* no */ f()').body[0], js`x = /** $doc */ $_`), null)
    assert.equal(match(read('x = /* no */ /** yes */ f()').body[0], js`x = /** $doc */ $_`)!.doc.value, '* yes ')
    assert.deepEqual(values(match(read('x = /* a */ /* b */ f()').body[0], js`x = /* $$cs */ $_`)!.cs), [' a ', ' b '])
    assert.deepEqual(match(read('x = f()').body[0], js`x = /* $$cs */ $_`)!.cs, [])
    assert.deepEqual(match(read('x = /* a */ f()').body[0], js`x = /* $_ */ /* $$_ */ $_`), {})
  })

  test('several: in order; a $$ variable takes its gap', () => {
    const ab = js`x = /* a */ /* b */ $_`
    assert.ok(match(read('x = /* a */ /* z */ /* b */ f()').body[0], ab))
    assert.equal(match(read('x = /* b */ /* a */ f()').body[0], ab), null)
    const m = match(read('x = /* p */ /* @__PURE__ */ /* q */ /* r */ f()').body[0], js`x = /* $$pre */ /* @__PURE__ */ /* $$post */ $_`)!
    assert.deepEqual([values(m.pre), values(m.post)], [[' p '], [' q ', ' r ']])
    assert.ok(match(read('x = /* a */ f(/* a */ 1)').body[0], js`x = /* $c */ f(/* $c */ $_)`), 'a repeated comment must be equal')
    assert.equal(match(read('x = /* a */ f(/* b */ 1)').body[0], js`x = /* $c */ f(/* $c */ $_)`), null)
  })

  test('in lists: before an element, and at the end', () => {
    assert.ok(match(js`f(/* a */ x, y)`, js`f(/* a */ $x, $y)`))
    assert.equal(match(js`f(x, /* a */ y)`, js`f(/* a */ $x, $y)`), null)
    const end = read('{\n  f()\n  // end\n}').body[0]
    assert.ok(match(read('{\n  f()\n  // other\n  // end\n}').body[0], end))
    assert.equal(match(read('{ f() }').body[0], end), null)
    assert.equal(match(read('{\n  // end\n  f()\n}').body[0], end), null, 'in front of an element is not at the end')
  })

  test('at the root, the comments before the node in its list come from the context', () => {
    const doc = js`/** $doc */ function $f() {}`
    const fn = read('/** Does f. */\nfunction f() {}').body[1]
    assert.equal(match(fn, doc), null, 'the node alone has no comments')
    assert.equal(matchAt('/** Does f. */\nfunction f() {}', 1, doc)!.doc.value, '* Does f. ')
    assert.equal(match(fn, doc, { before: [read('/** Other. */ x').body[0]] })!.doc.value, '* Other. ')
    const found: string[] = []
    walk(read('/** One. */\nfunction one() {}\nfunction two() {}'), (node, ctx) => {
      const m = match(node, doc, ctx)
      if (m) found.push(m.f.name)
    })
    assert.deepEqual(found, ['one'])
    // An expression pattern on its statement: the comment is the statement's sibling.
    assert.ok(matchAt('/* @__PURE__ */ f()', 1, js`/* @__PURE__ */ f()`))
    assert.ok(match(read('(/* @__PURE__ */ f())').body[0], js`/* @__PURE__ */ f()`))
  })
})

describe('comments: $$ runs', () => {
  const block = (m: any, name: string) => print(m[name])
  test('a run is the slice of the list, comments included', () => {
    const src = read('{\n  /* a */ x()\n  // b\n  y()\n  // end\n}').body[0]
    const all = match(src, js.stmt`{ $$body }`)!
    assert.equal(block(all, 'body'), '/* a */\nx()\n// b\ny()\n// end', 'a last run takes the trailing comments')
    const split = match(src, js.stmt`{ $$init; $last }`)!
    assert.equal(block(split, 'init'), '/* a */\nx()', 'the comments in front of $last are its own')
    assert.equal(block(split, 'last'), 'y()')
    const front = match(src, js.stmt`{ $$init; /* $$c */ $last }`)!
    assert.deepEqual(values(front.c), [' b'])
    const end = match(src, js.stmt`{ $$body
      /* $$end */
    }`)!
    assert.deepEqual([block(end, 'body'), values(end.end)], ['/* a */\nx()\n// b\ny()', [' end']])
  })

  test('a repeated run compares code only', () => {
    assert.ok(match(js`f([/* c */ 1, 2], [1, 2])`, js`f([$$a], [$$a])`))
  })

  test('a rule { $$body } -> { $$body } keeps the comments', () => {
    const toArrow = rule(js`function $f($$p) { $$body }`, js`const $f = ($$p) => { $$body }`)
    const out = walk(read('function f(a) {\n  // first\n  a()\n  /* x */ b()\n  // end\n}'), toArrow)!
    assert.equal(print(out), 'const f = (a) => {\n  // first\n  a()\n  /* x */\n  b()\n  // end\n}')
  })
})

describe('comments: replacements', () => {
  test('/* $c */ puts the captured comment, /* $$cs */ the captured ones; literal comments stay', () => {
    const swap = rule(js`swap(/* $c */ $a, /* $$cs */ $b)`, js`[/* $$cs */ $b, /* $c */ /* literal */ $a]`)
    assert.equal(print(walk(read('x = swap(/* one */ a, /* two */ /* three */ b)'), swap)), 'x = [/* two */ /* three */ b, /* one */ /* literal */ a]')
    const lead = rule(js`f(/* $c */ $a)`, js`g(/* $c */ $a, /* $c */ $a)`)
    assert.equal(print(walk(read('f(/* c */ 1)'), lead)), 'g(/* c */ 1, /* c */ 1)')
    assert.throws(() => walk(read('x = /* c */ f()'), rule(js`x = /* $c */ $f`, js`x = /* $f */ 1`)), /\$f .* stands for a comment, but it is a CallExpression/)
  })

  test('a rule that adds /* @__PURE__ */ in front of calls, round-tripping through emit', () => {
    const isPure = (c: any) => c.value.trim() === '@__PURE__'
    const pure = rule(js`/* $$cs */ h($$args)`, (m) => (m.cs.some(isPure) ? undefined : js`/* ${m.cs} */ /* @__PURE__ */ h(${m.args})`))
    const out = walk(read('const a = h(1)\nconst b = /* why */ h(2, /* x */ 3)\nconst c = /* @__PURE__ */ h(4)\nh(5)'), pure)!
    const code = emit(out)
    assert.equal(code.trimEnd(), 'const a = /* @__PURE__ */ h(1)\nconst b = /* why */ /* @__PURE__ */ h(2, /* x */ 3)\nconst c = /* @__PURE__ */ h(4)\n;(/* @__PURE__ */ h(5))')
    assert.equal(emit(read(code)), code)
  })

  test('a JSDoc comment captured and moved', () => {
    const toFunction = rule(js.stmt`const $f = /** $doc */ ($$params) => $body`, js.stmt`/** $doc */ function $f($$params) { return $body }`)
    const code = emit(walk(read('const add = /** Adds. */ (a, b) => a + b'), toFunction)!)
    assert.equal(code.trimEnd(), '/** Adds. */ function add(a, b) {\n  return a + b\n}')
    const back = read(code)
    const m = match(back.body[1], js`/** $doc */ function $f($$p) { $$body }`, { before: [back.body[0]] })!
    assert.deepEqual([m.doc.value, m.f.name], ['* Adds. ', 'add'])
  })

  test('comments before the node in its list stay there, once', () => {
    const toConst = rule(js`/** $doc */ function $f($$p) { $$body }`, js`/** $doc */ const $f = ($$p) => { $$body }`)
    const out = walk(read('/** Does f. */\nfunction f() {}\nfunction g() {}'), toConst)!
    assert.equal(print(out), '/** Does f. */\nconst f = () => {}\n\nfunction g() {}', 'only a function with JSDoc changes')
    const keep = rule(js`/* $$cs */ f($a)`, js`/* $$cs */ g($a)`)
    assert.equal(print(walk(read('/* keep */ f(1)\nx = /* why */ f(2)'), keep)), '/* keep */\ng(1)\nx = /* why */ g(2)')
  })
})
