import type { SeedOptions } from "../snabditel.types";

export type Scope = Map<unknown, unknown>;
export type SeedSource = "singleton" | "scoped";

export function writeSeed<T>(
  singletons: Scope,
  getScope: () => Scope | null,
  token: string | symbol | (new (...args: any[]) => T),
  value: T,
  options: SeedOptions = {},
): void {
  const injectionScope = options.injectionScope ?? "singleton";
  if (injectionScope === "singleton") {
    singletons.set(token, value);
    return;
  }
  if (injectionScope === "scoped") {
    const scope = getScope();
    if (!scope) {
      throw new Error("Scoped seed requires an active run() scope");
    }
    scope.set(token, value);
    return;
  }
  throw new Error("Cannot seed a transient value");
}

export async function readSeedToken<T>(
  singletons: Scope,
  currentScope: Scope | null,
  token: string | symbol,
): Promise<{ value: T; source: SeedSource }> {
  if (currentScope?.has(token)) {
    return { value: (await currentScope.get(token)) as T, source: "scoped" };
  }
  if (singletons.has(token)) {
    return { value: (await singletons.get(token)) as T, source: "singleton" };
  }
  throw new Error(
    `Unknown token: ${String(token)}. String and symbol tokens must be seeded before resolution.`,
  );
}
