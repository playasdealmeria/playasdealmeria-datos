import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import vm from 'node:vm';
import {makeCapture,packCapture,inspectCapture,inventory,storeCaptures,saveCapture,copyArchive} from '../archivo-previsiones.mjs';
const fixture=()=>({stations:[{id:'TEST',lat:36.8,lng:-2.4}],startedAt:'2026-09-26T09:00:00.000Z',receivedAt:'2026-09-26T09:00:02.000Z',query:{latitude:'36.8',longitude:'-2.4',timezone:'GMT',wind_speed_unit:'kmh',hourly:'wind_speed_10m,wind_gusts_10m,wind_direction_10m',forecast_hours:'26'},payload:{latitude:36.81,longitude:-2.41,utc_offset_seconds:0,hourly_units:{time:'iso8601',wind_speed_10m:'km/h'},hourly:{time:['2026-09-26T10:00','2026-09-26T11:00','2026-09-26T12:00'],wind_speed_10m:[0,null,12.34567],wind_gusts_10m:[0,22.222,null],wind_direction_10m:[0,null,360]}}});
const dir=()=>fs.mkdtempSync(path.join(os.tmpdir(),'pda-archive389-'));
test('conserva JSON completo, nulos, ceros, decimales y celda sin redondear',()=>{
 const f=fixture(),p=packCapture(f),c=inspectCapture(p.relative,p.bytes);
 assert.deepEqual(c.payload,f.payload);assert.equal(c.model_run_utc,null);assert.equal(c.response_received_at,f.receivedAt);assert.equal(c.query.forecast_hours,'26');
});
test('capturas idénticas son idempotentes; recibidas después son distintas',()=>{
 const root=dir(),f=fixture();assert.equal(saveCapture(root,f),1);assert.equal(saveCapture(root,f),0);
 assert.equal(saveCapture(root,{...f,receivedAt:'2026-09-26T09:00:03.000Z'}),1);assert.equal(inventory(root).length,2);
});
test('rechaza fechas invertidas o sin zona y correspondencia errónea',()=>{
 for(const update of [{receivedAt:'2026-09-26T09:00:00'},{receivedAt:'2026-09-25T09:00:00.000Z'},{payload:[]},{stations:[]}])assert.throws(()=>makeCapture({...fixture(),...update}));
});
test('preserva respuesta incompleta con calidad explícita, sin fabricar valores',()=>{
 const f=fixture();f.payload={latitude:36.8,longitude:-2.4};const c=makeCapture(f);
 assert.equal(c.quality[0].hourly_time_present,false);assert.equal(c.quality[0].units,null);assert.deepEqual(c.payload,f.payload);
});
test('contrato de consulta excluye claves ajenas y coordenadas discordantes',()=>{
 for(const update of [{apikey:'test'},{latitude:'0'},{timezone:'auto'},{wind_speed_unit:'ms'}])assert.throws(()=>makeCapture({...fixture(),query:{...fixture().query,...update}}));
});
test('corrupción o nombre manipulado abortan antes de crear archivos',()=>{
 const root=dir(),p=packCapture(fixture());assert.throws(()=>storeCaptures(root,[p,{...p,relative:p.relative.replace('2026-09','2026-08')}]));assert.deepEqual(fs.readdirSync(root),[]);
 assert.throws(()=>inspectCapture(p.relative,Buffer.from('truncado')));
 assert.throws(()=>inspectCapture('../'+p.relative,p.bytes));
});
test('el sobre también se valida aunque el gzip pueda abrirse',()=>{
 const p=packCapture(fixture()),c=JSON.parse(gunzipSync(p.bytes));c.model_run_utc=c.response_received_at;
 assert.throws(()=>inspectCapture(p.relative,gzipSync(JSON.stringify(c))));
});
test('límite de almacenamiento no borra ni escribe parcialmente',()=>{
 const root=dir(),p=packCapture(fixture()),p2=packCapture({...fixture(),receivedAt:'2026-09-26T09:00:03.000Z'});
 assert.throws(()=>storeCaptures(root,[p,p2],{monthLimit:p.bytes.length}));assert.deepEqual(fs.readdirSync(root),[]);
 storeCaptures(root,[p]);assert.throws(()=>storeCaptures(root,[p2],{monthLimit:p.bytes.length}));assert.equal(inventory(root).length,1);
});
test('reintento conserva captura inicial, remota y regenerada sin duplicarlas',()=>{
 const initial=dir(),backup=dir(),remote=dir();const a=fixture(),b={...fixture(),receivedAt:'2026-09-26T09:01:00.000Z'},c={...fixture(),receivedAt:'2026-09-26T09:02:00.000Z'};
 saveCapture(initial,a);copyArchive(initial,backup);saveCapture(remote,b);assert.equal(copyArchive(backup,remote),1);saveCapture(remote,c);assert.equal(copyArchive(backup,remote),0);
 assert.equal(inventory(remote).length,3);assert.deepEqual(inventory(backup).map(e=>e.capture.payload),[a.payload]);
});
test('cambio de mes conserva los dos meses y no reinterpreta tiempos',()=>{
 const root=dir();saveCapture(root,fixture());saveCapture(root,{...fixture(),startedAt:'2026-09-30T23:59:59.000Z',receivedAt:'2026-10-01T00:00:01.000Z'});
 assert.deepEqual(fs.readdirSync(root),['2026-09','2026-10']);
});
test('archivo existente corrupto no se sobrescribe al recuperar',()=>{
 const source=dir(),dest=dir(),p=packCapture(fixture());storeCaptures(source,[p]);storeCaptures(dest,[p]);fs.writeFileSync(path.join(dest,p.relative),'corrupto');
 assert.throws(()=>copyArchive(source,dest));assert.equal(fs.readFileSync(path.join(dest,p.relative),'utf8'),'corrupto');
});
test('flujo registra la misma consulta y protege captura antes del reset de reintento',()=>{
 const code=fs.readFileSync(new URL('../validar-rachas.mjs',import.meta.url),'utf8'),y=fs.readFileSync(new URL('../.github/workflows/update-data.yml',import.meta.url),'utf8');
 assert.match(code,/saveCapture\(join\(DIR,ARCHIVE_DIR\)/);assert.match(code,/forecastRecords\(STATIONS,payload,receivedAt,NOMINAL_LEADS\)/);
 assert.ok(y.indexOf('copy archivo_previsiones_v1 "$ARCHIVE_BACKUP"')<y.indexOf('if ! git push'));
 assert.match(y,/git reset --hard origin\/main\s+node archivo-previsiones.mjs copy "\$ARCHIVE_BACKUP" archivo_previsiones_v1/);
 assert.equal((y.match(/git add archivo_previsiones_v1/g)||[]).length,2);
});
test('fallo del archivo se hace visible sin perder la salida v2 ni repetir consulta',async()=>{
 const code=fs.readFileSync(new URL('../validar-rachas.mjs',import.meta.url),'utf8');
 const fn=code.slice(code.indexOf('async function fetchForecasts('),code.indexOf('async function main('));
 let requests=0,kept=0;const fakeProcess={},messages=[];
 const ctx=vm.createContext({URLSearchParams,Date,STATIONS:fixture().stations,NOMINAL_LEADS:[1,6,12,24],DIR:'fixture',ARCHIVE_DIR:'archive',join:path.join,process:fakeProcess,console:{error:x=>messages.push(x)},getJSON:async()=>{requests++;return fixture().payload;},saveCapture:()=>{throw Error('disco lleno');},forecastRecords:(stations,payload,received)=>{assert.deepEqual(payload,fixture().payload);assert.match(received,/Z$/);kept++;return ['v2-preservado'];}});
 vm.runInContext(fn,ctx);assert.deepEqual(await ctx.fetchForecasts(),['v2-preservado']);assert.equal(requests,1);assert.equal(kept,1);assert.equal(fakeProcess.exitCode,1);assert.match(messages[0],/no conservado.*disco lleno/);
});
