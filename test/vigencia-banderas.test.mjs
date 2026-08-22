import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const source=readFileSync(fileURLToPath(new URL('../build-data.mjs',import.meta.url)),'utf8');
function grabFn(name){const start=source.indexOf('function '+name+'(');assert.ok(start>=0,'falta '+name);const brace=source.indexOf('{',start);let depth=0,quote='',esc=false;for(let i=brace;i<source.length;i++){const c=source[i];if(quote){if(esc)esc=false;else if(c==='\\')esc=true;else if(c===quote)quote='';continue;}if(c==='"'||c==="'"||c==='\x60'){quote=c;continue;}if(c==='{')depth++;else if(c==='}'&&--depth===0)return source.slice(start,i+1);}throw new Error('incompleta '+name);}
const roquetasSourceDay=Function(grabFn('roquetasSourceDay')+';return roquetasSourceDay;')();
test('v91.381 datos: Roquetas extrae exclusivamente la fecha declarada para hoy',()=>{
  assert.equal(roquetasSourceDay('<p>AEMET para el día de hoy, 20/08/2026</p>'),'2026-08-20');
  assert.equal(roquetasSourceDay('<p>AEMET para el d&iacute;a de hoy: 1/2/2026</p>'),'2026-02-01');
  assert.equal(roquetasSourceDay('<p>Actualizado 20/08/2026 sin declarar día de hoy</p>'),null);
});
test('v91.381 datos: la Junta y Vera conservan publicación pero no fabrican hora oficial',()=>{
  assert.match(source,/oflagFreshness='unknown'/);
  assert.match(source,/oflagFreshness:'unknown'/);
  assert.doesNotMatch(source,/if(rec.oflag){rec.oflagSource=JUNTA_ATTR;rec.ofiAt=checkedAt;/);
  assert.doesNotMatch(source,/out['37']={oflag:flag,oflagSource:VERA_ATTR,ofiAt:new Date().toISOString()/);
});
test('v91.381 datos: El Ejido usa source-time y Roquetas exige source-day de hoy',()=>{
  assert.ok(source.includes("oflagFreshness:'source-time'"));
  assert.ok(source.includes('dateVerified=sourceDay===madridDayISO(checkedAt)'));
  assert.ok(source.includes("oflagFreshness:sourceDay?'source-day':'unknown'"));
  assert.ok(source.includes('ofiAt:dateVerified?checkedAt:null'));
});
test('v91.381 datos: el merge copia todo el contrato y el histórico exige ofiAt verificable',()=>{
  assert.ok(source.includes("'oflagCheckedAt','oflagSourceAt','oflagSourceDay','oflagFreshness'"));
  assert.ok(source.includes('if(!bd||!bd.oflag||!bd.ofiAt) continue'));
  assert.ok(source.includes('official_sources:'));
});
test('v91.381 datos: los logs separan colores publicados de vigencias acreditadas',()=>{
  assert.match(source,/Junta:.*colores publicados.*vigencias acreditadas/s);
  assert.match(source,/Roquetas:.*fecha fuente/s);
  assert.match(source,/oficiales verificadas/);
});
