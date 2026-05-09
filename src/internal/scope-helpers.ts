import type {
  InjectionScope,
  Resolvable,
  SelfResolvable,
} from "../snabditel.types";

const RANK: Record<InjectionScope, number> = {
  transient: 0,
  scoped: 1,
  singleton: 2,
};

export function narrower(a: InjectionScope, b: InjectionScope): InjectionScope {
  return RANK[a] <= RANK[b] ? a : b;
}

export function isWider(
  declared: InjectionScope,
  min: InjectionScope,
): boolean {
  return RANK[declared] > RANK[min];
}

/**
 * Returns the explicit `injectionScope` declared on the binding, or `undefined` when none is set.
 * Caller decides the default — `AlsSnabditel` infers it from dependency scopes.
 */
export function scopeOf<T>(
  binding: Resolvable<T>,
): InjectionScope | undefined {
  if ("injectionScope" in binding && binding.injectionScope !== undefined) {
    return binding.injectionScope;
  }
  return undefined;
}

export function ownerName<T>(binding: Resolvable<T>): string {
  if (typeof binding === "function") {
    return binding.name && binding.name.length > 0
      ? binding.name
      : "anonymous class";
  }
  const ctor = (binding as SelfResolvable<T>).constructor;
  if (ctor && ctor.name && ctor.name !== "Object") {
    return ctor.name;
  }
  return "anonymous SelfResolvable";
}

export function mismatchError<T>(
  binding: Resolvable<T>,
  declared: InjectionScope,
  min: InjectionScope,
): Error {
  return new Error(
    `Cannot resolve ${ownerName(binding)} as ${declared}: depends on a ${min} service. ` +
      `Either remove \`injectionScope\` to inherit '${min}', or set it to '${min}' or 'transient'.`,
  );
}

export function effectiveScopedNoRunError<T>(
  binding: Resolvable<T>,
): Error {
  return new Error(
    `${ownerName(binding)} effective scope is 'scoped' (inherited from a scoped dependency) but no run() scope is active.`,
  );
}
