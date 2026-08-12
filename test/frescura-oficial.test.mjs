import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const source=readFileSync(fileURLToPath(new URL('../build-data.mjs',import.meta.url)),'utf8');
function grabFn(name){const start=source.indexOf('function '+name+'(');assert.ok(start>=0,'falta '+name);const brace=source.indexOf('{',start);let depth=0,quote='',esc=false;for(let i=brace;i<source.length;i++){const c=source[i];if(quote){if(esc)esc=false;else if(c==='\\')esc=true;else if(c===quote)quote='';continue;}if(c==='"'||c==="'"||c==='\x60'){quote=c;continue;}if(c==='{')depth++;else if(c==='}'&&--depth===0)return source.slice(start,i+1);}throw new Error('incompleta '+name);}
const madridMunicipalTimestamp=Function(grabFn('madridMunicipalTimestamp')+';return madridMunicipalTimestamp;')();
test('v91.380 datos: Cala San Pedro queda en cuarentena y no se exporta como oficial',()=>{
  assert.match(source,/JUNTA_FLAG_QUARANTINE = new Set\(\['26'\]\)/);
  assert.match(source,/JUNTA_FLAG_QUARANTINE\.has\(String\(ourId\)\)/);
  assert.doesNotMatch(source,/if\(f&&JUNTA_FLAG\[f\]\)rec\.oflag=JUNTA_FLAG\[f\]/);
});
test('v91.380 datos: sea_condition se observa pero no se publica como estado operativo',()=>{
  assert.match(source,/const JUNTA_SEA_OPERATIONAL = false/);
  assert.match(source,/meta\.count_sea_observed\+\+/);
  assert.match(source,/if\(rec\.oflag\|\|rec\.abierta!=null\)/);
  assert.doesNotMatch(source,/rec\.osea=JUNTA_SEA\[sea\]/);
  assert.doesNotMatch(source,/rec\.oseaSource=JUNTA_ATTR/);
});
test('v91.380 datos: el timestamp municipal de El Ejido respeta Europe Madrid',()=>{
  assert.equal(madridMunicipalTimestamp('2026-07-21 18:24:53'),'2026-07-21T16:24:53.000Z');
  assert.equal(madridMunicipalTimestamp('2026-01-21 18:24:53'),'2026-01-21T17:24:53.000Z');
  assert.equal(madridMunicipalTimestamp('sin fecha'),null);
  assert.match(source,/Math\.min\(\.\.\.timestamps\)/);
  assert.doesNotMatch(source,/oflagSource:EJIDO_ATTR, ofiAt:new Date\(\)\.toISOString\(\)/);
});
test('v91.380 datos: el historico nuevo conserva fuente y solo banderas',()=>{
  assert.match(source,/oflagSource:bd\.oflagSource\|\|null/);
  assert.doesNotMatch(source,/if\(!bd\|\|\(!bd\.oflag&&!bd\.osea\)\)/);
  assert.doesNotMatch(source,/oflag:bd\.oflag\|\|null,osea:/);
});
