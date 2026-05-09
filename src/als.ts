import { AsyncLocalStorage } from "node:async_hooks";
import { Snabditel } from "./snabditel";
import { type Token } from "./snabditel.types";

type Scope = Map<unknown, unknown>;

export class AlsSnabditel extends Snabditel {
  private als = new AsyncLocalStorage<Scope>();
  private resolvingAls = new AsyncLocalStorage<Set<unknown>>();

  protected override getScope(): Scope | null {
    return this.als.getStore() ?? null;
  }

  protected override getResolvingSet(): Set<unknown> {
    const existing = this.resolvingAls.getStore();
    if (existing) return existing;
    const fresh = new Set<unknown>();
    this.resolvingAls.enterWith(fresh);
    return fresh;
  }

  override async run<T>(callback: () => Promise<T>): Promise<T> {
    return this.als.run(new Map(), callback);
  }

  override async resolve<T>(token: Token<T>): Promise<T> {
    if (this.resolvingAls.getStore()) {
      return super.resolve(token);
    }
    return this.resolvingAls.run(new Set(), () => super.resolve(token));
  }
}
