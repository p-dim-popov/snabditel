import type {
  ASnabditel,
  Resolvable,
  SeedOptions,
  Token,
} from "./snabditel.types";

type Key = unknown;
type Scope = Map<Key, unknown>;

export class Snabditel implements ASnabditel {
  private singletons: Scope = new Map();
  private localScope: Scope | null = null;

  seed<T>(
    token: string | symbol | (new (...args: any[]) => T),
    value: T,
    options: SeedOptions = {},
  ): void {
    const injectionScope = options.injectionScope ?? "singleton";
    if (injectionScope === "singleton") {
      this.singletons.set(token as Key, value);
      return;
    }
    if (injectionScope === "scoped") {
      if (!this.localScope) {
        throw new Error("Scoped seed requires an active run() scope");
      }
      this.localScope.set(token as Key, value);
      return;
    }
    throw new Error("Cannot seed a transient value");
  }

  async run<T>(callback: (s: ASnabditel) => Promise<T>): Promise<T> {
    if (this.localScope) {
      throw new Error(
        "run() already active — concurrent scopes require AlsSnabditel",
      );
    }
    this.localScope = new Map();
    try {
      return await callback(this);
    } finally {
      this.localScope = null;
    }
  }

  async resolve<T>(token: Token<T>): Promise<T> {
    if (typeof token === "string" || typeof token === "symbol") {
      return this.resolveSeeded<T>(token);
    }
    return this.resolveBinding<T>(token);
  }

  private async resolveSeeded<T>(token: string | symbol): Promise<T> {
    if (this.localScope?.has(token)) {
      return (await this.localScope.get(token)) as T;
    }
    if (this.singletons.has(token)) {
      return (await this.singletons.get(token)) as T;
    }
    throw new Error(
      `Unknown token: ${String(token)}. String and symbol tokens must be seeded before resolution.`,
    );
  }

  private async resolveBinding<T>(token: Resolvable<T>): Promise<T> {
    const injectionScope =
      ("injectionScope" in token ? token.injectionScope : undefined) ?? "singleton";

    if (injectionScope === "singleton") {
      return this.cacheBuild(this.singletons, token);
    }
    if (injectionScope === "scoped") {
      if (!this.localScope) {
        throw new Error("Scoped resolution requires an active run() scope");
      }
      return this.cacheBuild(this.localScope, token);
    }
    return this.build(token);
  }

  private cacheBuild<T>(cache: Scope, token: Resolvable<T>): Promise<T> {
    if (cache.has(token)) {
      return Promise.resolve(cache.get(token) as T | Promise<T>);
    }
    const p = this.build(token);
    cache.set(token, p);
    p.catch(() => {
      if (cache.get(token) === p) cache.delete(token);
    });
    return p;
  }

  private async build<T>(binding: Resolvable<T>): Promise<T> {
    if ("createInstance" in binding) {
      return await binding.createInstance(this);
    }
    return new binding();
  }
}
