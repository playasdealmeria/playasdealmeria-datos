// Prospectivo: respuesta JSON recibida, sin redondeo ni atribución a una pasada.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';

export const ARCHIVE_DIR='archivo_previsiones_v1';
export const MONTH_LIMIT=50*1024*1024;
const sha=b=>createHash('sha256').update(b).digest('hex');
const utc=x=>typeof x==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;

export function makeCapture({stations,payload,query,startedAt,receivedAt}){
  if(!utc(startedAt)||!utc(receivedAt)||Date.parse(receivedAt)<Date.parse(startedAt))throw Error('Fechas de consulta inválidas');
  if(!Array.isArray(stations)||!stations.length||stations.some(s=>!s.id||!Number.isFinite(s.lat)||!Number.isFinite(s.lng)))throw Error('Estaciones inválidas');
  const responses=Array.isArray(payload)?payload:[payload];
  if(responses.length!==stations.length||responses.some(r=>!r||typeof r!=='object'||Array.isArray(r)))throw Error('Respuesta sin correspondencia de estaciones');
  const allowed=['latitude','longitude','hourly','timezone','forecast_hours','wind_speed_unit'];
  if(!query||Object.keys(query).some(k=>!allowed.includes(k))||query.timezone!=='GMT'||query.wind_speed_unit!=='kmh'||query.hourly!=='wind_speed_10m,wind_gusts_10m,wind_direction_10m')throw Error('Contrato de consulta inesperado');
  if(query.latitude!==stations.map(s=>s.lat).join(',')||query.longitude!==stations.map(s=>s.lng).join(','))throw Error('Coordenadas no corresponden');
  return {schema_version:1,kind:'forecast_response',provider:'open_meteo',endpoint:'https://api.open-meteo.com/v1/forecast',model_selection:'best_match',model_run_utc:null,request_started_at:startedAt,response_received_at:receivedAt,query,stations,payload,
    semantics:{time_basis:'response_received_at',time_zone:'GMT',payload:'parsed_json_before_rounding',model_run:'not_supplied',scope:'station_reference_points_not_beach_measurements'},
    quality:responses.map((r,index)=>({station_id:stations[index].id,hourly_time_present:Array.isArray(r.hourly?.time),units:r.hourly_units??null}))};
}

export function packCapture(input){
  const capture=makeCapture(input),raw=Buffer.from(JSON.stringify(capture)+'\n');
  if(raw.length>8*1024*1024)throw Error('Captura supera 8 MiB sin comprimir');
  return {relative:path.join(capture.response_received_at.slice(0,7),sha(raw)+'.json.gz'),bytes:gzipSync(raw,{level:9})};
}

export function inspectCapture(relative,bytes){
  if(!/^\d{4}-\d{2}[\\/][a-f0-9]{64}\.json\.gz$/.test(relative))throw Error('Ruta de captura inválida');
  const raw=gunzipSync(bytes,{maxOutputLength:8*1024*1024}),c=JSON.parse(raw);
  const expected=makeCapture({stations:c.stations,payload:c.payload,query:c.query,startedAt:c.request_started_at,receivedAt:c.response_received_at});
  if(JSON.stringify(c)!==JSON.stringify(expected)||path.basename(relative)!==sha(raw)+'.json.gz'||relative.slice(0,7)!==c.response_received_at.slice(0,7))throw Error('Captura o huella incoherente');
  return c;
}

export function inventory(root){
  if(!fs.existsSync(root))return [];
  if(!fs.lstatSync(root).isDirectory()||fs.lstatSync(root).isSymbolicLink())throw Error('Archivo debe ser directorio real');
  const out=[];
  for(const month of fs.readdirSync(root,{withFileTypes:true})){
    if(!/^\d{4}-\d\d$/.test(month.name)||!month.isDirectory()||month.isSymbolicLink())throw Error('Entrada de archivo inesperada');
    for(const f of fs.readdirSync(path.join(root,month.name),{withFileTypes:true})){
      if(!f.isFile()||f.isSymbolicLink())throw Error('Entrada de captura inesperada');
      const relative=path.join(month.name,f.name),bytes=fs.readFileSync(path.join(root,relative));
      const capture=inspectCapture(relative,bytes);out.push({relative,bytes,capture});
    }
  }
  return out;
}

// Prevalida TODO antes de escribir. Publica cada fichero completo sin sobrescribir.
export function storeCaptures(root,entries,{monthLimit=MONTH_LIMIT}={}){
  if(!Number.isSafeInteger(monthLimit)||monthLimit<=0)throw Error('Límite inválido');
  const existing=inventory(root),byPath=new Map(existing.map(x=>[x.relative,x])),totals=new Map();
  for(const e of existing)totals.set(e.relative.slice(0,7),(totals.get(e.relative.slice(0,7))||0)+e.bytes.length);
  const pending=[];
  for(const e of entries){
    inspectCapture(e.relative,e.bytes);
    const prior=byPath.get(e.relative);
    if(prior){if(!gunzipSync(prior.bytes).equals(gunzipSync(e.bytes)))throw Error('Colisión de captura');continue;}
    const month=e.relative.slice(0,7),size=(totals.get(month)||0)+e.bytes.length;
    if(size>monthLimit)throw Error('Archivo mensual lleno: conservar y revisar almacenamiento; no se borra historia');
    totals.set(month,size);byPath.set(e.relative,e);pending.push(e);
  }
  for(const e of pending){
    const dest=path.join(root,e.relative);fs.mkdirSync(path.dirname(dest),{recursive:true});
    const temporary=dest+'.tmp-'+randomUUID();
    try{fs.writeFileSync(temporary,e.bytes,{flag:'wx'});fs.linkSync(temporary,dest);}
    finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  }
  return pending.length;
}

export function saveCapture(root,input){return storeCaptures(root,[packCapture(input)]);}
export function copyArchive(source,destination){
  if(!fs.existsSync(source))return 0;
  if(path.resolve(source)===path.resolve(destination))throw Error('Origen y destino iguales');
  return storeCaptures(destination,inventory(source));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const [command,source,destination,...extra]=process.argv.slice(2);
    if(command!=='copy'||!source||!destination||extra.length)throw Error('Uso: node archivo-previsiones.mjs copy ORIGEN DESTINO');
    console.log('Capturas conservadas:',copyArchive(source,destination));
  }catch(e){console.error(e.message);process.exitCode=1;}
}
