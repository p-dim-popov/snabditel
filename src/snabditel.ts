import type {
  ASnabditel,
  InjectionScope,
  Resolvable,
  SeedOptions,
  Token,
} from "./snabditel.types";

type Key = unknown;
type Scope = Map<Key, unknown>;

export class Snabditel implements ASnabditel {
  protected singletons: Scope = new Map();
  protected localScope: Scope | null = null;
  private instanceResolving: Set<Key> = new Set();

  protected getResolvingSet(): Set<Key> {
    return this.instanceResolving;
  }

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
      const scope = this.getScope();
      if (!scope) {
        throw new Error("Scoped seed requires an active run() scope");
      }
      scope.set(token as Key, value);
      return;
    }
    throw new Error("Cannot seed a transient value");
  }

  async run<T>(callback: () => Promise<T>): Promise<T> {
    if (this.localScope) {
      throw new Error(
        "run() already active — concurrent scopes require AlsSnabditel",
      );
    }
    this.localScope = new Map();
    try {
      return await callback();
    } finally {
      this.localScope = null;
    }
  }

  protected getScope(): Scope | null {
    return this.localScope;
  }

  async resolve<T>(token: Token<T>): Promise<T> {
    if (typeof token === "string" || typeof token === "symbol") {
      const scope = this.getScope();
      if (scope?.has(token)) {
        return scope.get(token) as T;
      }
      if (this.singletons.has(token)) {
        return this.singletons.get(token) as T;
      }
      throw new Error(`Unknown token: ${String(token)}. String and symbol tokens must be seeded before resolution.`);
    }

    const injectionScope = this.scopeOf(token);

    if (injectionScope === "singleton") {
      if (this.singletons.has(token)) {
        return this.singletons.get(token) as T;
      }
      const instance = await this.buildGuarded(token);
      this.singletons.set(token, instance);
      return instance;
    }
    if (injectionScope === "scoped") {
      const scope = this.getScope();
      if (!scope) {
        throw new Error("Scoped resolution requires an active run() scope");
      }
      if (scope.has(token)) {
        return scope.get(token) as T;
      }
      const instance = await this.buildGuarded(token);
      scope.set(token, instance);
      return instance;
    }

    return await this.buildGuarded(token);
  }

  private async buildGuarded<T>(token: Resolvable<T>): Promise<T> {
    const resolving = this.getResolvingSet();
    if (resolving.has(token)) {
      throw new Error("Cycle detected during resolution");
    }
    resolving.add(token);
    try {
      return await this.build(token);
    } finally {
      resolving.delete(token);
    }
  }

  private scopeOf<T>(binding: Resolvable<T>): InjectionScope {
    const injectionScope =
      "injectionScope" in binding ? binding.injectionScope : undefined;
    return injectionScope ?? "singleton";
  }

  private async build<T>(binding: Resolvable<T>): Promise<T> {
    if ("createInstance" in binding) {
      return await binding.createInstance();
    }

    return new binding();
  }
}
