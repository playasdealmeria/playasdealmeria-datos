import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {plan,decode,collect,restore,inspect,safeRoot,readCapture,sha} from '../actividades/collector.mjs';
const catalog=JSON.parse(fs.readFileSync(new URL('../actividades/catalog.json',import.meta.url)));
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'pda-activities-'));
function response(task){return task.points.map((p,i)=>({location_id:i,latitude:p.lat,longitude:p.lon,utc_offset_seconds:0,hourly:{time:['2026-09-26T00:00','2026-09-26T01:00'],...Object.fromEntries(Object.keys(task.variables).map(v=>[v,[0,null]]))},hourly_units:task.variables}));}
const mock=async url=>{const task=plan(catalog).find(t=>t.url===url);return {status:200,body:Buffer.from(JSON.stringify(response(task)))}};
const opts=root=>({catalog,root,cycle:'20260926T12',request:mock,delay:async()=>{},now:()=> '2026-09-26T12:00:00.000Z'});
test('49 playas, 147 puntos, 15 consultas agrupadas; óptica explícita',()=>{assert.equal(plan(catalog).length,15);assert.equal(plan(catalog,{opticalDate:'2026-09-24'}).length,309);assert.equal(plan(catalog).flatMap(t=>t.points).length,147);assert.throws(()=>plan({...catalog,beaches:catalog.beaches.slice(1)}));});
test('cero no es hueco; normalización conserva null',()=>{const t=plan(catalog)[0],r=decode(t,JSON.stringify(response(t)));assert.deepEqual(r[0].variables.wind_speed_10m.values_normalized,[0,null]);assert.equal(r[0].variables.wind_speed_10m.status,'partial_numeric');});
test('unidades cambiadas y campos ausentes no producen valores normalizados',()=>{const t=plan(catalog)[0],d=response(t);d[0].hourly_units={...t.variables,wind_speed_10m:'kn'};delete d[0].hourly.cloud_cover;const r=decode(t,JSON.stringify(d))[0];assert.equal(r.variables.wind_speed_10m.status,'unit_unexpected');assert.equal(r.variables.wind_speed_10m.values_normalized,null);assert.equal(r.variables.cloud_cover.status,'field_absent');});
test('rechaza posiciones, fechas y husos incompatibles',()=>{const t=plan(catalog)[0];for(const change of [d=>d.pop(),d=>d[0].location_id=8,d=>d[0].utc_offset_seconds=3600,d=>d[0].hourly.time.reverse()]){const d=response(t);change(d);assert.throws(()=>decode(t,JSON.stringify(d)));}});
test('captura, integridad, idempotencia sin red y restauración independiente',async()=>{const root=tmp(),r=await collect(opts(root));assert.equal(r.requests,15);inspect(r.directory);const c=readCapture(r.directory);assert.equal(c.records.length,15);assert.equal(c.semantics.optical,'not_requested');assert.equal((await collect({...opts(root),request:()=>{throw Error('No debe consultar')}})).status,'already_saved');const dest=tmp();assert.equal(restore(root,dest),1);assert.equal(restore(root,dest),0);inspect(path.join(dest,'20260926T12'));});
test('fallos HTTP se conservan y frenan nuevas peticiones al proveedor',async()=>{let calls=0;const r=await collect({...opts(tmp()),request:async()=>{calls++;return {status:429,body:Buffer.from('{"error":true}')}}});assert.equal(calls,2);assert.equal(r.status,'saved_with_gaps');assert.equal(r.failed_or_skipped_requests,15);inspect(r.directory);});
test('presupuesto y captura pendiente abortan antes de consultar',async()=>{let calls=0;const root=tmp();await assert.rejects(collect({...opts(root),limit:1,request:()=>{calls++}}));fs.mkdirSync(path.join(root,'20260926T12.pending'));await assert.rejects(collect({...opts(root),request:()=>{calls++}}));assert.equal(calls,0);});
test('corrupción no se restaura ni se acepta como captura previa',async()=>{const root=tmp(),r=await collect(opts(root));fs.appendFileSync(path.join(r.directory,'raw-000.gz'),'bad');assert.throws(()=>inspect(r.directory));const dest=tmp();assert.throws(()=>restore(root,dest));assert.equal(fs.readdirSync(dest).length,0);await assert.rejects(collect(opts(root)));});
test('destino en repo rechazado',()=>{const p=tmp();fs.mkdirSync(path.join(p,'.git'));assert.throws(()=>safeRoot(path.join(p,'capture')));});
test('bloqueo de escritor y restauración solapada',async()=>{const p=tmp();fs.writeFileSync(path.join(p,'.writer.lock'),'other');await assert.rejects(collect(opts(p)));assert.equal(fs.readFileSync(path.join(p,'.writer.lock'),'utf8'),'other');assert.throws(()=>restore(p,path.join(p,'sub')));});
test('óptica valida identidad y conserva nulo sin inventar claridad',()=>{const t=plan(catalog,{opticalDate:'2026-09-24'})[15];const d={features:[{properties:{lat:36.7,lon:-2.2,variableId:t.variable,datasetId:t.dataset,value:null,units:'FNU'}}]};assert.equal(decode(t,JSON.stringify(d))[0].status,'cell_no_numeric');d.features[0].properties.variableId='other';assert.throws(()=>decode(t,JSON.stringify(d)));});
test('compresión sin pérdidas y lectura/restauración de captura antigua',async()=>{
 const root=tmp(),r=await collect(opts(root)),original=readCapture(r.directory),packed=fs.readFileSync(path.join(r.directory,'capture.json.gz')),raw=gunzipSync(packed);assert.deepEqual(JSON.parse(raw),original);assert.ok(packed.length<raw.length);
 const m=inspect(r.directory);const f=m.files.find(f=>f.name==='capture.json.gz');f.name='capture.json';f.bytes=raw.length;f.sha256=sha(raw);
 fs.writeFileSync(path.join(r.directory,'capture.json'),raw);fs.unlinkSync(path.join(r.directory,'capture.json.gz'));fs.writeFileSync(path.join(r.directory,'manifest.json'),JSON.stringify(m));
 assert.deepEqual(readCapture(r.directory),original);assert.equal((await collect({...opts(root),request:()=>{throw Error('No red')}})).status,'already_saved');const dest=tmp();restore(root,dest);assert.deepEqual(readCapture(path.join(dest,'20260926T12')),original);
});
test('gzip corrupto o expansión excesiva se rechaza aun con hash actualizado',async()=>{
 const r=await collect(opts(tmp())),m=inspect(r.directory),f=m.files.find(f=>f.name==='capture.json.gz');
 for(const b of [Buffer.from('no gzip'),gzipSync(Buffer.alloc(65*1024*1024))]){fs.writeFileSync(path.join(r.directory,f.name),b);f.bytes=b.length;f.sha256=sha(b);fs.writeFileSync(path.join(r.directory,'manifest.json'),JSON.stringify(m));assert.throws(()=>readCapture(r.directory));}
});

