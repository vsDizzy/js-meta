// TypeScript round trip.
import type { A } from './a.ts'
import { type B, C } from './b.ts'
export type { A }
import fs = require('fs')

type Prim = string | number | boolean | bigint | symbol | null | undefined
type Fn = (a: number, b?: string, ...rest: unknown[]) => void
type Ctor = abstract new () => object
type Arr = (string | number)[]
type FnArr = (() => void)[]
type Keys = keyof (A | B)
type Idx = A['b'][number]
type Cond<T> = T extends string ? 'str' : T extends (infer U)[] ? U : never
type Mapped<T> = { readonly [K in keyof T as `get${K & string}`]-?: T[K] }
type Lit = { a: 1; b?: 'x'; readonly c: -1; [k: string]: unknown; m(): void; new (): Lit; (x: number): string }
type Tup = [a: string, b?: number, ...rest: boolean[]]
type Tup2 = [string, number?]
type Tmpl = `prefix-${string}`
type Q = typeof import('./a.ts')
type Imp = import('./a.ts').A<string>
type Pred = (x: unknown) => x is string
type Asserts = (x: unknown) => asserts x is string
type Uniq = unique symbol
type Ro = readonly string[]
type Inter = A & (B | C)
type Gen<in out T extends object = {}> = T

interface Shape<T> extends Base, Other<T> {
  readonly kind: string
  area(): number
  get size(): number
  [key: string]: unknown
}

enum Color {
  Red,
  Green = 'g',
  Blue = 1 << 2,
}
declare const enum Flags { None = 0 }
declare module 'virtual' {
  export const x: number
}
namespace NS.Inner {
  export const y = 1
}
declare global {
  interface Window {
    app: unknown
  }
}
declare function overload(a: string): void
declare let ambient: number

abstract class Store<T> implements Iface {
  private readonly items: T[] = []
  protected abstract name: string
  declare tag: string
  static override x?: number
  value!: number
  accessor auto = 1
  constructor(private readonly db: Db, public id?: string) {
    super()
  }
  abstract load(): Promise<void>
  get<K extends keyof T>(key: K): T[K] {
    return this.items[0]![key] as T[K]
  }
  method(this: Store<T>): void {}
}

const sat = { a: 1 } satisfies Record<string, number>
const asConst = ['a', 'b'] as const
const nonNull = maybe!.value!
const inst = make<string>
const generic = <T,>(x: T): T => x
function assertIsString(x: unknown): asserts x is string {}
let fnType: <T>(x: T) => T
let opt: { a?: number } | undefined
export default class {}
