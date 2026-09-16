import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../functions/api/notamUtils.js', import.meta.url), 'utf8');
const { decodeNotamText, parseNotamRow } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const raw = `H7257/26 NOTAMR H4612/26
Q) YMMM/QICAS/I/NBO/A/000/999/3156S11558E005
A) YPPH
B) 2609032321 C) 2611270900 EST
E) ILS &apos;IPH&apos;&#x20;109.9 RWY 24 U/S`;
assert.equal(parseNotamRow({ id: 'H7257/26', message: raw }).rawText, raw.replace('&apos;IPH&apos;&#x20;', "'IPH' "));
assert.equal(decodeNotamText('&#39;IPH&#x27; &quot;ILS&quot; A&amp;B&nbsp;&lt;109.9&gt;'), `'IPH' "ILS" A&B <109.9>`);
assert.equal(decodeNotamText('&#0; &#xD800; &#x110000; &unknown;'), '&#0; &#xD800; &#x110000; &unknown;');
assert.equal(decodeNotamText("ILS 'IPH' 109.9 RWY 24 U/S"), "ILS 'IPH' 109.9 RWY 24 U/S");
assert.equal(decodeNotamText(null), '');
console.log('PASS NOTAM text decoding: user example, named/numeric entities, invalid entities and plain text.');
