#!/usr/bin/env node
/**
 * build-data.mjs — Genera datos_playas.json para playasdealmeria.es
 *
 * Pide a Open-Meteo (clima + marine + calidad del aire) UNA vez por playa
 * desde un servidor/cron, en lugar de hacerlo desde el navegador de cada
 * visitante. La app lee un único datos_playas.json y se ahorra ~80-120
 * llamadas por visita.
 *
 * Replica fielmente la transformación que la app hace en fetchScenariosAt().
 * Ejecutar:  node build-data.mjs   (requiere Node 18+, fetch global)
 */
import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync, unzipSync } from 'node:zlib';

const FORECAST_DAYS = 7;
const CONCURRENCY = 5;
const PROVINCE = { lat: 36.84, lng: -2.46 };
const AEMET_DAYS = [
  {key:'hoy', day:0, label:'hoy'},
  {key:'mna', day:1, label:'mañana'},
  {key:'pmna', day:2, label:'pasado mañana'}
];
const AEMET_ZONE_CODES = {
  '610403': {zone:'Poniente y Almería Capital', web_zones:['Poniente','Capital']},
  '610404': {zone:'Levante almeriense', web_zones:['Cabo de Gata','Levante']}
};
// v90: las URL RSS directas /es/rss/avisos/... devuelven 404.
// Usamos las páginas oficiales de avisos, que AEMET expone por comunidad/zona y día.
// Importante: no añadir p=04 a la vista autonómica, porque puede devolver una página sin detalle.
const AEMET_HTML_URLS = [
  ...AEMET_DAYS.map(d => `https://www.aemet.es/es/eltiempo/prediccion/avisos?k=and&w=${d.key}`),
  ...Object.keys(AEMET_ZONE_CODES).flatMap(code => AEMET_DAYS.map(d => `https://www.aemet.es/es/eltiempo/prediccion/avisos?l=${code}&w=${d.key}`))
];
const AEMET_ZONE_NAMES = ['Poniente y Almería Capital','Levante almeriense','Valle del Almanzora y Los Vélez','Nacimiento y Campo de Tabernas','Poniente y Almería Capital - Costa','Levante almeriense - Costa'];
const AEMET_PHENOMENA = ['Fenómenos costeros','Temperaturas máximas','Temperaturas mínimas','Vientos','Lluvias','Tormentas','Nevadas','Nieblas','Polvo en suspensión','Rissagas','Aludes'];
const AEMET_OPENDATA_ENDPOINT = 'https://opendata.aemet.es/opendata/api/avisos_cap/ultimoelaborado/area';
const AEMET_OPENDATA_AREAS = String(process.env.AEMET_OPENDATA_AREA||'esp').split(',').map(x=>x.trim()).filter(Boolean);
const AEMET_COASTAL_ZONE_CODES = new Set(Object.keys(AEMET_ZONE_CODES));


