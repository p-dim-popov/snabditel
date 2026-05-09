import { describe, expect, test } from "bun:test";
import {
  narrower,
  isWider,
  scopeOf,
  ownerName,
} from "./scope-helpers";

describe("narrower", () => {
  test("returns the narrower of two scopes (lifetime ordering)", () => {
    expect(narrower("singleton", "singleton")).toBe("singleton");
    expect(narrower("singleton", "scoped")).toBe("scoped");
    expect(narrower("scoped", "singleton")).toBe("scoped");
    expect(narrower("scoped", "scoped")).toBe("scoped");
    expect(narrower("scoped", "transient")).toBe("transient");
    expect(narrower("transient", "scoped")).toBe("transient");
    expect(narrower("transient", "transient")).toBe("transient");
    expect(narrower("singleton", "transient")).toBe("transient");
  });
});

describe("isWider", () => {
  test("true when declared lifetime is longer than min", () => {
    expect(isWider("singleton", "scoped")).toBe(true);
    expect(isWider("singleton", "transient")).toBe(true);
    expect(isWider("scoped", "transient")).toBe(true);
  });
  test("false when declared <= min", () => {
    expect(isWider("singleton", "singleton")).toBe(false);
    expect(isWider("scoped", "scoped")).toBe(false);
    expect(isWider("scoped", "singleton")).toBe(false);
    expect(isWider("transient", "singleton")).toBe(false);
    expect(isWider("transient", "scoped")).toBe(false);
    expect(isWider("transient", "transient")).toBe(false);
  });
});

describe("scopeOf", () => {
  test("returns explicit injectionScope from SelfResolvable", () => {
    expect(scopeOf({ createInstance: () => ({}), injectionScope: "scoped" })).toBe("scoped");
    expect(scopeOf({ createInstance: () => ({}), injectionScope: "transient" })).toBe("transient");
    expect(scopeOf({ createInstance: () => ({}), injectionScope: "singleton" })).toBe("singleton");
  });
  test("returns undefined when SelfResolvable has no injectionScope", () => {
    expect(scopeOf({ createInstance: () => ({}) })).toBeUndefined();
  });
  test("returns explicit injectionScope from class with static field", () => {
    class Foo { static readonly injectionScope = "scoped" as const; }
    expect(scopeOf(Foo)).toBe("scoped");
  });
  test("returns undefined for plain class without injectionScope", () => {
    class Bar {}
    expect(scopeOf(Bar)).toBeUndefined();
  });
});

describe("ownerName", () => {
  test("named class -> class name", () => {
    class Foo {}
    expect(ownerName(Foo)).toBe("Foo");
  });
  test("anonymous class -> 'anonymous class'", () => {
    const Anon = class {};
    Object.defineProperty(Anon, "name", { value: "" });
    expect(ownerName(Anon)).toBe("anonymous class");
  });
  test("SelfResolvable object literal -> 'anonymous SelfResolvable'", () => {
    expect(ownerName({ createInstance: () => ({}) })).toBe("anonymous SelfResolvable");
  });
});
