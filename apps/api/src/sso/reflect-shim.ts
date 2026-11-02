/**
 * `@peculiar/x509` 3 (section 3.5 S7) resolves its algorithm providers through `tsyringe`, which refuses to load
 * without a Reflect metadata API and documents `reflect-metadata` as the polyfill to install. That package is not a
 * dependency of this repository, so this module supplies the three calls tsyringe makes (`getMetadata`,
 * `getOwnMetadata`, `defineMetadata`, plus the `has*` forms), backed by a WeakMap, and only when no Reflect metadata
 * API is present. It is installed right before x509 is imported (lazily, in `sp-key.ts`), never at boot.
 */
type MetaMap = Map<unknown, unknown>;
type ReflectMeta = {
  getMetadata?: (key: unknown, target: object, prop?: string | symbol) => unknown;
  getOwnMetadata?: (key: unknown, target: object, prop?: string | symbol) => unknown;
  defineMetadata?: (key: unknown, value: unknown, target: object, prop?: string | symbol) => void;
  hasMetadata?: (key: unknown, target: object, prop?: string | symbol) => boolean;
  hasOwnMetadata?: (key: unknown, target: object, prop?: string | symbol) => boolean;
  metadata?: (key: unknown, value: unknown) => (target: object, prop?: string | symbol) => void;
};

export function installReflectMetadataShim(): void {
  const R = Reflect as unknown as ReflectMeta;
  if (typeof R.getMetadata === 'function') return;
  const store = new WeakMap<object, Map<string | symbol | undefined, MetaMap>>();
  const own = (target: object, prop: string | symbol | undefined, create: boolean): MetaMap | undefined => {
    let byProp = store.get(target);
    if (!byProp) {
      if (!create) return undefined;
      byProp = new Map();
      store.set(target, byProp);
    }
    let m = byProp.get(prop);
    if (!m && create) {
      m = new Map();
      byProp.set(prop, m);
    }
    return m;
  };
  R.defineMetadata = (key, value, target, prop) => {
    own(target, prop, true)!.set(key, value);
  };
  R.getOwnMetadata = (key, target, prop) => own(target, prop, false)?.get(key);
  R.hasOwnMetadata = (key, target, prop) => own(target, prop, false)?.has(key) ?? false;
  R.getMetadata = (key, target, prop) => {
    for (let t: object | null = target; t; t = Object.getPrototypeOf(t) as object | null) {
      const m = own(t, prop, false);
      if (m?.has(key)) return m.get(key);
    }
    return undefined;
  };
  R.hasMetadata = (key, target, prop) => R.getMetadata!(key, target, prop) !== undefined;
  R.metadata = (key, value) => (target, prop) => R.defineMetadata!(key, value, target, prop);
}
