'use strict';

const assert = require('assert');

const { displayWidth, padDisplay, codePointWidth } = require('../modules/utils/text_width');

console.log('Running text width tests');

function expectWidth(text, expected, label) {
    assert.strictEqual(displayWidth(text), expected, `${label}: displayWidth(${JSON.stringify(text)})`);
}

// ASCII and control characters
expectWidth('', 0, 'empty');
expectWidth('abc', 3, 'ascii');
expectWidth('a\tb', 2, 'tab is zero-width');
expectWidth('\x1b', 0, 'escape is zero-width');

// East-Asian wide glyphs
expectWidth('中', 2, 'CJK');
expectWidth('中文', 4, 'CJK pair');
expectWidth('ｆｕｌｌ', 8, 'fullwidth forms');
expectWidth('한글', 4, 'hangul');

// Combining marks and grapheme clusters
expectWidth('e\u0301', 1, 'combining accent');
expectWidth('\u0301', 0, 'lone combining mark');

// Emoji, including ZWJ sequences that render as one glyph
expectWidth('🙂', 2, 'emoji');
expectWidth('👨‍👩‍👧', 2, 'ZWJ family emoji');
expectWidth('🇩🇪', 2, 'flag emoji');

// Padding keeps the rendered column width stable
for (const [text, width] of [['ab', 5], ['中', 4], ['🙂', 3], ['e\u0301', 2], ['verylong', 3]] as const) {
    const padded = padDisplay(text, width);
    assert.strictEqual(
        displayWidth(padded),
        Math.max(width, displayWidth(text)),
        `padDisplay(${JSON.stringify(text)}, ${width}) should keep its display width`
    );
    assert.ok(padded.startsWith(text), 'padding must not alter the text');
}
assert.strictEqual(padDisplay('ab', 1), 'ab', 'padding never truncates');

// Single code point sanity
assert.strictEqual(codePointWidth('A'.codePointAt(0)), 1);
assert.strictEqual(codePointWidth('中'.codePointAt(0)), 2);
assert.strictEqual(codePointWidth(0), 0);

console.log('text width tests passed');
