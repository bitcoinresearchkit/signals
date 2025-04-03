import { STATE_DIRTY } from "./core/constants.js";
import type { SignalOptions } from "./core/index.js";
import {
  Computation,
  compute,
  EagerComputation,
  Effect,
  NotReadyError,
  Owner,
  untrack
} from "./core/index.js";

export type Accessor<T> = () => T;

export type Setter<in out T> = {
  <U extends T>(
    ...args: undefined extends T ? [] : [value: Exclude<U, Function> | ((prev: T) => U)]
  ): undefined extends T ? undefined : U;
  <U extends T>(value: (prev: T) => U): U;
  <U extends T>(value: Exclude<U, Function>): U;
  <U extends T>(value: Exclude<U, Function> | ((prev: T) => U)): U;
};

export type Signal<T> = [get: Accessor<T>, set: Setter<T>];

export type ComputeFunction<Prev, Next extends Prev = Prev> = (v: Prev) => Next;
export type EffectFunction<Prev, Next extends Prev = Prev> = (
  v: Next,
  p?: Prev
) => (() => void) | void;

export interface EffectOptions {
  name?: string;
  defer?: boolean;
}
export interface MemoOptions<T> {
  name?: string;
  equals?: false | ((prev: T, next: T) => boolean);
}

// Magic type that when used at sites where generic types are inferred from, will prevent those sites from being involved in the inference.
// https://github.com/microsoft/TypeScript/issues/14829
// TypeScript Discord conversation: https://discord.com/channels/508357248330760243/508357248330760249/911266491024949328
export type NoInfer<T extends any> = [T][T extends any ? 0 : never];

/**
 * Creates a simple reactive state with a getter and setter
 * ```typescript
 * const [state: Accessor<T>, setState: Setter<T>] = createSignal<T>(
 *  value: T,
 *  options?: { name?: string, equals?: false | ((prev: T, next: T) => boolean) }
 * )
 * ```
 * @param value initial value of the state; if empty, the state's type will automatically extended with undefined; otherwise you need to extend the type manually if you want setting to undefined not be an error
 * @param options optional object with a name for debugging purposes and equals, a comparator function for the previous and next value to allow fine-grained control over the reactivity
 *
 * @returns ```typescript
 * [state: Accessor<T>, setState: Setter<T>]
 * ```
 * * the Accessor is a function that returns the current value and registers each call to the reactive root
 * * the Setter is a function that allows directly setting or mutating the value:
 * ```typescript
 * const [count, setCount] = createSignal(0);
 * setCount(count => count + 1);
 * ```
 *
 * @description https://docs.solidjs.com/reference/basic-reactivity/create-signal
 */
export function createSignal<T>(): Signal<T | undefined>;
export function createSignal<T>(value: Exclude<T, Function>, options?: SignalOptions<T>): Signal<T>;
export function createSignal<T>(
  fn: ComputeFunction<T>,
  initialValue?: T,
  options?: SignalOptions<T>
): Signal<T>;
export function createSignal<T>(
  first?: T | ComputeFunction<T>,
  second?: T | SignalOptions<T>,
  third?: SignalOptions<T>
): Signal<T | undefined> {
  if (typeof first === "function") {
    const memo = createMemo<Signal<T>>(p => {
      const node = new Computation<T>(
        (first as (prev?: T) => T)(p ? untrack(p[0]) : (second as T)),
        null,
        third
      );
      return [node.read.bind(node), node.write.bind(node)] as Signal<T>;
    });
    return [() => memo()[0](), (value => memo()[1](value)) as Setter<T | undefined>];
  }
  const node = new Computation(first, null, second as SignalOptions<T>);
  return [node.read.bind(node), node.write.bind(node) as Setter<T | undefined>];
}

/**
 * Creates a readonly derived reactive memoized signal
 * ```typescript
 * export function createMemo<T>(
 *   compute: (v: T) => T,
 *   value?: T,
 *   options?: { name?: string, equals?: false | ((prev: T, next: T) => boolean) }
 * ): () => T;
 * ```
 * @param compute a function that receives its previous or the initial value, if set, and returns a new value used to react on a computation
 * @param value an optional initial value for the computation; if set, fn will never receive undefined as first argument
 * @param options allows to set a name in dev mode for debugging purposes and use a custom comparison function in equals
 *
 * @description https://docs.solidjs.com/reference/basic-reactivity/create-memo
 */
