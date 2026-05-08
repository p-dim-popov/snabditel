export type InjectionScope = 'singleton' | 'scoped' | 'transient';

export type Resolvable<T = unknown> = {
  getInstance(snabditel: SnabditelInjector): Promise<T> | T;
  injectionScope?: InjectionScope;
};

export type Resolved<R extends Resolvable> = Awaited<ReturnType<R['getInstance']>>;

declare const TokenBrand: unique symbol;
export type Token<T> = string & { readonly [TokenBrand]: T };

export interface SnabditelInjector {
    resolve<T>(token: Token<T>): Promise<T>;
    resolve<T = unknown>(token: string): Promise<T>;
    seed<T>(token: Token<T>, instance: T): this;
    seed<T>(token: string, instance: T): this;
}

export interface SnabditelType extends SnabditelInjector {
    run<T>(fn: (scope: SnabditelInjector) => Promise<T> | T): Promise<T>;
    dispose(): Promise<void>;
}