// ---- helpers portados 1:1 desde la app ----
function avg(arr){const v=(arr||[]).filter(x=>x!=null&&!Number.isNaN(x));return v.length?v.reduce((a,b)=>a+b,0)/v.length:null;}
function maxv(arr){const v=(arr||[]).filter(x=>x!=null&&!Number.isNaN(x));return v.length?Math.max(...v):null;}
function mode(arr){const v=(arr||[]).filter(x=>x!=null);if(!v.length)return null;const m=new Map();v.forEach(x=>m.set(x,(m.get(x)||0)+1));return [...m.entries()].sort((a,b)=>b[1]-a[1])[0][0];}
function windType(dir,spd){if(spd<12)return 'flojo';if(dir>=45&&dir<=135)return 'levante';if(dir>=200&&dir<=330)return 'poniente';return 'terral';}
function codeEstado(c){if(c===0)return{estado:'sol',estadoTxt:'despejado',ico:'☀️'};if(c<=3)return{estado:'variable',estadoTxt:'parcialmente nublado',ico:'⛅'};if(c<=48)return{estado:'nubes',estadoTxt:'nublado o niebla',ico:'☁️'};if(c<=67)return{estado:'nubes',estadoTxt:'lluvia',ico:'🌧️'};if(c<=82)return{estado:'nubes',estadoTxt:'chubascos',ico:'🌦️'};if(c<=99)return{estado:'nubes',estadoTxt:'tormenta',ico:'⛈️'};return{estado:'variable',estadoTxt:'variable',ico:'⛅'};}
function dayLabel(iso,i){if(i===0)return 'Hoy';if(i===1)return 'Mañana';const d=new Date(iso);return ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'][d.getDay()];}

function summarizePart(dateStr,startHour,endHour,wh,mh){
  if(!wh||!Array.isArray(wh.time))return null;
  const marineByTime={};
  if(mh&&Array.isArray(mh.time))mh.time.forEach((t,i)=>{marineByTime[t]={waveH:mh.wave_height?.[i],waveDir:mh.wave_direction?.[i]};});
  const idxs=[];
  wh.time.forEach((t,i)=>{if(String(t).slice(0,10)!==dateStr)return;const hh=parseInt(String(t).slice(11,13),10);if(hh>=startHour&&hh<endHour)idxs.push(i);});
  if(!idxs.length)return null;
  const times=idxs.map(i=>wh.time[i]);
  const code=mode(idxs.map(i=>wh.weather_code?.[i]));
  const e=codeEstado(code==null?0:code);
  const spd=avg(idxs.map(i=>wh.wind_speed_10m?.[i]));
  const gust=maxv(idxs.map(i=>wh.wind_gusts_10m?.[i]));
  const dir=avg(idxs.map(i=>wh.wind_direction_10m?.[i]));
  const waveH=avg(times.map(t=>marineByTime[t]?.waveH));
  const waveDir=avg(times.map(t=>marineByTime[t]?.waveDir));
  const temp=avg(idxs.map(i=>wh.temperature_2m?.[i]));
  return {ico:e.ico,estadoTxt:e.estadoTxt,temp:temp!=null?Math.round(temp):null,windK:spd!=null?Math.round(spd):null,gustK:gust!=null?Math.round(gust):(spd!=null?Math.round(spd*1.3):null),windDir:dir!=null?Math.round(dir):null,waveH:waveH!=null?Math.round(waveH*10)/10:null,waveDir:waveDir!=null?Math.round(waveDir):null};
}

async function getJSON(url){
  const r=await fetch(url,{headers:{'user-agent':'playasdealmeria.es datos/1.0'}});
  if(!r.ok)throw new Error('HTTP '+r.status+' '+url);
  return r.json();
}

// Equivalente servidor de fetchScenariosAt(lat,lng): devuelve {days, hourly}
async function scenariosAt(lat,lng){
  const u=`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m&hourly=temperature_2m,relative_humidity_2m,precipitation,precipitation_probability,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,wind_speed_10m_max,wind_direction_10m_dominant,uv_index_max,sunrise,sunset&timezone=auto&forecast_days=${FORECAST_DAYS}&wind_speed_unit=kmh`;
  const wx=await getJSON(u);
  let sst=23,marD=null,marH=null;
  try{
    const mar=await getJSON(`https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lng}&current=sea_surface_temperature&hourly=wave_height,wave_direction&daily=wave_height_max,wave_direction_dominant&timezone=auto&forecast_days=${FORECAST_DAYS}`);
    if(mar.current&&mar.current.sea_surface_temperature!=null)sst=Math.round(mar.current.sea_surface_temperature);
    if(mar.daily)marD=mar.daily;
    if(mar.hourly)marH=mar.hourly;
  }catch(e){/* sin marine: se usa sst por defecto */}
  const cur=wx.current||{},d=wx.daily||{},out=[];
  const wh=i=>marD&&marD.wave_height_max?marD.wave_height_max[i]:null;
  const wd=i=>marD&&marD.wave_direction_dominant?marD.wave_direction_dominant[i]:null;
  const len=Math.min(FORECAST_DAYS,(d.time||[]).length||FORECAST_DAYS);
  for(let i=0;i<len;i++){
    const dateStr=d.time?.[i]||new Date(Date.now()+i*864e5).toISOString().slice(0,10);
    const e=codeEstado(i===0?(cur.weather_code??d.weather_code?.[0]):d.weather_code?.[i]);
    const spd=i===0?(cur.wind_speed_10m??d.wind_speed_10m_max?.[0]??0):(d.wind_speed_10m_max?.[i]??0);
    const dir=i===0?(cur.wind_direction_10m??d.wind_direction_10m_dominant?.[0]??0):(d.wind_direction_10m_dominant?.[i]??0);
    out.push({
      key:i===0?'hoy':'d'+i,
      label:i===0?'Hoy':dayLabel(dateStr,i),
      ico:e.ico,
      temp:Math.round(d.temperature_2m_max?.[i] ?? (i===0 ? cur.temperature_2m : 0) ?? 0),
      min:Math.round(d.temperature_2m_min?.[i]??0),
      agua:sst,
      waveH:wh(i),
      waveDir:wd(i),
      estado:e.estado,
      estadoTxt:e.estadoTxt,
      viento:windType(dir,spd),
      fuerza:Math.round(spd),
      rachas:Math.round(i===0?(cur.wind_gusts_10m??spd*1.3):spd*1.3),
      sale:(d.sunrise?.[i]||'T06:50').slice(11,16),
      pone:(d.sunset?.[i]||'T21:30').slice(11,16),
      uv:d.uv_index_max?Math.round(d.uv_index_max[i]):null,
      parts:{
        morning:summarizePart(dateStr,8,15,wx.hourly||{},marH||{}),
        afternoon:summarizePart(dateStr,15,22,wx.hourly||{},marH||{})
      }
    });
  }
  const dateIndex={};(d.time||[]).forEach((date,i)=>{if(i<FORECAST_DAYS)dateIndex[date]=i;});
  const marineByTime={}; if(marH&&Array.isArray(marH.time))marH.time.forEach((t,i)=>{marineByTime[t]={waveH:marH.wave_height?.[i],waveDir:marH.wave_direction?.[i]};});
  const hourly={time:[],temp:[],rh:[],pr:[],pop:[],code:[],wind:[],gust:[],wdir:[],wave:[],waveDir:[]};
  const hr=wx.hourly||{};
  (hr.time||[]).forEach((t,i)=>{
    const date=String(t).slice(0,10),hh=parseInt(String(t).slice(11,13),10),di=dateIndex[date];
    if(di==null||Number.isNaN(hh))return;
    hourly.time.push(di*24+hh);
    hourly.temp.push(Math.round(hr.temperature_2m?.[i]??0));
    hourly.rh.push(hr.relative_humidity_2m?.[i]!=null?Math.round(hr.relative_humidity_2m[i]):null);
    hourly.pr.push(hr.precipitation?.[i]!=null?Math.round(hr.precipitation[i]*10)/10:0);
    hourly.pop.push(hr.precipitation_probability?.[i]!=null?Math.round(hr.precipitation_probability[i]):0);
    hourly.code.push(hr.weather_code?.[i]??0);
    hourly.wind.push(hr.wind_speed_10m?.[i]!=null?Math.round(hr.wind_speed_10m[i]):0);
    hourly.gust.push(hr.wind_gusts_10m?.[i]!=null?Math.round(hr.wind_gusts_10m[i]):null);
    hourly.wdir.push(hr.wind_direction_10m?.[i]!=null?Math.round(hr.wind_direction_10m[i]):0);
    hourly.wave.push(marineByTime[t]?.waveH!=null?marineByTime[t].waveH:0);
    hourly.waveDir.push(marineByTime[t]?.waveDir!=null?Math.round(marineByTime[t].waveDir):180);
  });
  return {days:out,hourly};
}

async function airAt(lat,lng){
  try{
    const data=await getJSON(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lng}&current=european_aqi,pm10,pm2_5,ozone,nitrogen_dioxide&timezone=auto`);
    const c=data.current||{};
    return {eaqi:c.european_aqi,pm25:c.pm2_5,pm10:c.pm10,ozone:c.ozone,no2:c.nitrogen_dioxide};
  }catch(e){return {error:true};}
}

async function mapLimit(arr,limit,fn){
  let i=0;const workers=Array.from({length:Math.min(limit,arr.length)},async()=>{while(i<arr.length){const item=arr[i++];try{await fn(item);}catch(e){console.error('  ! fallo en',item&&item.nombre,e.message);}}});
  await Promise.all(workers);
}


function validNum(x){return x!=null && !Number.isNaN(Number(x));}
function roundAvg(vals){const v=(vals||[]).filter(validNum).map(Number);return v.length?Math.round(v.reduce((a,b)=>a+b,0)/v.length):null;}
function roundMax(vals){const v=(vals||[]).filter(validNum).map(Number);return v.length?Math.round(Math.max(...v)):null;}
function roundMin(vals){const v=(vals||[]).filter(validNum).map(Number);return v.length?Math.round(Math.min(...v)):null;}
function common(vals,fallback=null){const v=(vals||[]).filter(x=>x!=null);if(!v.length)return fallback;const m=new Map();v.forEach(x=>m.set(String(x),(m.get(String(x))||0)+1));return [...m.entries()].sort((a,b)=>b[1]-a[1])[0][0];}
function aggregatePart(parts){
  const src=(parts||[]).filter(Boolean);
  if(!src.length)return null;
  const ico=common(src.map(x=>x.ico),'⛅');
  const estadoTxt=common(src.map(x=>x.estadoTxt),'variable');
  const windK=roundAvg(src.map(x=>x.windK));
  const windDir=roundAvg(src.map(x=>x.windDir));
  return {
    ico,
    estadoTxt,
    temp:roundAvg(src.map(x=>x.temp)),
    windK,
    gustK:roundMax(src.map(x=>x.gustK)),
    windDir,
    waveH:avg(src.map(x=>x.waveH))!=null?Math.round(avg(src.map(x=>x.waveH))*10)/10:null,
    waveDir:roundAvg(src.map(x=>x.waveDir))
  };
}
function aggregateHourly(allHourly){
  const out={time:[],temp:[],rh:[],pr:[],pop:[],code:[],wind:[],gust:[],wdir:[],wave:[],waveDir:[]};
  const by=new Map();
  (allHourly||[]).forEach(H=>{
    if(!H||!Array.isArray(H.time))return;
    H.time.forEach((t,i)=>{
      if(!by.has(t))by.set(t,{temp:[],rh:[],pr:[],pop:[],code:[],wind:[],gust:[],wdir:[],wave:[],waveDir:[]});
      const g=by.get(t);
      ['temp','rh','pr','pop','code','wind','gust','wdir','wave','waveDir'].forEach(k=>{if(H[k]&&H[k][i]!=null)g[k].push(H[k][i]);});
    });
  });
  [...by.keys()].sort((a,b)=>a-b).forEach(t=>{
    const g=by.get(t);out.time.push(t);
    out.temp.push(roundAvg(g.temp));out.rh.push(roundAvg(g.rh));out.pr.push(avg(g.pr)!=null?Math.round(avg(g.pr)*10)/10:0);out.pop.push(roundAvg(g.pop)||0);
    out.code.push(Number(common(g.code,0)));out.wind.push(roundAvg(g.wind));out.gust.push(roundMax(g.gust));out.wdir.push(roundAvg(g.wdir));
    out.wave.push(avg(g.wave)!=null?Math.round(avg(g.wave)*10)/10:null);out.waveDir.push(roundAvg(g.waveDir));
  });
  return out;
}
function aggregateProvinceFromBeaches(beaches){
  const values=Object.values(beaches||{}).filter(x=>x&&Array.isArray(x.days));
  if(!values.length)return null;
  const maxDays=Math.max(...values.map(x=>x.days.length));
  const days=[];
  for(let i=0;i<maxDays;i++){
    const list=values.map(x=>x.days[i]).filter(Boolean);
    if(!list.length)continue;
    const first=list[0];
    const fuerza=roundAvg(list.map(x=>x.fuerza));
    const viento=common(list.map(x=>x.viento),'flojo');
    days.push({
      key:i===0?'hoy':'d'+i,
      label:i===0?'Hoy':(first.label||dayLabel(new Date(Date.now()+i*864e5).toISOString().slice(0,10),i)),
      ico:common(list.map(x=>x.ico),'⛅'),
      temp:roundMax(list.map(x=>x.temp)),
      min:roundMin(list.map(x=>x.min)),
      agua:roundAvg(list.map(x=>x.agua)),
      waveH:avg(list.map(x=>x.waveH))!=null?Math.round(avg(list.map(x=>x.waveH))*10)/10:null,
      waveDir:roundAvg(list.map(x=>x.waveDir)),
      estado:common(list.map(x=>x.estado),'variable'),
      estadoTxt:common(list.map(x=>x.estadoTxt),'variable'),
      viento,
      fuerza,
      rachas:roundMax(list.map(x=>x.rachas)),
      sale:common(list.map(x=>x.sale),first.sale||'06:50'),
      pone:common(list.map(x=>x.pone),first.pone||'21:30'),
      uv:roundMax(list.map(x=>x.uv)),
      parts:{
        morning:aggregatePart(list.map(x=>x.parts&&x.parts.morning)),
        afternoon:aggregatePart(list.map(x=>x.parts&&x.parts.afternoon))
      }
    });
  }
  return {days,hourly:aggregateHourly(values.map(x=>x.hourly))};
}


function stripHTML(x){return String(x||'').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&aacute;/gi,'á').replace(/&eacute;/gi,'é').replace(/&iacute;/gi,'í').replace(/&oacute;/gi,'ó').replace(/&uacute;/gi,'ú').replace(/&ntilde;/gi,'ñ').replace(/&#243;/g,'ó').replace(/&#237;/g,'í').replace(/\s+/g,' ').trim();}
function norm(s){return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();}
function htmlDecode(x){return stripHTML(String(x||'').replace(/<!\[CDATA\[|\]\]>/g,''));}
function xmlDecode(x){return htmlDecode(String(x||'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'"));}
async function getText(url){
  const r=await fetch(url,{headers:{'user-agent':'playasdealmeria.es datos/1.0','accept':'text/html,application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8'}});
  if(!r.ok)throw new Error('HTTP '+r.status+' '+url);
  return await r.text();
}
async function getAemetJSON(url){
  const r=await fetch(url,{headers:{'user-agent':'playasdealmeria.es datos/1.0','accept':'application/json'}});
  if(!r.ok)throw new Error('HTTP '+r.status+' '+url);
  return await r.json();
}
async function getBinary(url){
  const r=await fetch(url,{headers:{'user-agent':'playasdealmeria.es datos/1.0','accept':'application/xml,text/xml,application/gzip,application/x-tar,*/*'}});
  if(!r.ok)throw new Error('HTTP '+r.status+' '+url);
  return {buffer:Buffer.from(await r.arrayBuffer()),contentType:r.headers.get('content-type')||'',contentEncoding:r.headers.get('content-encoding')||''};
}
function aemetDayFromURL(url){
  const u=String(url||'');
  if(/w=pmna/.test(u))return 2;
  if(/w=mna/.test(u))return 1;
  return 0;
}
function aemetZoneFromURL(url){
  const m=String(url||'').match(/[?&]l=(610403|610404)\b/);
  return m && AEMET_ZONE_CODES[m[1]] ? AEMET_ZONE_CODES[m[1]].zone : '';
}
function aemetColorFromText(t){
  const n=norm(t);
  if(/peligro\s+extremo|\brojo\b|nivel\s+rojo|\bred\b/.test(n))return 'rojo';
  if(/peligro\s+importante|\bnaranja\b|nivel\s+naranja|\borange\b/.test(n))return 'naranja';
  if(/peligro\s+bajo|\bamarillo\b|nivel\s+amarillo|\byellow\b/.test(n))return 'amarillo';
  return '';
}
function aemetPhenomenonFromText(t){
  const n=norm(t);
  return AEMET_PHENOMENA.find(x=>n.includes(norm(x)))||'';
}
function aemetZoneFromText(t){
  const n=norm(t);
  return AEMET_ZONE_NAMES.find(z=>n.includes(norm(z)))||(/\balmeria\b/.test(n)?'Almería':'');
}
function aemetProbabilityFromText(t){const m=String(t||'').match(/\b\d{1,3}%\s*-\s*\d{1,3}%\b|mayor\s+70%|\b\d{1,3}%\b/i);return m?m[0].replace(/\s+/g,''):'';}
function aemetValueFromText(t){const m=String(t||'').match(/\b\d+(?:[,.]\d+)?\s*(?:mm|l\/m2|km\/h|ºC|°C|m\b|metros|fuerza\s*\d+)\b/i);return m?m[0].trim():'';}
function aemetWebZonesForZone(zone){
  const n=norm(zone);
  if(!n||n==='almeria'||n.includes('provincia de almeria'))return ['Poniente','Capital','Cabo de Gata','Levante'];
  if(n.includes('poniente')||n.includes('almeria capital'))return ['Poniente','Capital'];
  if(n.includes('levante almeriense'))return ['Cabo de Gata','Levante'];
  return [];
}
function makeAemetAlert(text,day,source,fallbackZone=''){
  const clean=stripHTML(text);
  const zone=aemetZoneFromText(clean)||fallbackZone;
  const phenomenon=aemetPhenomenonFromText(clean);
  if(!zone||!phenomenon)return null;
  const color=aemetColorFromText(clean);
  const probability=aemetProbabilityFromText(clean);
  const value=aemetValueFromText(clean);
  const comment=clean.length>220?clean.slice(0,217)+'…':clean;
  const web_zones=aemetWebZonesForZone(zone);
  return {day, phenomenon, color, zone, web_zones, value, probability, comment, source_url:source};
}
function aemetLikelyNoWarnings(text){
  const n=norm(text);
  return /no hay avisos meteorologicos|no existen avisos meteorologicos|sin avisos meteorologicos|no hay datos disponibles/.test(n)
    && !AEMET_PHENOMENA.some(p => n.includes(norm(p)) && /peligro|amarillo|naranja|rojo|\d+\s*(mm|ºc|°c|km\/h|m\b)/.test(n));
}
function dedupeAemet(items){
  const seen=new Set(),out=[];
  for(const a of items||[]){
    const k=[a.day,norm(a.phenomenon),norm(a.color),norm(a.zone),norm(a.value),norm(a.probability),norm(a.onset||''),norm(a.expires||'')].join('|');
    if(seen.has(k))continue;seen.add(k);out.push(a);
  }
  return out.sort((a,b)=>(a.day??0)-(b.day??0)||String(a.zone).localeCompare(String(b.zone),'es')||String(a.phenomenon).localeCompare(String(b.phenomenon),'es'));
}
function parseAemetRSS(xml,url){
  const items=[];
  const blocks=[...String(xml||'').matchAll(/<item[\s\S]*?<\/item>/gi)].map(m=>m[0]);
  const entries=blocks.length?blocks:[...String(xml||'').matchAll(/<entry[\s\S]*?<\/entry>/gi)].map(m=>m[0]);
  for(const block of entries){
    const title=htmlDecode((block.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||'');
    const desc=htmlDecode((block.match(/<description[^>]*>([\s\S]*?)<\/description>/i)||block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i)||block.match(/<content[^>]*>([\s\S]*?)<\/content>/i)||[])[1]||'');
    const txt=(title+' · '+desc).trim();
    if(!/almer[ií]a|poniente|levante almeriense|almanzora|v[eé]lez|tabernas/i.test(txt))continue;
    const a=makeAemetAlert(txt,0,url);
    if(a)items.push(a);
  }
  return items;
}
function parseAemetHTML(html,url){
  const day=aemetDayFromURL(url),items=[],warnings=[];
  const fallbackZone=aemetZoneFromURL(url);
  const fullText=stripHTML(html);
  const rows=[...String(html||'').matchAll(/<tr[\s\S]*?<\/tr>/gi)].map(m=>m[0]);
  const noWarning=aemetLikelyNoWarnings(fullText);
  if(noWarning)return {items, method:'html_no_warning_text', rows:rows.length, fallback_used:false, warnings};
  for(const row of rows){
    const cells=[...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m=>stripHTML(m[1])).filter(Boolean);
    if(cells.length<2)continue;
    const txt=cells.join(' · ');
    const a=makeAemetAlert(txt,day,url,fallbackZone);
    if(a)items.push(a);
  }
  if(items.length)return {items, method:'html_table', rows:rows.length, fallback_used:false, warnings};
  const text=fullText;
  const ntext=norm(text);
  const scanZones=[...new Set([fallbackZone,...AEMET_ZONE_NAMES].filter(Boolean))];
  for(const z of scanZones){
    const nz=norm(z);let pos=ntext.indexOf(nz);
    while(pos>=0){
      const frag=text.slice(Math.max(0,pos-220),Math.min(text.length,pos+520));
      const a=makeAemetAlert(frag,day,url,z);
      if(a)items.push(a);
      pos=ntext.indexOf(nz,pos+nz.length);
    }
  }
  if(items.length)return {items, method:'html_text_fallback_zone', rows:rows.length, fallback_used:true, warnings};
  if(fallbackZone){
    for(const p of AEMET_PHENOMENA){
      const np=norm(p);let pos=ntext.indexOf(np);
      while(pos>=0){
        const frag=text.slice(Math.max(0,pos-80),Math.min(text.length,pos+520));
        const a=makeAemetAlert(frag,day,url,fallbackZone);
        if(a)items.push(a);
        pos=ntext.indexOf(np,pos+np.length);
      }
    }
  }
  if(items.length)return {items, method:'html_text_fallback_phenomenon', rows:rows.length, fallback_used:true, warnings};
  if(!rows.length)warnings.push('AEMET HTML sin tabla <tr>; posible cambio de diseño.');
  else warnings.push(`AEMET HTML con ${rows.length} filas, pero sin avisos parseables ni texto claro de sin avisos.`);
  return {items, method:'html_unparsed', rows:rows.length, fallback_used:true, warnings};
}
function xmlBlocks(xml,tag){const re=new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>[\\s\\S]*?<\\/(?:\\w+:)?${tag}>`,'gi');return [...String(xml||'').matchAll(re)].map(m=>m[0]);}
function xmlTag(xml,tag){const re=new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`,'i');const m=String(xml||'').match(re);return m?xmlDecode(m[1]).trim():'';}
function parameterValue(info,needle){
  const n=norm(needle);
  for(const p of xmlBlocks(info,'parameter')){
    const vn=norm(xmlTag(p,'valueName'));
    const v=xmlTag(p,'value');
    if(vn.includes(n))return v;
  }
  return '';
}
function eventCodePhenomenon(info){
  for(const p of xmlBlocks(info,'eventCode')){
    const vn=norm(xmlTag(p,'valueName'));
    const v=xmlTag(p,'value');
    if(vn.includes('fenomeno')||vn.includes('aemet-meteoalerta')){
      const parts=String(v||'').split(';');
      return parts.length>1?parts.slice(1).join(';').trim():v;
    }
  }
  return '';
}
function areaCode(area){
  for(const g of xmlBlocks(area,'geocode')){
    const vn=norm(xmlTag(g,'valueName'));
    const v=xmlTag(g,'value').trim();
    if(vn.includes('zona')||/^\d{6}$/.test(v))return v;
  }
  return '';
}
function madridDateParts(date){
  const d=date instanceof Date?date:new Date(date);
  if(Number.isNaN(d.getTime()))return null;
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);
  const o={};parts.forEach(p=>{o[p.type]=p.value;});
  return {y:Number(o.year),m:Number(o.month),d:Number(o.day)};
}
function dayIndexMadrid(dateStr){
  const p=madridDateParts(dateStr),n=madridDateParts(new Date());
  if(!p||!n)return 0;
  const a=Date.UTC(p.y,p.m-1,p.d),b=Date.UTC(n.y,n.m-1,n.d);
  return Math.round((a-b)/86400000);
}
function decodeAemetPayload(buffer,contentType='',contentEncoding=''){
  let buf=Buffer.from(buffer);
  const first2=buf.length>=2?`${buf[0].toString(16).padStart(2,'0')}${buf[1].toString(16).padStart(2,'0')}`:'';
  if(/gzip/i.test(contentEncoding)||/gzip/i.test(contentType)||first2==='1f8b'){
    try{buf=gunzipSync(buf);}catch(e){try{buf=unzipSync(buf);}catch{throw e;}}
  }
  const asText=buf.toString('utf8');
  if(/<alert\b|<cap:alert\b/i.test(asText))return [asText];
  const texts=[];let off=0;
  while(off+512<=buf.length){
    const name=buf.slice(off,off+100).toString('utf8').replace(/\0.*$/,'').trim();
    if(!name)break;
    const sizeText=buf.slice(off+124,off+136).toString('utf8').replace(/\0.*$/,'').trim();
    const size=parseInt(sizeText||'0',8);
    const start=off+512,end=start+size;
    if(size>0&&end<=buf.length){
      const txt=buf.slice(start,end).toString('utf8');
      if(/\.xml$/i.test(name)||/<alert\b|<cap:alert\b/i.test(txt))texts.push(txt);
    }
    off=start+Math.ceil(size/512)*512;
  }
  return texts.length?texts:[asText];
}
function parseAemetCAP(xml,source){
  const items=[];let capMessages=0, warningMessages=0, minorMessages=0;
  for(const alert of xmlBlocks(xml,'alert')){
    capMessages++;
    const sent=xmlTag(alert,'sent');
    const status=xmlTag(alert,'status');
    const msgType=xmlTag(alert,'msgType');
    const infos=xmlBlocks(alert,'info');
    const info=infos.find(x=>/^es/i.test(xmlTag(x,'language'))) || infos[0] || alert;
    const severity=xmlTag(info,'severity')||xmlTag(alert,'severity');
    const headline=xmlTag(info,'headline');
    const description=xmlTag(info,'description');
    const instruction=xmlTag(info,'instruction');
    const event=xmlTag(info,'event')||eventCodePhenomenon(info)||aemetPhenomenonFromText(headline+' '+description);
    let phenomenon=aemetPhenomenonFromText(event)||aemetPhenomenonFromText(headline+' '+description)||eventCodePhenomenon(info);
    const levelParam=parameterValue(info,'nivel');
    let color=aemetColorFromText(levelParam)||aemetColorFromText(event+' '+headline+' '+description);
    const param=parameterValue(info,'parametro');
    const prob=parameterValue(info,'probabilidad')||aemetProbabilityFromText(description+' '+headline);
    const value=(param&&String(param).split(';').slice(2).join(';').trim())||aemetValueFromText(description+' '+headline);
    const onset=xmlTag(info,'onset')||xmlTag(info,'effective')||sent;
    const expires=xmlTag(info,'expires');
    const day=dayIndexMadrid(onset||sent||new Date());
    if(day<0||day>2)continue;
    if(!phenomenon)phenomenon=aemetPhenomenonFromText(headline+' '+description);
    const areas=xmlBlocks(alert,'area');
    const isMinor=/minor/i.test(severity)||/sin aviso/i.test(event+' '+headline+' '+description);
    if(isMinor&&!color){minorMessages++;continue;}
    for(const area of areas){
      const code=areaCode(area);
      const areaDesc=xmlTag(area,'areaDesc');
      const zone=AEMET_ZONE_CODES[code]?.zone || aemetZoneFromText(areaDesc) || areaDesc;
      if(code&&!AEMET_COASTAL_ZONE_CODES.has(code))continue;
      if(!code&&!aemetWebZonesForZone(zone).length)continue;
      if(!phenomenon||!zone)continue;
      warningMessages++;
      const web_zones=AEMET_ZONE_CODES[code]?.web_zones || aemetWebZonesForZone(zone);
      items.push({day, phenomenon, color, zone, web_zones, value, probability:prob, period:onset&&expires?`${onset} - ${expires}`:'', onset, expires, comment:(description||headline||instruction||'').slice(0,260), source_url:source, source_method:'opendata_cap', cap_status:status, cap_msgType:msgType});
    }
  }
  return {items,capMessages,warningMessages,minorMessages};
}
async function fetchAemetOpenDataAlerts(){
  const key=String(process.env.AEMET_API_KEY||'').trim();
  const started=new Date().toISOString();
  if(!key)throw new Error('AEMET_API_KEY no configurada');
  const all=[];const diagnostics={areas:[],cap_messages:0,warning_messages:0,minor_messages:0};
  for(const area of AEMET_OPENDATA_AREAS){
    const apiUrl=`${AEMET_OPENDATA_ENDPOINT}/${encodeURIComponent(area)}?api_key=${encodeURIComponent(key)}`;
    const env=await getAemetJSON(apiUrl);
    if(Number(env.estado||200)>=400||!env.datos)throw new Error(`AEMET OpenData sin datos para area ${area}: ${env.descripcion||env.estado||'respuesta inválida'}`);
    const bin=await getBinary(env.datos);
    const texts=decodeAemetPayload(bin.buffer,bin.contentType,bin.contentEncoding);
    const areaDiag={area,files:texts.length,datos:env.datos};
    for(const txt of texts){
      const parsed=parseAemetCAP(txt,env.datos);
      all.push(...parsed.items);
      diagnostics.cap_messages+=parsed.capMessages;
      diagnostics.warning_messages+=parsed.warningMessages;
      diagnostics.minor_messages+=parsed.minorMessages;
    }
    diagnostics.areas.push(areaDiag);
  }
  return {started,items:dedupeAemet(all),diagnostics};
}
async function fetchAemetHTMLAlerts(){
  const items=[]; const errors=[]; const warnings=[]; const methods={};
  let okSources=0, fallbackUsed=0, tableRows=0;
  for(const url of AEMET_HTML_URLS){
    try{
      const html=await getText(url);
      okSources++;
      const parsed=parseAemetHTML(html,url);
      items.push(...parsed.items);
      methods[parsed.method]=(methods[parsed.method]||0)+1;
      tableRows+=parsed.rows||0;
      if(parsed.fallback_used)fallbackUsed++;
      warnings.push(...(parsed.warnings||[]).map(w=>`${w} (${url})`));
    }catch(e){
      errors.push(e.message);
    }
  }
  return {items:dedupeAemet(items),okSources,errors,warnings,methods,fallbackUsed,tableRows};
}
async function fetchAemetAlerts(){
  const started=new Date().toISOString();
  const errors=[]; const warnings=[];
  const hasKey=!!String(process.env.AEMET_API_KEY||'').trim();
  if(hasKey){
    try{
      const api=await fetchAemetOpenDataAlerts();
      return {
        source:'AEMET Meteoalerta',
        fetched_at:api.started||started,
        ok:true,
        method:'opendata_cap',
        items:api.items.slice(0,50),
        checked_days:AEMET_DAYS.map(d=>d.label),
        checked_zones:Object.values(AEMET_ZONE_CODES).map(z=>z.zone),
        opendata:{enabled:true,areas:AEMET_OPENDATA_AREAS,cap_messages:api.diagnostics.cap_messages,warning_messages:api.diagnostics.warning_messages,minor_messages:api.diagnostics.minor_messages,files:api.diagnostics.areas.reduce((a,b)=>a+(b.files||0),0)},
        html_fallback_used:false,
        errors:[],
        warnings:[]
      };
    }catch(e){
      errors.push('OpenData: '+e.message);
      warnings.push('Se usa fallback HTML porque AEMET OpenData ha fallado.');
    }
  }else{
    warnings.push('AEMET_API_KEY no configurada; se usa fallback HTML.');
  }
  const html=await fetchAemetHTMLAlerts();
  warnings.push(...html.warnings);
  return {
    source:'AEMET Meteoalerta',
    fetched_at:started,
    ok:html.okSources>0,
    method:'html_fallback',
    items:html.items.slice(0,30),
    checked_days:AEMET_DAYS.map(d=>d.label),
    checked_zones:Object.values(AEMET_ZONE_CODES).map(z=>z.zone),
    opendata:{enabled:hasKey,areas:AEMET_OPENDATA_AREAS},
    html:{ok_sources:html.okSources,methods:html.methods,fallback_used:html.fallbackUsed,table_rows:html.tableRows},
    html_fallback_used:true,
    errors:[...errors,...html.errors].slice(0,8),
    warnings:warnings.slice(0,12)
  };
}

async function main(){
  const catalog=JSON.parse(await readFile(new URL('./playas_catalogo.json',import.meta.url),'utf8'));
  if(!Array.isArray(catalog)||!catalog.length)throw new Error('playas_catalogo.json vacío');
  console.log('Generando datos para',catalog.length,'playas…');

  const beaches={},air={};
  await mapLimit(catalog,CONCURRENCY,async b=>{
    const [sc,aq]=await Promise.all([scenariosAt(b.lat,b.lng),airAt(b.lat,b.lng)]);
    beaches[b.id]=sc;
    air[b.id]=aq;
    process.stdout.write('.');
  });
  process.stdout.write('\n');

  console.log('Generando resumen provincial…');
  // Resumen de portada: agregación real de las playas de la costa.
  // La máxima/minima de "Hoy en la costa de Almería" sale de las playas, no de un punto fijo.
  const province=aggregateProvinceFromBeaches(beaches);

  console.log('Consultando avisos oficiales AEMET…');
  const aemet_alerts=await fetchAemetAlerts().catch(e=>({source:'AEMET Meteoalerta',fetched_at:new Date().toISOString(),ok:false,items:[],errors:[e.message]}));

  const out={
    generated_at:new Date().toISOString(),
    source:'Open-Meteo (forecast + marine + air-quality) + AEMET Meteoalerta',
    province,
    aemet_alerts,
    beaches,
    air
  };
  await writeFile(new URL('./datos_playas.json',import.meta.url),JSON.stringify(out));
  const okBeaches=Object.keys(beaches).length;
  const okAir=Object.values(air).filter(a=>!a.error).length;
  console.log(`OK · ${okBeaches} playas con clima/mar · ${okAir} con calidad del aire · resumen costa ${province?'sí':'no'} · avisos AEMET ${aemet_alerts.items.length}`);
}

main().catch(e=>{console.error('ERROR:',e);process.exit(1)});
