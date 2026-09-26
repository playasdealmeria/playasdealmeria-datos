import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
export const sha=b=>createHash('sha256').update(b).digest('hex');
export const WEATHER={wind_speed_10m:'km/h',wind_gusts_10m:'km/h',wind_direction_10m:'°',precipitation:'mm',temperature_2m:'°C',cloud_cover:'%',shortwave_radiation:'W/m²'};
export const MARINE={wave_height:'m',wave_direction:'°',wave_period:'s',wave_peak_period:'s',wind_wave_height:'m',wind_wave_direction:'°',wind_wave_period:'s',swell_wave_height:'m',swell_wave_direction:'°',swell_wave_period:'s',sea_surface_temperature:'°C',ocean_current_velocity:'km/h',ocean_current_direction:'°',sea_level_height_msl:'m'};
const OPT='OCEANCOLOUR_MED_BGC_HR_L3_NRT_009_205/cmems_obs_oc_med_bgc_tur-spm-chl_nrt_l3-hr-mosaic_P1D-m_202107/';
const HOSTS=new Set(['api.open-meteo.com','marine-api.open-meteo.com','wmts.marine.copernicus.eu']);
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const iso=s=>typeof s==='string'&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString()===s;
export function catalogCheck(c){
  if(c?.beaches?.length!==49||new Set(c.beaches.map(b=>b.id)).size!==49)throw Error('Se requieren 49 playas únicas');
  for(const b of c.beaches){
    if(!Number.isInteger(b.id)||!Array.isArray(b.points)||b.points.length!==3||new Set(b.points.map(p=>p.role)).size!==3)throw Error('Catálogo inválido');
    for(const p of b.points)if(!['reference','near','context'].includes(p.role)||!finite(p.lat)||!finite(p.lon)||p.lat<35||p.lat>38||p.lon< -4||p.lon>0)throw Error('Punto inválido');
  }
}
export function plan(c,{opticalDate=null}={}){
  catalogCheck(c);const tasks=[];
  for(const [kind,roles,variables,endpoint] of [['weather',['reference'],WEATHER,'https://api.open-meteo.com/v1/forecast'],['marine',['near','context'],MARINE,'https://marine-api.open-meteo.com/v1/marine']]){
    for(const role of roles){const points=c.beaches.map(b=>({beach_id:b.id,...b.points.find(p=>p.role===role)}));
      for(let i=0;i<points.length;i+=10){const group=points.slice(i,i+10);const q={latitude:group.map(p=>p.lat).join(','),longitude:group.map(p=>p.lon).join(','),hourly:Object.keys(variables).join(','),timezone:'GMT',forecast_days:'3',past_days:'3',models:'best_match'};
        if(kind==='marine')q.cell_selection='sea';else q.wind_speed_unit='kmh';
        tasks.push({kind,points:group,variables,url:endpoint+'?'+new URLSearchParams(q),data_type:'forecast',model_selection:'best_match',model_run_utc:null});
      }
    }
  }
  if(opticalDate!==null){
    if(!/^\d{4}-\d\d-\d\d$/.test(opticalDate)||new Date(opticalDate).toISOString().slice(0,10)!==opticalDate)throw Error('Fecha óptica inválida');
    for(const b of c.beaches)for(const p of b.points.filter(p=>p.role!=='reference'))for(const variable of ['TUR','SPM','CHL']){
      const n=1024,tile=768,x=(p.lon+180)/360*n,y=(1-Math.asinh(Math.tan(p.lat*Math.PI/180))/Math.PI)/2*n;
      const col=Math.floor(x),row=Math.floor(y),i=Math.floor((x-col)*tile),j=Math.floor((y-row)*tile);
      const q={service:'WMTS',version:'1.0.0',request:'GetFeatureInfo',layer:OPT+variable,tilematrixset:'EPSG:3857@3x',tilematrix:'10',tilerow:String(row),tilecol:String(col),i:String(i),j:String(j),INFOFORMAT:'application/json',time:opticalDate+'T00:00:00Z'};
      tasks.push({kind:'optical',points:[{beach_id:b.id,...p}],variable,valid_date:opticalDate,dataset:OPT.slice(0,-1),data_type:'satellite_estimate',quality:'unvalidated',acquisition_time_utc:null,url:'https://wmts.marine.copernicus.eu/teroWmts/?'+new URLSearchParams(q)});
    }
  }
  return tasks;
}
export function decode(task,body){
  const data=JSON.parse(body);
  if(task.kind==='optical'){
    const p=data.features?.length===1?data.features[0].properties:null;
    if(!p||p.variableId!==task.variable||p.datasetId!==task.dataset||!finite(p.lat)||!finite(p.lon)||p.lat<35||p.lat>38||p.lon< -4||p.lon>0)throw Error('Respuesta óptica no corresponde');
    if(p.units!=={TUR:'FNU',SPM:'g m-3',CHL:'mg m-3'}[task.variable])throw Error('Unidad óptica inesperada');
    return [{...task.points[0],native_cell:{lat:p.lat,lon:p.lon},variable:task.variable,unit:p.units,value:finite(p.value)?p.value:null,status:finite(p.value)?'numeric_quality_unvalidated':'cell_no_numeric',valid_date:task.valid_date,quality_flags:null,acquisition_time_utc:null}];
  }
  const list=Array.isArray(data)?data:[data];if(list.length!==task.points.length)throw Error('Número de posiciones incorrecto');
  return list.map((r,i)=>{
    const times=r.hourly?.time;
    if(r.error||r.utc_offset_seconds!==0||!finite(r.latitude)||!finite(r.longitude)||!Array.isArray(times)||!times.length||times.some((t,j)=>!/^\d{4}-\d\d-\d\dT\d\d:00$/.test(t)||!iso(t+':00.000Z')||(j&&Date.parse(t+'Z')-Date.parse(times[j-1]+'Z')!==3600000))||(r.location_id!=null&&r.location_id!==i))throw Error('Correspondencia o eje temporal inválido');
    const variables={};
    for(const [name,unit] of Object.entries(task.variables)){
      const key=Object.hasOwn(r.hourly,name)?name:name+'_marine_best_match',v=r.hourly[key],actual=r.hourly_units?.[key]??null;
      const status=!Array.isArray(v)?'field_absent':v.length!==times.length?'shape_invalid':actual!==unit?'unit_unexpected':v.some(x=>x!==null&&!finite(x))?'value_invalid':v.every(x=>x===null)?'cell_no_numeric':v.some(x=>x===null)?'partial_numeric':'numeric_quality_unvalidated';
      variables[name]={status,unit_original:actual,unit_normalized:actual==='km/h'?'m/s':actual,finite_values:Array.isArray(v)?v.filter(finite).length:0,values_normalized:['partial_numeric','numeric_quality_unvalidated','cell_no_numeric'].includes(status)?v.map(x=>x===null?null:actual==='km/h'?x/3.6:x):null};
    }
    return {...task.points[i],returned_coordinate:{lat:r.latitude,lon:r.longitude},native_cell_per_variable:null,coordinate_scope:'best_match_response_coordinate_not_each_variable_grid',valid_times_utc:times.map(t=>t+':00.000Z'),variables};
  });
}
// Reject public/repository destinations and every symbolic-link ancestor.
export function safeRoot(root){
  const absolute=path.resolve(root);let p=absolute;
  while(true){if(fs.existsSync(p)){if(fs.lstatSync(p).isSymbolicLink()||!fs.statSync(p).isDirectory())throw Error('Ruta no es directorio real');if(fs.existsSync(path.join(p,'.git'))||/^playasdealmeria(?:-datos)?$/i.test(path.basename(p)))throw Error('Archivo privado fuera de repositorios');}const parent=path.dirname(p);if(parent===p)break;p=parent;}
  return absolute;
}
export async function download(url){
  const u=new URL(url);if(u.protocol!=='https:'||!HOSTS.has(u.hostname)||u.username||u.password)throw Error('Fuente no permitida');
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(45000),headers:{'user-agent':'playasdealmeria.es activities-research/390'}});
  const chunks=[];let size=0;for await(const b of response.body){size+=b.length;if(size>8*1024*1024)throw Error('Respuesta supera 8 MiB');chunks.push(b);}
  return {status:response.status,body:Buffer.concat(chunks),headers:{content_type:response.headers.get('content-type'),date:response.headers.get('date')}};
}
export function inspect(dir){
  const st=fs.lstatSync(dir);if(!st.isDirectory()||st.isSymbolicLink())throw Error('Captura inválida');
  const mf=path.join(dir,'manifest.json');if(fs.lstatSync(mf).isSymbolicLink())throw Error('Manifiesto enlazado');
  const m=JSON.parse(fs.readFileSync(mf));
  if(m.schema!==1||!Array.isArray(m.files)||new Set(m.files.map(f=>f.name)).size!==m.files.length)throw Error('Manifiesto inválido');
  if(fs.readdirSync(dir).length!==m.files.length+1)throw Error('Archivos inesperados');
  for(const f of m.files){if(!/^(?:raw-\d{3}\.gz|capture\.json(?:\.gz)?)$/.test(f.name))throw Error('Ruta inválida');const p=path.join(dir,f.name);if(!fs.lstatSync(p).isFile()||fs.lstatSync(p).isSymbolicLink())throw Error('Archivo inválido');const b=fs.readFileSync(p);if(b.length!==f.bytes||sha(b)!==f.sha256)throw Error('Integridad inválida');if(f.name.endsWith('.gz'))gunzipSync(b,{maxOutputLength:f.name==='capture.json.gz'?64*1024*1024:8*1024*1024});}
  if(m.files.filter(f=>/^capture\.json(?:\.gz)?$/.test(f.name)).length!==1)throw Error('Falta captura o formato ambiguo');return m;
}
export function readCapture(dir){
  const m=inspect(dir),f=m.files.find(f=>/^capture\.json(?:\.gz)?$/.test(f.name));
  const b=fs.readFileSync(path.join(dir,f.name));return JSON.parse(f.name.endsWith('.gz')?gunzipSync(b,{maxOutputLength:64*1024*1024}):b);
}
function used(root){let total=0;if(!fs.existsSync(root))return total;for(const f of fs.readdirSync(root,{withFileTypes:true})){const p=path.join(root,f.name);if(f.isSymbolicLink())throw Error('Enlace en archivo');if(f.isDirectory())total+=used(p);else total+=fs.statSync(p).size;}return total;}
export async function collect({catalog,root,cycle,opticalDate=null,request=download,now=()=>new Date().toISOString(),delay=ms=>new Promise(r=>setTimeout(r,ms)),limit=256*1024*1024}){
  if(!/^\d{8}T\d{2}(?:-optical)?$/.test(cycle)||!Number.isSafeInteger(limit)||limit<1)throw Error('Ciclo o límite inválido');
  const tasks=plan(catalog,{opticalDate});if(tasks.length>309)throw Error('Presupuesto de peticiones excedido');root=safeRoot(root);
  const dest=path.join(root,cycle),pending=dest+'.pending';
  if(fs.existsSync(dest)){const old=readCapture(dest);if(old.plan_sha256!==sha(JSON.stringify(tasks))||old.catalog_sha256!==sha(JSON.stringify(catalog)))throw Error('Ciclo existente con otro contrato');return {status:'already_saved',directory:dest};}
  if(fs.existsSync(pending))throw Error('Captura interrumpida: conservar y revisar antes de repetir');
  const initial=used(root);if(initial+64*1024*1024>limit)throw Error('Capacidad insuficiente; historia conservada');
  fs.mkdirSync(root,{recursive:true});const lock=path.join(root,'.writer.lock');fs.writeFileSync(lock,cycle,{flag:'wx'});
  try{
    fs.mkdirSync(pending);const files=[],records=[];let rawBytes=0,savedBytes=0;const blockedHosts=new Set();
    const write=(name,b)=>{if(savedBytes+b.length>64*1024*1024||initial+savedBytes+b.length>limit)throw Error('Presupuesto de almacenamiento agotado');fs.writeFileSync(path.join(pending,name),b,{flag:'wx'});savedBytes+=b.length;files.push({name,bytes:b.length,sha256:sha(b)});};
    for(const [index,task] of tasks.entries()){
      const started=now();if(!iso(started))throw Error('Reloj inválido');const rec={task,request_started_at:started,response_received_at:null,status:'retrieval_failed',raw_file:null,rows:[],error:null};
      const host=new URL(task.url).hostname;
      if(blockedHosts.has(host)){rec.status='not_requested_provider_blocked';rec.error='prior_403_or_429';rec.response_received_at=started;records.push(rec);continue;}
      let res;
      try{res=await request(task.url);if(!Buffer.isBuffer(res.body)||res.body.length>8*1024*1024)throw Error('Respuesta inválida o demasiado grande');}
      catch(e){res=null;rec.error=e.name==='TimeoutError'?'timeout':'transport_or_size_error';}
      rec.response_received_at=now();if(!iso(rec.response_received_at)||rec.response_received_at<started)throw Error('Reloj no monótono');
      if(res){rawBytes+=res.body.length;if(rawBytes>32*1024*1024)throw Error('Presupuesto de transferencia excedido');
        const name='raw-'+String(index).padStart(3,'0')+'.gz';write(name,gzipSync(res.body));rec.raw_file=name;rec.raw_sha256=sha(res.body);rec.http_status=res.status;rec.headers=res.headers??{};
        if(res.status===200){try{rec.rows=decode(task,res.body);rec.status='received';}catch{rec.status='payload_invalid';rec.error='schema_or_correspondence_invalid';}}else {rec.error='http_'+res.status;if([403,429].includes(res.status))blockedHosts.add(host);}
      }
      records.push(rec);if(index+1<tasks.length)await delay(400);
    }
    const capture={schema:1,cycle,catalog,catalog_sha256:sha(JSON.stringify(catalog)),plan_sha256:sha(JSON.stringify(tasks)),started_at:records[0].request_started_at,completed_at:now(),records,raw_bytes:rawBytes,semantics:{activities:['snorkel','paddle_surf'],model_issue_time:'not_supplied',lead_time_basis:'response_received_at_not_model_issue',past_hours:'model_history_not_observation',optical:opticalDate?'experimental_unvalidated':'not_requested',visibility:'not_predicted',safety:'not_assessed',currents:'regional_not_rip_current',static_layers:'historical_not_current_presence'}};
    const envelope=Buffer.from(JSON.stringify(capture)+'\n');if(envelope.length>64*1024*1024)throw Error('Sobre descomprimido supera 64 MiB');
    write('capture.json.gz',gzipSync(envelope,{level:9}));const manifest={schema:1,cycle,files};fs.writeFileSync(path.join(pending,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'});inspect(pending);fs.renameSync(pending,dest);
    return {status:records.every(r=>r.status==='received')?'saved':'saved_with_gaps',directory:dest,planned_requests:tasks.length,requests:records.filter(r=>r.status!=='not_requested_provider_blocked').length,raw_bytes:rawBytes,stored_bytes:savedBytes,failed_or_skipped_requests:records.filter(r=>r.status!=='received').length};
  }finally{fs.unlinkSync(lock);}
}
export function restore(source,dest,{limit=256*1024*1024}={}){
  source=safeRoot(source);dest=safeRoot(dest);if(source===dest||dest.startsWith(source+path.sep)||source.startsWith(dest+path.sep))throw Error('Archivos solapados');
  const entries=fs.readdirSync(source);const copies=[];
  for(const name of entries){if(!/^\d{8}T\d{2}(?:-optical)?$/.test(name))throw Error('Archivo incompleto o inesperado');const m=inspect(path.join(source,name));if(fs.existsSync(path.join(dest,name))){const d=inspect(path.join(dest,name));if(JSON.stringify(d)!==JSON.stringify(m))throw Error('Conflicto de captura');}else copies.push(name);}
  for(const name of copies)if(fs.existsSync(path.join(dest,name+'.pending')))throw Error('Restauración pendiente');
  if(!Number.isSafeInteger(limit)||used(dest)+copies.reduce((n,k)=>n+used(path.join(source,k)),0)>limit)throw Error('Capacidad insuficiente');
  fs.mkdirSync(dest,{recursive:true});const lock=path.join(dest,'.writer.lock');fs.writeFileSync(lock,'restore',{flag:'wx'});
  try{for(const name of copies){const temp=path.join(dest,name+'.pending');if(fs.existsSync(temp))throw Error('Restauración pendiente');fs.cpSync(path.join(source,name),temp,{recursive:true,errorOnExist:true,force:false});inspect(temp);fs.renameSync(temp,path.join(dest,name));}}finally{fs.unlinkSync(lock);}return copies.length;
}
