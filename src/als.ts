import { AsyncLocalStorage } from "node:async_hooks";
import { Snabditel } from "./snabditel";
import type { Token } from "./snabditel.types";

type Scope = Map<unknown, unknown>;

export class AlsSnabditel extends Snabditel {
  private als = new AsyncLocalStorage<Scope>();
  private resolvingAls = new AsyncLocalStorage<Set<unknown>>();

  protected override getScope(): Scope | null {
    return this.als.getStore() ?? null;
  }

  override async run<T>(callback: () => Promise<T>): Promise<T> {
    return this.als.run(new Map(), callback);
  }

  override async resolve<T>(token: Token<T>): Promise<T> {
    if (!this.resolvingAls.getStore()) {
      return this.resolvingAls.run(new Set(), () => this.resolveTracked(token));
    }
    return this.resolveTracked(token);
  }

  private async resolveTracked<T>(token: Token<T>): Promise<T> {
    if (typeof token === "string" || typeof token === "symbol") {
      return super.resolve(token);
    }
    const resolving = this.resolvingAls.getStore()!;
    if (resolving.has(token)) {
      throw new Error("Cycle detected during resolution");
    }
    resolving.add(token);
    try {
      return await super.resolve(token);
    } finally {
      resolving.delete(token);
    }
  }
}
