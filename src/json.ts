import { isProxy } from "node:util/types";
import type { JsonValue } from "@earendil-works/pi-ai";

/** Copy workflow data before persistence. Never silently drop values or invoke toJSON/getters. */
export function workflowJson(value: unknown): JsonValue {
  const ancestors = new Set<object>();
  const visit = (value: unknown, path: string): JsonValue => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (!value || typeof value !== "object") throw new TypeError(`${path} must be JSON data`);
    if (isProxy(value)) throw new TypeError(`${path} must not contain JSON proxies`);
    if (ancestors.has(value)) throw new TypeError(`${path} contains a cycle`);
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && isProxy(proto)) throw new TypeError(`${path} must not contain JSON proxies`);
    const ctor = proto === null ? undefined : Object.getOwnPropertyDescriptor(proto, "constructor")?.value;
    if (
      !Array.isArray(value) &&
      proto !== null &&
      (Object.getPrototypeOf(proto) !== null ||
        typeof ctor !== "function" ||
        isProxy(ctor) ||
        Object.getOwnPropertyDescriptor(ctor, "name")?.value !== "Object")
    ) {
      throw new TypeError(`${path} must be a plain JSON object`);
    }
    ancestors.add(value);
    try {
      if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")) {
        throw new TypeError(`${path} contains a symbol key`);
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!("value" in descriptor)) throw new TypeError(`${path}.${key} contains an accessor`);
      }
      if (Array.isArray(value)) {
        if (Object.getOwnPropertyNames(value).length !== value.length + 1)
          throw new TypeError(`${path} must be a dense JSON array`);
        return Array.from({ length: value.length }, (_, i) => visit(descriptors[i]?.value, `${path}[${i}]`));
      }
      return Object.fromEntries(
        Object.entries(descriptors).map(([key, descriptor]) => {
          if (!descriptor.enumerable) throw new TypeError(`${path}.${key} is not enumerable`);
          return [key, visit(descriptor.value, `${path}.${key}`)];
        }),
      );
    } finally {
      ancestors.delete(value);
    }
  };
  return visit(value, "Workflow result");
}
