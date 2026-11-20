import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { emit } from '../emit/index.ts'
import { read } from '../read/index.ts'
import { b, define, edit, Node, originOf, slotsOf, toEstree, toNode, walk, type Ctx } from './index.ts'

const js = (src: string, filename?: string) => read(src, { filename })
const expr = (src: string) => (js(src).body[0] as any).expression as Node
const names = (list: unknown) => (list as any[]).map((n) => n?.name ?? n?.type ?? null)

const SRC = fileURLToPath(new URL('..', import.meta.url))
const filesIn = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesIn(join(dir, e.name)) : /\.(js|jsx|ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : [],
  )
const corpus = filesIn(SRC).map((file) => ({
  name: relative(SRC, file),
  ast: read(readFileSync(file, 'utf8'), { filename: file.replaceAll('\\', '/') }),
}))

describe('node form', () => {
  test('{ type, ...attrs, children } with named accessors', () => {
    const n = expr('a + b') as any
    assert.deepEqual(JSON.parse(JSON.stringify(n)), {
      type: 'BinaryExpression',
      operator: '+',
      children: [
        { type: 'Identifier', name: 'a', optional: false, children: [[], null] },
        { type: 'Identifier', name: 'b', optional: false, children: [[], null] },
      ],
    })
    assert.equal(n.left, n.children[0])
    assert.equal(n.right.name, 'b')
    assert.equal(n.constructor.name, 'BinaryExpression')
    assert.ok(n instanceof Node)
  })

  test('JSX children are `content`', () => {
    const el = expr('<a>x</a>') as any
    assert.equal(el.content[0].type, 'JSXText')
    assert.equal(el.content, el.children[1])
  })

  test('setters throw outside edit', () => {
    const n = expr('a + b') as any
    assert.throws(() => (n.left = b.Identifier({ name: 'c' })), /immutable.*edit\(/)
  })

  test('toNode accepts ESTree and plain form; toEstree goes back', () => {
    const estree = { type: 'BinaryExpression', operator: '*', left: { type: 'Identifier', name: 'x' }, right: { type: 'Literal', value: 2, raw: '2' } }
    const plain = { type: 'BinaryExpression', operator: '*', children: [{ type: 'Identifier', name: 'x', children: [] }, { type: 'Literal', value: 2, raw: '2' }] }
    assert.equal(emit(toNode(estree)), 'x * 2')
    assert.equal(emit(toNode(plain)), 'x * 2')
    assert.deepEqual(toNode(estree), toNode(plain))
    assert.deepEqual(toEstree(toNode(estree)), { ...estree, left: { ...estree.left, decorators: null, typeAnnotation: null } })
  })

  test('builders', () => {
    const sum = b.BinaryExpression({ operator: '+', left: b.Identifier({ name: 'a' }), right: { type: 'Literal', value: 1 } })
    assert.equal(emit(sum), 'a + 1')
  })

  test('leading comments: `comments` is an attribute of Comment nodes, in every shape', () => {
    const pure = () => b.Comment({ kind: 'Block', value: ' @__PURE__ ' })
    const f = b.Identifier({ name: 'f', optional: false, decorators: [] })
    const call = b.CallExpression({ callee: f, arguments: [], optional: false, comments: [pure()] })
    assert.equal(emit(call), '/* @__PURE__ */ f()')
    assert.deepEqual(call.children.length, 3, 'not a slot')
    const read = (expr('x = /* @__PURE__ */ f()') as any).right
    assert.deepEqual(call, read)
    // Plain form, ESTree form and back.
    const plain = JSON.parse(JSON.stringify(call))
    assert.deepEqual(plain.comments, [{ type: 'Comment', kind: 'Block', value: ' @__PURE__ ', children: [] }])
    assert.deepEqual(toNode(plain), call)
    assert.ok((toNode(plain).comments as Node[])[0] instanceof Node)
    assert.deepEqual(toEstree(call).comments, [{ type: 'Comment', kind: 'Block', value: ' @__PURE__ ' }])
    assert.deepEqual(toNode(toEstree(call)), call)
    // None is no attr at all, so trees built either way compare equal.
    assert.ok(!('comments' in b.Identifier({ name: 'a', comments: [] })))
    assert.ok(!('comments' in toNode({ type: 'Identifier', name: 'a', comments: null, children: [] })))
    assert.throws(() => b.Identifier({ name: 'a', comments: [b.Identifier({ name: 'x' })] }), /comments: a list of Comment nodes/)
  })

  test('define a new node type', () => {
    define('Unless', ['test', 'body'])
    const u = toNode({ type: 'Unless', test: { type: 'Identifier', name: 'x' }, body: { type: 'BlockStatement', body: [] } }) as any
    assert.equal(u.test.name, 'x')
    assert.deepEqual(slotsOf('Unless'), ['test', 'body'])
    assert.throws(() => define('Unless', []), /already defined/)
  })

  test('unknown type: plain form works, ESTree form with children asks for define()', () => {
    const n = toNode({ type: 'Mystery', level: 1, children: [{ type: 'Identifier', name: 'q' }] })
    assert.equal((n.children[0] as any).name, 'q')
    assert.throws(() => toNode({ type: 'Mystery2', x: { type: 'Identifier', name: 'q' } }), /define\(\)/)
  })

  describe('ESTree round trip and slot order on the corpus', () => {
    /** Lists that pair up positionally (quasis/expressions) aren't in source order. */
    const UNORDERED = new Set(['TemplateLiteral', 'TSTemplateLiteralType'])
    for (const { name, ast } of corpus) {
      test(name, () => {
        assert.deepEqual(toNode(toEstree(ast)), ast)
        walk(ast, (node) => {
          if (UNORDERED.has(node.type)) return
          let last = -1
          for (const slot of node.children) {
            for (const child of Array.isArray(slot) ? slot : [slot]) {
              // Comments stand before their owner by rule, not by position.
              if (child?.type === 'Comment') continue
              const start = child && originOf(child)?.start
              if (start === undefined || start === null) continue
              assert.ok(start >= last, `${node.type}: children out of source order`)
              last = start
            }
          }
        })
      })
    }
  })
})

describe('edit', () => {
  test('mutate a draft, get a new tree; untouched parts are shared', () => {
    const ast = js('a + b\nc()')
    const next = edit(ast, (d: any) => {
      d.body[0].expression.left = b.Identifier({ name: 'x' })
    })
    assert.equal(emit(next), 'x + b\nc()\n')
    assert.equal(emit(ast), 'a + b\nc()\n', 'original untouched')
    assert.notEqual(next, ast)
    assert.equal(next.body[1], ast.body[1], 'sibling shared')
    assert.equal((next.body[0] as any).expression.right, (ast.body[0] as any).expression.right)
  })

  test('nothing changed: the same tree back', () => {
    const ast = js('a + b')
    assert.equal(edit(ast, (d: any) => void d.body[0].expression.left), ast)
  })

  test('attrs and lists', () => {
    const ast = js('f(a)')
    const next = edit(ast, (d: any) => {
      d.body[0].expression.arguments.push({ type: 'Identifier', name: 'b' })
      d.body.unshift(b.ExpressionStatement({ expression: b.Identifier({ name: 'first' }) }))
    })
    assert.equal(emit(next), 'first\nf(a, b)\n')
    assert.equal(emit(edit(js('a + b'), (d: any) => void (d.body[0].expression.operator = '-'))), 'a - b\n')
  })

  test('the function may return a replacement', () => {
    const ast = js('a')
    assert.equal(emit(edit(ast, () => js('b'))), 'b\n')
  })

  test('copies keep the origin', () => {
    const src = 'a + b'
    const ast = js(src)
    const next = edit(ast, (d: any) => void (d.body[0].expression.operator = '*'))
    const o = originOf((next.body[0] as any).expression)!
    assert.equal(src.slice(o.start, o.end), 'a + b')
  })

  test('drafts are only writable inside edit', () => {
    let leaked: any
    edit(js('a'), (d: any) => void (leaked = d.body[0]))
    assert.throws(() => (leaked.expression = null), /immutable/)
  })

  test('leading comments: changed on the draft only; unchanged stays shared', () => {
    const ast = js('x = /* a */ y')
    const right = () => (ast.body[0] as any).expression.right
    const next = edit(ast, (d: any) => {
      const r = d.body[0].expression.right
      r.comments.push(b.Comment({ kind: 'Block', value: ' b ' }))
      r.comments[0].value = ' A '
    })
    assert.equal(emit(next), 'x = /* A */ /* b */ y\n')
    assert.equal(emit(ast), 'x = /* a */ y\n', 'original untouched')
    assert.equal(edit(ast, (d: any) => void d.body[0].expression.right.comments[0].value), ast)
    const none = edit(ast, (d: any) => void (d.body[0].expression.right.comments = []))
    assert.ok(!('comments' in (none.body[0] as any).expression.right), 'emptied: no attr')
    assert.equal(right().comments.length, 1)
  })
})

describe('walk', () => {
  test('source order, comments included', () => {
    const seen: string[] = []
    walk(js('// c\nf(a, b)'), (n) => void seen.push((n as any).name ?? n.type))
    assert.deepEqual(seen, ['Program', 'Comment', 'ExpressionStatement', 'CallExpression', 'f', 'a', 'b'])
  })

  test('visitor by type, alias, enter and leave order', () => {
    const log: string[] = []
    walk(js('function f() { return () => 1 }'), {
      enter: (n) => void (n.type.endsWith('Expression') && log.push('enter ' + n.type)),
      Function: { enter: (n) => void log.push('fn ' + n.type), leave: (n) => void log.push('/fn ' + n.type) },
      ArrowFunctionExpression: { leave: () => void log.push('/arrow') },
    })
    assert.deepEqual(log, [
      'fn FunctionDeclaration',
      'enter ArrowFunctionExpression',
      'fn ArrowFunctionExpression',
      '/arrow',
      '/fn ArrowFunctionExpression',
      '/fn FunctionDeclaration',
    ])
  })

  test('ctx: parent, key, index, siblings, ancestors', () => {
    const ctxs: Record<string, Ctx> = {}
    walk(js('f(a, /* c */ b)'), { Identifier: (n, ctx) => void (ctxs[(n as any).name] = ctx) })
    const { a, b: bb, f } = ctxs
    assert.equal(f.key, 'callee')
    assert.equal(f.index, null)
    assert.equal(a.key, 'arguments')
    assert.equal(a.index, 0)
    assert.equal(a.prev, null)
    assert.equal(bb.prev?.type, 'Comment')
    assert.equal(bb.parent?.type, 'CallExpression')
    assert.deepEqual(names(bb.ancestors), ['Program', 'ExpressionStatement', 'CallExpression'])
  })

  test('nothing returned: the same tree', () => {
    const ast = js('a + b')
    assert.equal(walk(ast, () => {}), ast)
  })

  test('leave: postwalk constant folding', () => {
    const folded = walk(js('x = 1 + 2 * 3'), {
      BinaryExpression: {
        leave: (n: any) => {
          const { left, right } = n
          if (left.type !== 'Literal' || right.type !== 'Literal') return
          const value = n.operator === '+' ? left.value + right.value : left.value * right.value
          return { type: 'Literal', value, raw: String(value) }
        },
      },
    })!
    assert.equal(emit(folded), 'x = 7\n')
  })

  test('enter: prewalk expands nested replacements without re-entering', () => {
    // twice(x) -> [x, x]; nested calls expand too.
    let entered = 0
    let arraysEntered = 0
    const out = walk(js('twice(twice(1))'), {
      enter: (n) => void (n.type === 'ArrayExpression' && arraysEntered++),
      CallExpression: (n: any) => {
        entered++
        if (n.callee.name !== 'twice') return
        const arg = n.arguments[0]
        return b.ArrayExpression({ elements: [arg, arg] })
      },
    })!
    assert.equal(emit(out), '[[1, 1], [1, 1]]\n')
    assert.equal(entered, 3, 'outer once, inner in both of its places')
    assert.equal(arraysEntered, 0, 'replacements are not entered again')
  })

  test('null removes from a list; skip() keeps children unvisited', () => {
    const out = walk(js('// drop\na()\nb()'), { Comment: () => null })!
    assert.equal(emit(out), 'a()\nb()\n')
    const seen: string[] = []
    walk(js('f(a)'), { CallExpression: (_, ctx) => ctx.skip(), Identifier: (n: any) => void seen.push(n.name) })
    assert.deepEqual(seen, [])
  })

  test('leading comments: visited after the owner enters, before its children', () => {
    const seen: string[] = []
    walk(js('x = /* a */ /* b */ f(y)'), (n) => void seen.push((n as any).name ?? (n.type === 'Comment' ? `/*${n.value}*/` : n.type)))
    assert.deepEqual(seen, ['Program', 'ExpressionStatement', 'AssignmentExpression', 'x', 'CallExpression', '/* a */', '/* b */', 'f', 'y'])
    const ctxs: Ctx[] = []
    walk(js('x = /* a */ /* b */ f(y)'), { Comment: (_, ctx) => void ctxs.push(ctx) })
    const [a, bb] = ctxs
    assert.equal(a.parent?.type, 'CallExpression')
    assert.equal(a.key, 'comments')
    assert.deepEqual([a.index, bb.index], [0, 1])
    assert.equal(a.prev, null)
    assert.equal((a.next as any).value, ' b ')
    assert.equal((bb.prev as any).value, ' a ')
    assert.deepEqual(names(bb.ancestors), ['Program', 'ExpressionStatement', 'AssignmentExpression', 'CallExpression'])
  })

  test('leading comments: replace, remove, and sharing', () => {
    const ast = js('x = /* a */ /* b */ f(y)\ng()')
    const text = (n: Node) => emit(n!)
    const upper = walk(ast, { Comment: (n: any) => (n.value === ' a ' ? b.Comment({ kind: 'Block', value: ' A ' }) : undefined) }) as any
    assert.equal(text(upper), 'x = /* A */ /* b */ f(y)\ng()\n')
    assert.equal(upper.body[1], ast.body[1], 'untouched statement shared')
    assert.equal(text(walk(ast, { Comment: (n: any) => (n.value === ' a ' ? null : undefined) })!), 'x = /* b */ f(y)\ng()\n')
    const none = walk(ast, { Comment: () => null }) as any
    assert.ok(!('comments' in (none.body[0] as any).expression.right), 'emptied: no attr')
    assert.equal(text(none), 'x = f(y)\ng()\n')
    assert.equal(walk(ast, () => {}), ast, 'nothing changed: the same tree')
  })

  test('a replacement keeps the leading comments of the node it replaces, on a copy', () => {
    const ast = js('x = /* why */ f(y)', 'http://x/m.js')
    const call = (ast.body[0] as any).expression.right
    const right = (n: Node | null) => (n as any).body[0].expression.right
    // enter and leave; a shared node is copied, not changed, and the copy gets the origin
    const z = b.Identifier({ name: 'z' })
    for (const out of [walk(ast, { CallExpression: () => z }), walk(ast, { CallExpression: { leave: () => z } })]) {
      assert.equal(emit(out!), 'x = /* why */ z\n')
      assert.notEqual(right(out), z)
      assert.deepEqual(originOf(right(out)), originOf(call))
    }
    assert.ok(!('comments' in z) && !originOf(z), 'the returned node is untouched')
    // a replacement from the tree keeps its own origin
    const y = walk(ast, { CallExpression: (n: any) => n.arguments[0] })
    assert.equal(emit(y!), 'x = /* why */ y\n')
    assert.deepEqual(originOf(right(y)), originOf(call.arguments[0]))
    assert.ok(!('comments' in call.arguments[0]))
    // its own comments win; a wrapper keeps them where they are, once
    const own = b.Identifier({ name: 'z', comments: [b.Comment({ kind: 'Block', value: ' own ' })] })
    assert.equal(emit(walk(ast, { CallExpression: () => own })!), 'x = /* own */ z\n')
    const wrapped = walk(ast, { CallExpression: { leave: (n) => b.AwaitExpression({ argument: n }) } })!
    assert.equal(emit(wrapped), 'x = await /* why */ f(y)\n')
    // null removes the node and its comments
    const list = b.ArrayExpression({ elements: [b.Identifier({ name: 'a', comments: [b.Comment({ kind: 'Block', value: ' a ' })] }), b.Identifier({ name: 'b' })] })
    assert.equal(emit(walk(list, { Identifier: (n: any) => (n.name === 'a' ? null : undefined) })!), '[b]')
  })

  test('walks bare plain-form objects', () => {
    const seen: string[] = []
    walk({ type: 'Thing', children: [{ type: 'Identifier', name: 'q', children: [] }] } as unknown as Node, (n) => void seen.push(n.type))
    assert.deepEqual(seen, ['Thing', 'Identifier'])
  })
})
