import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as policy from '../flag-integrity.mjs';
const source=fs.readFileSync(new URL('../build-data.mjs',import.meta.url),'utf8');
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/official-flags-v386.json',import.meta.url),'utf8'));
const catalog=JSON.parse(fs.readFileSync(new URL('../playas_catalogo.json',import.meta.url),'utf8'));
const NOW=Date.parse('2026-09-12T16:40:00Z');
const valid={oflag:'verde',oflagSource:'Ayuntamiento de El Ejido',oflagMunicipality:'El Ejido',oflagFreshness:'source-time',oflagSourceAt:'2026-09-12T16:20:00Z',oflagCheckedAt:'2026-09-12T16:40:00Z'};
class FixedDate extends Date{constructor(...args){super(...(args.length?args:[NOW]));}static now(){return NOW;}}
function sourceFunctions(response){
  const ejido=source.slice(source.indexOf('const EJIDO_OFICIAL ='),source.indexOf('const __EJIDO_RES__='));
  const roquetas=source.slice(source.indexOf('const ROQUETAS_OFICIAL ='),source.indexOf('const __ROQUETAS_RES__='));
  return vm.runInNewContext(ejido+'\n'+roquetas+';({fetchEjidoOficial,fetchRoquetasOficial,ROQUETAS_MAP});',{
    process:{env:{}},console:{log(){}},Date:FixedDate,Intl,AbortController,setTimeout,clearTimeout,JUNTA_UA:'test',
    ...policy,flagIsCurrent:record=>policy.flagIsCurrent(record,NOW),flagMetrics:records=>policy.flagMetrics(records,NOW),
    fetch:async()=>({ok:true,json:async()=>response,text:async()=>response})
  });
}
test('la captura real de Roquetas nunca asigna Ventilla a Nueva Almería ni usa el día AEMET',async()=>{
  const {fetchRoquetasOficial,ROQUETAS_MAP}=sourceFunctions(fixture.roquetas);
  assert.deepEqual(Object.keys(ROQUETAS_MAP),['6','7','8']);
  for(const id of Object.keys(ROQUETAS_MAP))assert.equal(catalog.find(b=>String(b.id)===id).municipio,'Roquetas de Mar');
  assert.equal(catalog.find(b=>b.id===11).municipio,'Almería');
  const {data,meta}=await fetchRoquetasOficial();
  assert.equal(data['11'],undefined);assert.equal(meta.count_flags,3);assert.equal(meta.count_flags_verified,0);
  for(const row of Object.values(data)){assert.equal(row.oflagFreshness,'unknown');assert.equal(row.ofiAt,null);assert.equal(row.oflagSourceDay,null);}
});
test('Serena requiere ambos sectores; ausencia o contradicción no hereda otro tooltip',async()=>{
  const html='<p>AEMET para el día de hoy, 12/09/2026</p><div id="tooltip_playa_serena"><img src="bandera-verde.png"></div>';
  assert.equal((await sourceFunctions(html).fetchRoquetasOficial()).data['8'],undefined);
  const both=html+'<div id="tooltip_urbanizacion_roquetas"><img src="bandera-roja.png"></div>';
  assert.equal((await sourceFunctions(both).fetchRoquetasOficial()).data['8'].oflag,'roja');
  assert.equal(policy.roquetasFlag('<div id="tooltip_aguadulce">bandera-verde bandera-roja</div>','aguadulce'),null);
  assert.equal(policy.roquetasFlag('<div id="tooltip_aguadulce"></div><div id="tooltip_romanilla">bandera-roja</div>','aguadulce'),null);
});
test('El Ejido: captura de fin de temporada conserva procedencia, cero vigencias',async()=>{
  const {data,meta}=await sourceFunctions(fixture.ejido).fetchEjidoOficial();
  assert.equal(meta.count_flags,3);assert.equal(meta.count_flags_timestamped,3);assert.equal(meta.count_flags_verified,0);
  for(const row of Object.values(data)){assert.equal(row.oflagServiceActive,false);assert.equal(row.ofiAt,null);assert.equal(row.oflagFreshness,'unknown');assert.match(row.oflagSourceAt,/^2026-09-06/);}
});
test('El Ejido: un sector cerrado o antiguo invalida vigencia del agregado; nunca rejuvenece la hora',async()=>{
  const active=fixture.ejido.map(row=>({...row,isSocorrismo:1,actualizado:'2026-09-12 18:20:00'}));
  let result=await sourceFunctions(active).fetchEjidoOficial();
  assert.equal(result.meta.count_flags_verified,3);assert.equal(result.data['4'].ofiAt,'2026-09-12T16:20:00.000Z');
  active.find(row=>row.id===2).actualizado='2026-09-12 10:00:00';
  result=await sourceFunctions(active).fetchEjidoOficial();
  assert.equal(result.meta.count_flags_verified,2);assert.equal(result.data['4'].ofiAt,null);
  assert.equal(result.data['4'].oflagSourceAt,'2026-09-12T08:00:00.000Z');
  active.find(row=>row.id===6).isSocorrismo=0;
  result=await sourceFunctions(active).fetchEjidoOficial();assert.equal(result.meta.count_flags_verified,1);
});
test('vigencia: límites de edad, fechas futuras, medianoche y ausencia de evidencia',()=>{
  assert.equal(policy.flagIsCurrent(valid,NOW),true);
  for(const delta of [-10800001,300001])assert.equal(policy.flagIsCurrent({...valid,oflagSourceAt:new Date(NOW+delta).toISOString()},NOW),false);
  for(const delta of [-10800000,300000])assert.equal(policy.flagIsCurrent({...valid,oflagSourceAt:new Date(NOW+delta).toISOString()},NOW),true);
  assert.equal(policy.flagIsCurrent({...valid,oflagServiceActive:false},NOW),false);
  assert.equal(policy.flagIsCurrent({...valid,oflagSourceAt:'sin fecha'},NOW),false);
  assert.equal(policy.flagIsCurrent({...valid,oflagFreshness:'unknown'},NOW),false);
  assert.equal(policy.flagIsCurrent({...valid,oflagSourceAt:'2026-09-12T21:55:00Z'},Date.parse('2026-09-12T22:05:00Z')),false);
  const daily={oflag:'amarilla',oflagFreshness:'source-day',oflagSourceDay:'2026-09-12',oflagCheckedAt:new Date(NOW).toISOString()};
  assert.equal(policy.flagIsCurrent(daily,NOW),true);
  assert.equal(policy.flagIsCurrent({...daily,oflagSourceDay:'2026-09-11'},NOW),false);
});
test('identidad y vigencia prevalecen sobre prioridad; no mezcla pruebas de fuentes diferentes',()=>{
  const beach={id:11,municipio:'Almería'};
  const wrong={...valid,oflagMunicipality:'Roquetas de Mar',oflagSource:'Ayuntamiento de Roquetas de Mar'};
  const junta={...valid,oflagSource:'Junta de Andalucía',oflagMunicipality:undefined};
  const stale={...valid,oflagSource:'Ayuntamiento de Almería',oflagMunicipality:'Almería',oflagFreshness:'unknown',oflagSourceAt:undefined};
  assert.equal(policy.mergeOfficialFlag({days:[1]},junta,[wrong,stale],beach,NOW).oflagSource,'Junta de Andalucía');
  const unknownJunta={...junta,oflagFreshness:'unknown'};
  const merged=policy.mergeOfficialFlag({},unknownJunta,[stale],beach,NOW);
  assert.equal(merged.oflagSource,'Ayuntamiento de Almería');assert.equal(merged.oflagSourceAt,undefined);
  assert.equal(policy.mergeOfficialFlag({},undefined,[wrong],beach,NOW).oflag,undefined);
  assert.equal(policy.flagMatchesBeach({...stale,oflagMunicipality:undefined},beach),false);
  assert.deepEqual(policy.mergeOfficialFlag({days:[1]},undefined,[wrong],beach,NOW).days,[1]);
});
test('histórico: solo añade lecturas vigentes y guarda su fecha propia',async()=>{
  const writes=[];
  const begin=source.indexOf('async function appendFlagHistory('),end=source.indexOf('// ===== fin archivo histórico de banderas =====',begin);
  const fn=vm.runInNewContext(source.slice(begin,end).replace('import.meta.url',JSON.stringify(import.meta.url))+';appendFlagHistory',{
    Date:FixedDate,URL,console:{log(){}},madridParts:()=>({year:2026,month:'09',hour:18}),currentHourWeather:()=>({}),
    flagIsCurrent:policy.flagIsCurrent,appendFile:async(file,content)=>writes.push(content)
  });
  await fn({good:{...valid,ofiAt:valid.oflagSourceAt},old:{...valid,ofiAt:'2026-09-06T15:22:22Z',oflagSourceAt:'2026-09-06T15:22:22Z'},closed:{...valid,ofiAt:valid.oflagSourceAt,oflagServiceActive:false}},[]);
  assert.equal(writes.length,1);
  const lines=writes[0].trim().split('\n').map(JSON.parse);assert.equal(lines.length,1);
  assert.equal(lines[0].oflagSourceAt,valid.oflagSourceAt);assert.equal(lines[0].flag_schema_version,2);
  assert.ok(source.includes('official_flag_summary:flagMetrics(beaches)'));
});
