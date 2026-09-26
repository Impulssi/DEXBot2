/**
 * modules/utils/text_width.ts - Terminal display-width helpers.
 *
 * `String.prototype.length` and `padEnd` count UTF-16 code units, so CJK
 * glyphs (width 2) and combining marks (width 0) break column alignment in
 * console tables. These helpers count terminal cells instead and pad by
 * display width. Pure string logic — browser-safe, no Node dependencies.
 */

/**
 * Width of a single Unicode code point in terminal cells.
 * 0 for control chars / combining marks, 2 for East-Asian wide and emoji,
 * otherwise 1.
 */
export function codePointWidth(codePoint: number): number {
    if (codePoint === 0) return 0;
    if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
    if (isCombining(codePoint)) return 0;
    return isFullWidth(codePoint) ? 2 : 1;
}

/** Grapheme-aware display width of a string. */
export function displayWidth(text: string): number {
    if (!text) return 0;
    let width = 0;
    for (const grapheme of segmentGraphemes(text)) {
        width += graphemeWidth(grapheme);
    }
    return width;
}

function graphemeWidth(grapheme: string): number {
    const codePoints: number[] = [];
    for (const char of grapheme) codePoints.push(char.codePointAt(0) as number);
    // A flag emoji is a pair of regional indicators and renders as one
    // two-cell glyph even though each indicator is one cell on its own.
    if (codePoints.length === 2 && codePoints.every(isRegionalIndicator)) return 2;
    let width = 0;
    for (const codePoint of codePoints) width = Math.max(width, codePointWidth(codePoint));
    return width;
}

/** Pad `text` with spaces on the right to reach `width` terminal cells. */
export function padDisplay(text: string, width: number): string {
    return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

function isCombining(codePoint: number): boolean {
    return (
        (codePoint >= 0x0300 && codePoint <= 0x036f) || // combining diacritics
        (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
        (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
        (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
        (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
        (codePoint >= 0xfe00 && codePoint <= 0xfe0f) // variation selectors
    );
}

function isRegionalIndicator(codePoint: number): boolean {
    return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
    [0x1100, 0x115f], // Hangul Jamo
    [0x2e80, 0x303e], // CJK radicals, Kangxi
    [0x3041, 0x33ff], // Hiragana/Katakana, CJK symbols
    [0x3400, 0x4dbf], // CJK Ext A
    [0x4e00, 0x9fff], // CJK Unified
    [0xa000, 0xa4cf], // Yi
    [0xac00, 0xd7a3], // Hangul syllables
    [0xf900, 0xfaff], // CJK compatibility
    [0xfe10, 0xfe19],
    [0xfe30, 0xfe6f],
    [0xff00, 0xff60], // fullwidth forms
    [0xffe0, 0xffe6],
    [0x1f300, 0x1faff], // emoji & pictographs
    [0x20000, 0x3fffd], // CJK Ext B+
];

function isFullWidth(codePoint: number): boolean {
    for (const [start, end] of WIDE_RANGES) {
        if (codePoint >= start && codePoint <= end) return true;
    }
    return false;
}

const segmenter: Intl.Segmenter | null =
    typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        : null;

function* segmentGraphemes(text: string): Iterable<string> {
    if (!segmenter) {
        yield* text;
        return;
    }
    for (const { segment } of segmenter.segment(text)) {
        yield segment;
    }
}