// The extra Prev generic parameter separates inference of the compute input
// parameter type from inference of the compute return type, so that the effect
// return type is always used as the memo Accessor's return type.
export function createMemo<Next extends Prev, Prev = Next>(
  compute: ComputeFunction<undefined | NoInfer<Prev>, Next>
): Accessor<Next>;
export function createMemo<Next extends Prev, Init = Next, Prev = Next>(
  compute: ComputeFunction<Init | Prev, Next>,
  value: Init,
  options?: MemoOptions<Next>
): Accessor<Next>;
export function createMemo<Next extends Prev, Init, Prev>(
  compute: ComputeFunction<Init | Prev, Next>,
  value?: Init,
  options?: MemoOptions<Next>
): Accessor<Next> {
  let node: Computation<Next> | undefined = new Computation<Next>(
    value as any,
    compute as any,
    options
  );
  let resolvedValue: Next;
  return () => {
    if (node) {
      resolvedValue = node.wait();
      // no sources so will never update so can be disposed.
      // additionally didn't create nested reactivity so can be disposed.
      if (!node._sources?.length && node._nextSibling?._parent !== node) {
        node.dispose();
        node = undefined;
      }
      // not owned and not listened to so can be garbage collected if reference lost.
      else if (!node._parent && !node._observers?.length) {
        node.dispose();
        node._state = STATE_DIRTY;
      }
    }
    return resolvedValue;
  };
}

/**
 * Creates a reactive effect that runs after the render phase
 * ```typescript
 * export function createEffect<T>(
 *   compute: (prev: T) => T,
 *   effect: (v: T, prev: T) => (() => void) | void,
 *   value?: T,
 *   options?: { name?: string }
 * ): void;
 * ```
 * @param compute a function that receives its previous or the initial value, if set, and returns a new value used to react on a computation
 * @param effect a function that receives the new value and is used to perform side effects, return a cleanup function to run on disposal
 * @param error an optional function that receives an error if thrown during the computation
 * @param value an optional initial value for the computation; if set, fn will never receive undefined as first argument
 * @param options allows to set a name in dev mode for debugging purposes
 *
 * @description https://docs.solidjs.com/reference/basic-reactivity/create-effect
 */
export function createEffect<Next>(
  compute: ComputeFunction<undefined | NoInfer<Next>, Next>,
  effect: EffectFunction<NoInfer<Next>, Next>,
  error?: (err: unknown) => void
): void;
export function createEffect<Next, Init = Next>(
  compute: ComputeFunction<Init | Next, Next>,
  effect: EffectFunction<Next, Next>,
  error: ((err: unknown) => void) | undefined,
  value: Init,
  options?: EffectOptions
): void;
export function createEffect<Next, Init>(
  compute: ComputeFunction<Init | Next, Next>,
  effect: EffectFunction<Next, Next>,
  error?: (err: unknown) => void,
  value?: Init,
  options?: EffectOptions
): void {
  void new Effect(
    value as any,
    compute as any,
    effect,
    error,
    __DEV__ ? { ...options, name: options?.name ?? "effect" } : options
  );
}

/**
 * Creates a new non-tracked reactive context with manual disposal
 *
 * @param fn a function in which the reactive state is scoped
 * @returns the output of `fn`.
 *
 * @description https://docs.solidjs.com/reference/reactive-utilities/create-root
 */
export function createRoot<T>(init: ((dispose: () => void) => T) | (() => T)): T {
  const owner = new Owner();
  return compute(owner, !init.length ? (init as () => T) : () => init(() => owner.dispose()), null);
}

/**
 * Runs the given function in the given owner to move ownership of nested primitives and cleanups.
 * This method untracks the current scope.
 *
 * Warning: Usually there are simpler ways of modeling a problem that avoid using this function
 */
export function runWithOwner<T>(owner: Owner | null, run: () => T): T {
  return compute(owner, run, null);
}
