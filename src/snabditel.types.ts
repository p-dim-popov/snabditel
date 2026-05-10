export type InjectionScope = "singleton" | "transient" | "scoped";

export type SelfResolvable<T> = {
  createInstance(s: ASnabditel): T | Promise<T>;
  injectionScope?: InjectionScope;
};

export type NewableResolvable<T> = new () => T;

export type Resolvable<T> = SelfResolvable<T> | NewableResolvable<T>;

export type Token<T> = string | symbol | Resolvable<T>;

export type Resolver = {
  resolve<T>(token: Token<T>): Promise<T>;
};

export type SeedOptions = {
  injectionScope?: InjectionScope;
};

export type Seeder = {
  seed<T>(
    token: string | symbol | (new (...args: any[]) => T),
    value: T,
    options?: SeedOptions,
  ): void;
};

export type Scopeable = {
  run<T>(callback: (s: ASnabditel) => Promise<T>): Promise<T>;
};

export type ASnabditel = Resolver & Seeder & Scopeable;
