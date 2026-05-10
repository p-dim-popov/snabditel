import { AsyncLocalStorage } from "node:async_hooks";
import { Snabditel, EMPTY_CTX, type Ctx } from "./snabditel";

export class AlsSnabditel extends Snabditel {
  private ctxAls = new AsyncLocalStorage<Ctx>();

  protected override outerCtx(): Ctx {
    return this.ctxAls.getStore() ?? EMPTY_CTX;
  }

  protected override wrapAsync<T>(ctx: Ctx, fn: () => Promise<T>): Promise<T> {
    return this.ctxAls.run(ctx, fn);
  }
}
