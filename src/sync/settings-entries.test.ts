import { describe, expect, it } from 'vitest';

import {
  holdsEntry,
  liveOnlyNestedEntries,
  nestedEntries,
  valueAtPath,
  withoutNestedEntries,
} from './settings-entries.ts';

describe('liveOnlyNestedEntries', () => {
  it('lists a new sub-key under a shared object key with its label and live value', () => {
    const merged = { mk: { a: 1 } };
    const live = { mk: { a: 1, c: { r: 'x' }, b: 2 } };
    expect(liveOnlyNestedEntries(merged, live)).toEqual([
      { path: ['mk', 'b'], key: 'mk', label: 'mk.b', value: 2 },
      { path: ['mk', 'c'], key: 'mk', label: 'mk.c', value: { r: 'x' } },
    ]);
  });

  it('ignores a top-level ahead key, an array merged value and a scalar live value', () => {
    expect(liveOnlyNestedEntries({}, { mk: { a: 1 } })).toEqual([]);
    expect(liveOnlyNestedEntries({ mk: [1] }, { mk: { a: 1 } })).toEqual([]);
    expect(liveOnlyNestedEntries({ mk: { a: 1 } }, { mk: 5 })).toEqual([]);
  });

  it('never lists env sub-keys or a hooks event', () => {
    const merged = { env: { A: '1' }, hooks: { Stop: [] } };
    const live = { env: { A: '1', TOKEN: 's' }, hooks: { Stop: [], Start: [{ matcher: '' }] } };
    expect(liveOnlyNestedEntries(merged, live)).toEqual([]);
  });

  it('does not list a sub-key present in both with a different value', () => {
    expect(liveOnlyNestedEntries({ mk: { a: 1 } }, { mk: { a: 2 } })).toEqual([]);
  });

  it('skips a __proto__ sub-key and keeps its sibling', () => {
    const live = JSON.parse('{"mk":{"__proto__":{"x":1},"ok":1}}') as Record<string, unknown>;
    expect(liveOnlyNestedEntries({ mk: {} }, live).map((e) => e.label)).toEqual(['mk.ok']);
  });

  it('skips a top-level __proto__ object on both sides', () => {
    const merged = JSON.parse('{"__proto__":{}}') as Record<string, unknown>;
    const live = JSON.parse('{"__proto__":{"x":1}}') as Record<string, unknown>;
    expect(liveOnlyNestedEntries(merged, live)).toEqual([]);
  });
});

describe('liveOnlyNestedEntries at depth', () => {
  it('lists a field added three levels down by its full path', () => {
    const merged = { mk: { foo: { source: { repo: 'a' } } } };
    const live = { mk: { foo: { source: { repo: 'a', ref: 'v1' } } } };
    expect(liveOnlyNestedEntries(merged, live)).toEqual([
      { path: ['mk', 'foo', 'source', 'ref'], key: 'mk', label: 'mk.foo.source.ref', value: 'v1' },
    ]);
  });

  it('lists a new branch once, not its descendants', () => {
    const live = { mk: { a: 1, foo: { x: { y: 1 } } } };
    expect(liveOnlyNestedEntries({ mk: { a: 1 } }, live).map((e) => e.label)).toEqual(['mk.foo']);
  });

  it('lists nothing when either side holds a scalar or array at that level', () => {
    expect(liveOnlyNestedEntries({ mk: { foo: { x: 1 } } }, { mk: { foo: [1] } })).toEqual([]);
    expect(liveOnlyNestedEntries({ mk: { foo: [1] } }, { mk: { foo: { x: 1 } } })).toEqual([]);
  });

  it('skips a nested __proto__ sub-key and keeps its sibling', () => {
    const live = JSON.parse('{"mk":{"foo":{"__proto__":{"x":1},"ok":1}}}') as Record<
      string,
      unknown
    >;
    expect(liveOnlyNestedEntries({ mk: { foo: {} } }, live).map((e) => e.label)).toEqual([
      'mk.foo.ok',
    ]);
  });
});

describe('nestedEntries', () => {
  it('lists every object sub-path, skipping env, hooks and scalars', () => {
    const settings = {
      model: 'x',
      env: { K: 'v' },
      hooks: { Stop: [] },
      mk: { a: 1, foo: { ref: 'r' } },
    };
    expect(nestedEntries(settings).map((e) => e.label)).toEqual(['mk.a', 'mk.foo', 'mk.foo.ref']);
  });
});

describe('valueAtPath', () => {
  it('reads own values through plain objects and returns undefined past a non-object', () => {
    const obj = { a: { b: { c: 1 } }, arr: [1], n: null };
    expect(valueAtPath(obj, ['a', 'b', 'c'])).toBe(1);
    expect(valueAtPath(obj, ['a', 'x'])).toBeUndefined();
    expect(valueAtPath(obj, ['arr', '0'])).toBeUndefined();
    expect(valueAtPath(obj, ['n', 'x'])).toBeUndefined();
    expect(valueAtPath(obj, ['a', 'toString'])).toBeUndefined();
  });
});

