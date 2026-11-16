// The inventory hash, pinned to the same test vector as the
// server's test suite.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    canonicalPackages,
    inventoryHash,
} from '../dist/esm/core/inventory.js';

test('the test vector hashes to the pinned value', () => {
    assert.equal(
        inventoryHash('npm', [
            { name: 'lodash', version: '4.17.21' },
            { name: '@types/node', version: '22.9.0' },
        ]),
        '7ccf9726ffe6d03b3560f8d9b39c627ae11e7e2014adc0368c5fd678e0b2640c',
    );
});

test('duplicates count once and order does not matter', () => {
    const packages = [
        { name: 'lodash', version: '4.17.21' },
        { name: '@types/node', version: '22.9.0' },
    ];

    assert.equal(
        inventoryHash('npm', [...packages].reverse().concat(packages)),
        inventoryHash('npm', packages),
    );
});

test('packages sort by UTF-8 bytes, not UTF-16 code units', () => {
    // U+FF01 is EF BC 81 in UTF-8 and sorts before U+1F600 (F0 9F 98 80);
    // in UTF-16 the surrogate pair of U+1F600 (D83D) sorts first.
    const sorted = canonicalPackages([
        { name: 'a\u{1F600}', version: '1.0.0' },
        { name: 'a！', version: '1.0.0' },
    ]);

    assert.deepEqual(
        sorted.map(({ name }) => name),
        ['a！', 'a\u{1F600}'],
    );
});
