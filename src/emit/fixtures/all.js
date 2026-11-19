'use strict'
// Kitchen sink for round-trip tests (JavaScript).
import def, { a as b, c } from './x.js'
import * as ns from './y.js'
import './side-effect.js'
import data from './data.json' with { type: 'json' }
export { b as bee, c }
export * from './z.js'
export * as zz from './z.js'
export default function main() {}
export const answer = 42, other = 'x'

/** JSDoc block */
async function* gen(a, b = 1, ...rest) {
  yield a
  yield* rest
  await b
  for await (const x of rest) console.log(x)
}

const obj = {
  a: 1, // trailing
  'b-c': 2,
  [k]: 3,
  short,
  m() {},
  get g() { return 1 },
  set s(v) {},
  async *ag() {},
  ...spread,
}
const { p, q: { r = 2 }, ...others } = obj
const [x, , y = 3, ...zs] = arr
const holes = [, 1, , 2, ,]

label: for (let i = 0, j = 10; i < j; i++, j--) {
  if (i % 2) continue label
  else if (i > 5) break label
  else {
    // comment in else
  }
}
for (const key in obj) if (key) delete obj[key]
for (;;) break
while (x) x--
do x++
while (x < 10)
do {
  y--
} while (y)

switch (x) {
  case 1:
  case 2:
    y = 1
    break
  case 3: {
    y = 2
    break
  }
  default:
    y = 0
}

try {
  risky()
} catch (e) {
  throw new Error(`failed: ${e.message}`, { cause: e })
} finally {
  done()
}
try {} catch {}

class Base {}
class Animal extends Base {
  static count = 0
  #secret = 1
  name
  static {
    Animal.count = 0
  }
  constructor(name) {
    super()
    this.name = name
  }
  get secret() {
    return this.#secret
  }
  static create() {
    return new Animal('x')
  }
  has(o) {
    return #secret in o
  }
}
const Anon = class {}
const fnExpr = function () {}
const named = function inner() {}
const arrow = async (a, { b }, [c]) => ({ a, b, c })
const nested = () => () => 1

const ops = [
  a + b * c,
  (a + b) * c,
  a - (b - c),
  a ** b ** c,
  (a ** b) ** c,
  (-a) ** b,
  a ?? (b || c),
  (a && b) ?? c,
  !a,
  -(-a),
  +(+a),
  - --a,
  typeof a === 'string',
  void 0,
  a ? b : c ? d : e,
  (a ? b : c) ? d : e,
  (a, b),
  a in b,
  a instanceof B,
  a?.b?.[c]?.(d),
  (a?.b).c,
  new (f())(),
  new (a.b().c)(),
  new A.B(),
  (await p).x,
  (() => {})(),
  (function () {})(),
  1..toString(),
  (1).toString(),
  0xff,
  1_000_000n,
  /re[g]ex/gi,
  tag`hello ${world} !`,
  String.raw`\n`,
  import.meta.url,
  import('./lazy.js'),
  x = y = z,
  x += 1,
  x ||= y,
  x ??= y,
  i++,
  --i,
]
let v
;[v] = [1]
;({ v } = { v: 2 })
;(function iife() {})()
;`template`.length
if (a) if (b) c()
else d()
