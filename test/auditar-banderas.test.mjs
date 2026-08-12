import test from 'node:test';
import assert from 'node:assert/strict';
import {auditRows} from '../auditar-banderas.mjs';
const rows=[];for(let d=1;d<=4;d++)for(let n=0;n<6;n++)rows.push({ts:'2026-08-0'+d+'T1'+n+':00:00Z',id:26,oflag:'roja',oflagSource:'Junta'});
for(let d=1;d<=4;d++)for(let n=0;n<6;n++)rows.push({ts:'2026-08-0'+d+'T1'+n+':00:00Z',id:29,oflag:n===0?'roja':'verde',oflagSource:'Junta'});
test('v91.380 datos: avisa por persistencia suficiente sin declarar que sea falsa',()=>{const out=auditRows(rows,{windowDays:7,minReadings:20,minDays:3});assert.deepEqual(out.map(x=>x.id),[26]);assert.equal(out[0].flag,'roja');});
test('v91.380 datos: no confunde una bandera cambiante con una persistente',()=>{assert.equal(auditRows(rows).some(x=>x.id===29),false);});
