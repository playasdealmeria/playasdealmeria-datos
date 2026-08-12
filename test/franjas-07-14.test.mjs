import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const src=readFileSync(fileURLToPath(new URL('../build-data.mjs',import.meta.url)),'utf8');
test('v91.378 datos: las partes cubren 07-22 sin huecos ni solape',()=>{
  assert.ok(src.includes('/* v91.378: partes 07-14 y 14-22; dia completo 07-22 */'));
  const m=/morning:summarizePart\(dateStr,(\d+),(\d+),/.exec(src);
  const a=/afternoon:summarizePart\(dateStr,(\d+),(\d+),/.exec(src);
  assert.ok(m&&a);assert.deepEqual(m.slice(1).map(Number),[7,14]);assert.deepEqual(a.slice(1).map(Number),[14,22]);
  assert.equal(Number(m[2]),Number(a[1]));
});
test('v91.378 datos: agua y periodo marino usan la misma jornada completa',()=>{
  assert.equal((src.match(/hh>=7&&hh<22/g)||[]).length,2);
  assert.doesNotMatch(src,/hh>=8&&hh<22/);
  assert.doesNotMatch(src,/summarizePart\(dateStr,8,15/);
  assert.doesNotMatch(src,/summarizePart\(dateStr,15,22/);
});
