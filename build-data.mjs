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

const FORECAST_DAYS = 7;
const CONCURRENCY = 5;
const PROVINCE = { lat: 36.84, lng: -2.46 };

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
  const r=await fetch(url);
  if(!r.ok)throw new Error('HTTP '+r.status+' '+url);
  return r.json();
}

// Equivalente servidor de fetchScenariosAt(lat,lng): devuelve {days, hourly}
async function scenariosAt(lat,lng){
  const u=`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m&hourly=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,wind_speed_10m_max,wind_direction_10m_dominant,uv_index_max,sunrise,sunset&timezone=auto&forecast_days=${FORECAST_DAYS}&wind_speed_unit=kmh`;
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
  const hourly={time:[],temp:[],rh:[],pr:[],code:[],wind:[],gust:[],wdir:[],wave:[],waveDir:[]};
  const hr=wx.hourly||{};
  (hr.time||[]).forEach((t,i)=>{
    const date=String(t).slice(0,10),hh=parseInt(String(t).slice(11,13),10),di=dateIndex[date];
    if(di==null||Number.isNaN(hh))return;
    hourly.time.push(di*24+hh);
    hourly.temp.push(Math.round(hr.temperature_2m?.[i]??0));
    hourly.rh.push(hr.relative_humidity_2m?.[i]!=null?Math.round(hr.relative_humidity_2m[i]):null);
    hourly.pr.push(hr.precipitation?.[i]!=null?Math.round(hr.precipitation[i]*10)/10:0);
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
  let province=null;
  try{province=await scenariosAt(PROVINCE.lat,PROVINCE.lng);}catch(e){console.error('  ! sin provincia:',e.message);}

  const out={
    generated_at:new Date().toISOString(),
    source:'Open-Meteo (forecast + marine + air-quality)',
    province,
    beaches,
    air
  };
  await writeFile(new URL('./datos_playas.json',import.meta.url),JSON.stringify(out));
  const okBeaches=Object.keys(beaches).length;
  const okAir=Object.values(air).filter(a=>!a.error).length;
  console.log(`OK · ${okBeaches} playas con clima/mar · ${okAir} con calidad del aire · provincia ${province?'sí':'no'}`);
}

main().catch(e=>{console.error('ERROR:',e);process.exit(1)});
