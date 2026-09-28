import {roquetasFlag} from './flag-integrity.mjs';
export const SOURCES={cuevas:'https://turismocuevasdelalmanzora.es/playa-quitapellejos/',roquetas:'https://roquetasdemar.es/tu-ayuntamiento/areas-municipales/turismo-y-playas/playas',vera:'https://www.vera.es/turismo/index.php?page=playas&subpage=plantilla_playa&id=1',carboneras:'https://www.proteccioncivilcarboneras.es/playaszenkra/salvamento_playas_banderas_2026.php'};
const clean=s=>String(s).replace(/<!--[\s\S]*?-->/g,''),plain=s=>clean(s).replace(/<script\b[\s\S]*?<\/script>/gi,' ').replace(/<style\b[\s\S]*?<\/style>/gi,' ').replace(/<[^>]*>/g,' ').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').toUpperCase();
export function parseFlag(source,html,id){
 let flag=null,service=null;html=clean(html);
 if(source==='cuevas'&&id===56&&plain(html).includes('PLAYA QUITAPELLEJOS')){
  const selected=[...html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m=>plain(m[1])).filter(t=>t.includes('☑')&&/BANO PERMITIDO|PRECAUCION EN EL BANO|PROHIBIDO EL BANO/.test(t));
  if(selected.length===1)flag=selected[0].includes('PRECAUCION EN EL BANO')?'amarilla':selected[0].includes('PROHIBIDO EL BANO')?'roja':'verde';
 }
 if(source==='roquetas'&&[57,60].includes(id))flag=roquetasFlag(html,id===57?'salinas':'bajadilla');
 if(source==='vera'&&id===58){const t=plain(html),pos=t.indexOf('LAS MARINAS-BOLAGA'),all=[...t.matchAll(/\bBANDERA\s+(VERDE|AMARILLA|ROJA|NEGRA)\b/g)],colors=new Set(all.map(m=>m[1].toLowerCase()));if(pos>=0&&all.length&&all[0].index>pos&&colors.size===1)flag=[...colors][0];}
 if(source==='carboneras'&&id===31){
  const match=html.match(/const\s+beaches\s*=\s*\[([\s\S]*?)\];/),rows=match?[...match[1].matchAll(/\["([^"\n]+)",\s*([\d.-]+),\s*([\d.-]+),\s*([123]),([^\n]*)\]/g)]:[];
  const required=['Playa El Ancón','Playa Los Barquicos','Playa Los Cocones','Playa Las Marinicas'];
  const groups=required.map(name=>rows.filter(r=>r[1]===name&&Number(r[2])>36.98&&Number(r[2])<37.01&&Number(r[3])> -1.91&&Number(r[3])< -1.88));
  if(groups.every(g=>g.length)){const values=groups.flat().map(r=>({1:'roja',2:'amarilla',3:'verde'}[r[4]]));flag=values.includes('roja')?'roja':values.includes('amarilla')?'amarilla':'verde';}
 }
 if(source==='carboneras'&&[53,54].includes(id)){
  const match=html.match(/const\s+beaches\s*=\s*\[([\s\S]*?)\];/),name=id===53?'Playa El Corral':'Playa El Algarrobico';
  const rows=match?[...match[1].matchAll(/\["([^"\n]+)",\s*([\d.-]+),\s*([\d.-]+),\s*([123]),([^\n]*)\]/g)].filter(m=>m[1]===name):[];
  if(rows.length===1&&Math.abs(Number(rows[0][2])-(id===53?36.9628:37.0269))<.01&&Math.abs(Number(rows[0][3])-(id===53?-1.8996:-1.8789))<.01){flag={1:'roja',2:'amarilla',3:'verde'}[rows[0][4]];if(/SIN SERVICIO DE SOCORRISMO/i.test(rows[0][5]))service=false;}
 }
 return {beach_id:id,published_color:flag,source_timestamp:null,freshness:'unknown',current_flag:null,lifeguard_service:service,status:flag?'color_without_verified_time':'missing_or_schema_changed'};
}

export function veraGroups391(flags,checkedAt){const out={};for(const [id,ids] of [[37,[2,3,4]],[58,[1]]]){const values=ids.map(i=>flags[i]);const severity={verde:1,amarilla:2,roja:3,negra:4};if(values.some(v=>!severity[v]))continue;out[id]={oflag:values.reduce((a,b)=>severity[b]>severity[a]?b:a),oflagSource:'Ayuntamiento de Vera',oflagMunicipality:'Vera',oflagSectorIds:ids,oflagCheckedAt:checkedAt,oflagFreshness:'unknown'};}return out;}
export async function collectNewMunicipalFlags({request=fetch,checkedAt=new Date().toISOString(),enabled=process.env.ALTAS_MUNICIPALES!=='false'}={}){
 const data={},errors=[];if(!enabled)return {data,errors,meta:{enabled:false,count:0,count_flags:0,count_flags_verified:0,errors}};
 for(const [source,ids,municipality] of [['carboneras',[31,53,54],'Carboneras'],['cuevas',[56],'Cuevas del Almanzora']]){
  try{const r=await request(SOURCES[source],{signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error('HTTP '+r.status);const html=await r.text();if(html.length>1048576)throw Error('size_limit');for(const id of ids){const v=parseFlag(source,html,id);if(v.published_color)data[id]={oflag:v.published_color,oflagSource:'Ayuntamiento de '+municipality,oflagMunicipality:municipality,oflagSectorIds:id===31?['ancon','barquicos','cocones','marinicas']:[id],oflagCheckedAt:checkedAt,oflagFreshness:'unknown',oflagServiceActive:v.lifeguard_service};}}
  catch(e){errors.push(source+': '+String(e.message).slice(0,120));}
 }return {data,errors,meta:{enabled:true,requested:4,count:Object.keys(data).length,count_flags:Object.keys(data).length,count_flags_verified:0,errors}};
}
