import merge from '../src/vendor/deepmerge/index.js';

describe('configuration merge compatibility and prototype safety', () => {
    test('preserves recursive override and concatenating array semantics without mutating inputs', () => {
        const base = { nested: { keep: 1, replace: 'old' }, list: [{ value: 1 }] };
        const override = { nested: { replace: 'new' }, list: [{ value: 2 }] };
        const result = merge(base, override);
        expect(result).toEqual({ nested: { keep: 1, replace: 'new' }, list: [{ value: 1 }, { value: 2 }] });
        result.nested.keep = 9;
        result.list[0].value = 8;
        result.list[1].value = 7;
        expect(base.nested.keep).toBe(1);
        expect(base.list[0].value).toBe(1);
        expect(override.list[0].value).toBe(2);
    });
    test.each(['__proto__', 'constructor', 'prototype'])('drops %s in target, source, nested objects and array elements', key => {
        const payload = JSON.parse(`{"${key}":{"poisoned":true},"safe":1}`);
        for (const result of [merge(payload, {}), merge({}, payload), merge({}, { nested: payload }), merge([], [payload])[0]]) {
            const value = result.nested || result;
            expect(Object.hasOwn(value, key)).toBe(false);
            expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
            expect(value.poisoned).toBeUndefined();
            expect(value.safe).toBe(1);
        }
        expect({}.poisoned).toBeUndefined();
    });
    test('does not copy inherited properties and preserves enumerable symbols', () => {
        const symbol = Symbol('config');
        const source = Object.assign(Object.create({ inherited: true }), { safe: 1, [symbol]: { count: 2 } });
        const result = merge({}, source);
        expect(result.inherited).toBeUndefined();
        expect(result[symbol]).toEqual({ count: 2 });
        expect(result[symbol]).not.toBe(source[symbol]);
    });
    test('preserves special objects, array replacement, custom merging and merge.all', () => {
        const date = new Date('2026-01-01T00:00:00Z');
        const regex = /config/i;
        const special = merge({}, { date, regex });
        expect(special.date).toBe(date);
        expect(special.regex).toBe(regex);
        expect(merge({ old: true }, [1, 2])).toEqual([1, 2]);
        expect(merge([1], [2], { arrayMerge: (_a, b) => b })).toEqual([2]);
        expect(merge.all([{ nested: { a: 1 } }, { nested: { b: 2 } }])).toEqual({ nested: { a: 1, b: 2 } });
        expect(() => merge.all({})).toThrow('first argument should be an array');
    });
    test('independent request copies never share mutable provider config', () => {
        const config = { providers: [{ headers: { accept: 'json' } }] };
        const first = merge({}, config);
        const second = merge({}, config);
        first.providers[0].headers.accept = 'stream';
        expect(second.providers[0].headers.accept).toBe('json');
        expect(config.providers[0].headers.accept).toBe('json');
    });
});