describe('withoutNestedEntries', () => {
  it('removes an ancestor and its descendant in either order without recreating the ancestor', () => {
    const settings = { mk: { a: 1, foo: { c: 1, e: 3 } } };
    const at = (path: string[]) => ({ path, key: 'mk', label: path.join('.'), value: null });
    const foo = at(['mk', 'foo']);
    const c = at(['mk', 'foo', 'c']);
    expect(Object.keys(withoutNestedEntries(settings, [foo, c]).mk as object)).toEqual(['a']);
    expect(Object.keys(withoutNestedEntries(settings, [c, foo]).mk as object)).toEqual(['a']);
    expect(settings).toEqual({ mk: { a: 1, foo: { c: 1, e: 3 } } });
  });

  it('removes a depth-three entry, keeps siblings and leaves the input untouched', () => {
    const settings = { mk: { a: 1, foo: { x: 1, source: { repo: 'a', ref: 'v1' } } }, theme: 'd' };
    const before = JSON.stringify(settings);
    const entry = liveOnlyNestedEntries(
      { mk: { a: 1, foo: { x: 1, source: { repo: 'a' } } } },
      settings,
    );
    expect(withoutNestedEntries(settings, entry)).toEqual({
      mk: { a: 1, foo: { x: 1, source: { repo: 'a' } } },
      theme: 'd',
    });
    expect(JSON.stringify(settings)).toBe(before);
  });

  it('returns an entry unchanged when its parent is no longer an object', () => {
    const entry = { path: ['mk', 'foo', 'x'], key: 'mk', label: 'mk.foo.x', value: 1 };
    expect(withoutNestedEntries({ mk: { foo: 5 } }, [entry])).toEqual({ mk: { foo: 5 } });
    const deep = { ...entry, path: ['mk', 'foo', 'x', 'y'], label: 'mk.foo.x.y' };
    expect(withoutNestedEntries({ mk: { foo: 5 } }, [deep])).toEqual({ mk: { foo: 5 } });
  });
});

describe('array members', () => {
  it('lists each distinct live-only member of a shared array, launcher paths normalized', () => {
    const merged = { permissions: { allow: ['a', 'node x'] }, list: [] };
    const live = { permissions: { allow: ['a', '/usr/bin/node x', 'b', 'b'] }, list: [{ k: 1 }] };
    expect(liveOnlyNestedEntries(merged, live)).toEqual([
      { path: ['list'], key: 'list', label: 'list[{"k":1}]', value: { k: 1 }, element: true },
      {
        path: ['permissions', 'allow'],
        key: 'permissions',
        label: 'permissions.allow["b"]',
        value: 'b',
        element: true,
      },
    ]);
  });

  it('lists no member when the merge does not hold that array', () => {
    expect(liveOnlyNestedEntries({ p: {} }, { p: { allow: ['a'] } }).map((e) => e.label)).toEqual([
      'p.allow',
    ]);
    expect(liveOnlyNestedEntries({ p: { allow: 'a' } }, { p: { allow: ['a'] } })).toEqual([]);
    expect(liveOnlyNestedEntries({}, { list: [1] })).toEqual([]);
  });

  it('never lists members under env or hooks', () => {
    expect(liveOnlyNestedEntries({ env: { L: [] } }, { env: { L: [1] } })).toEqual([]);
  });

  it('holdsEntry matches a member by deep equality and an object entry by value', () => {
    const obj = { p: { allow: [{ a: 1 }] } };
    const member = {
      path: ['p', 'allow'],
      key: 'p',
      label: '',
      value: { a: 1 },
      element: true as const,
    };
    expect(holdsEntry(obj, member)).toBe(true);
    expect(holdsEntry(obj, { ...member, value: { a: 2 } })).toBe(false);
    expect(holdsEntry({ p: { allow: 'x' } }, member)).toBe(false);
    expect(holdsEntry(obj, { path: ['p', 'allow'], key: 'p', label: '', value: [{ a: 1 }] })).toBe(
      true,
    );
  });

  it('withoutNestedEntries drops every copy of a member and keeps the rest', () => {
    const live = { p: { allow: ['a', 'b', 'b'] }, list: [1, 2] };
    const entries = liveOnlyNestedEntries({ p: { allow: ['a'] }, list: [1] }, live);
    expect(withoutNestedEntries(live, entries)).toEqual({ p: { allow: ['a'] }, list: [1] });
    expect(live.p.allow).toEqual(['a', 'b', 'b']);
  });
});
