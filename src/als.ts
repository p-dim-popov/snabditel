import { AsyncLocalStorage } from "node:async_hooks";
import type {
  ASnabditel,
  InjectionScope,
  Resolvable,
  SeedOptions,
  Token,
} from "./snabditel.types";
import { readSeedToken, writeSeed } from "./internal/seed-helpers";
import {
  isWider,
  mismatchError,
  narrower,
} from "./internal/scope-helpers";

type Key = unknown;
type Scope = Map<Key, unknown>;

type Frame = {
  ownerToken: Resolvable<unknown>;
  declared: InjectionScope | undefined;
  minScope: InjectionScope;
  parent: Frame | null;
};

type BuildResult<T> = {
  value: T;
  effectiveScope: InjectionScope;
  builtInScope: Scope | null;
};

export class AlsSnabditel implements ASnabditel {
  private singletons: Scope = new Map();
  private scopeAls = new AsyncLocalStorage<Scope>();
  private frameAls = new AsyncLocalStorage<Frame>();
  private inFlight = new Map<Key, Promise<BuildResult<unknown>>>();

  async run<T>(callback: () => Promise<T>): Promise<T> {
    return this.scopeAls.run(new Map(), callback);
  }

  seed<T>(
    token: string | symbol | (new (...args: any[]) => T),
    value: T,
    options: SeedOptions = {},
  ): void {
    writeSeed(this.singletons, () => this.scopeAls.getStore() ?? null, token, value, options);
  }

  private bubble(scope: InjectionScope): void {
    const frame = this.frameAls.getStore();
    if (!frame) return;
    const next = narrower(frame.minScope, scope);
    if (next === frame.minScope) return;
    frame.minScope = next;
    if (frame.declared !== undefined && isWider(frame.declared, frame.minScope)) {
      throw mismatchError(frame.ownerToken, frame.declared, frame.minScope);
    }
  }

  async resolve<T>(token: Token<T>): Promise<T> {
    if (typeof token === "string" || typeof token === "symbol") {
      const scope = this.scopeAls.getStore() ?? null;
      const result = await readSeedToken<T>(this.singletons, scope, token);
      this.bubble(result.source);
      return result.value;
    }
    throw new Error("not implemented yet");
  }
}
