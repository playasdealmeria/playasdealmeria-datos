#!/usr/bin/env node
/* anclar-viento.mjs  (repo playasdealmeria-datos)  ·  PARCHE "a" (email El Zapillo)
 *
 * PROBLEMA (con base en datos): Open-Meteo INFRAVALORA el viento en la costa de Almería.
 * Medido sobre 389 pares OM vs observación real (estación AEMET 6325O, aeropuerto) en
 * `rachas_validacion_2026-07.jsonl`: sesgo medio del sostenido -5,3 km/h (tarde -6,7), de la
 * racha -8,4; OM se queda corto >=5 km/h en el 60% de los casos. Es la causa raíz de la queja
 * (web decía 7, real 15-20). NO es un fallo del baremo ni de la exposición.
 *
 * POR QUÉ NO una corrección estática (regresión): obs ≈ 0,34*om + 8 → OM apenas sigue la
 * magnitud real aquí (pendiente 0,34). Corregir con una fórmula fija APLANARÍA todas las playas
 * (un día de temporal con OM=50 se corregiría a 25; un día en calma OM=5 subiría a 10). Se cargaría
 * la señal espacial/temporal que usa la app. La solución correcta es ANCLAR a la observación REAL
 * del momento, que sí se adapta día a día: en un día de brisa el sesgo sube, en un día que OM
 * acierta el sesgo es ~0 y no tocamos nada.
 *
 * DISEÑO (conservador, preserva señal, honesto):
 *   1. En build (CI), leer la observación REAL de AHORA en el aeropuerto (misma fuente/So que
 *      `validar-rachas.mjs`: AEMET 6325O, vv/vmax → km/h) y el OM de AHORA en ese punto.
 *   2. biasWind = clamp(obsNow - omNow, 0, CAP_W); biasGust = clamp(obsNow_g - omNow_g, 0, CAP_G).
 *      SOLO se sube (OM infravalora), y con tope. Si OM ya acierta o pasa, bias=0 (no toca).
 *   3. Aplicar ese nudge SOLO a HOY y SOLO a las próximas horas (nowHour..nowHour+ANCHOR_HOURS),
 *      con decaimiento lineal para no crear un escalón con la previsión posterior. Días futuros y
 *      horas lejanas quedan intactos (ahí no hay observación que ancle).
 *   4. gust >= wind siempre. Exponer `anchorInfo` (bias aplicado) para que la app pueda avisar
 *      "posible más viento del previsto por brisa de tarde" cuando el bias sea grande (canal de
 *      confianza), en vez de afirmar el dato bajo a secas.
 *
 * SEGURIDAD: OFF por defecto (env WIND_ANCHOR=1 para activarlo). Fallo NO crítico: si la obs no
 * llega, no se toca nada (feed = comportamiento actual). No cambia días futuros. Un solo punto de
 * observación (aeropuerto) => sesgo REGIONAL; primera versión. Se puede afinar por zona cuando haya
 * más estaciones. Calibrable con `banderas_historico`/`rachas_validacion`.
 *
 * Uso:  node anclar-viento.mjs --self-test      (valida la lógica con el jsonl, sin red)
 *       import { applyWindAnchor, computeBias, fetchAnchorBias } from './anclar-viento.mjs'
 */
import https from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ANCHOR_CFG = {
  CAP_W: Number(process.env.WIND_ANCHOR_CAP_W || 12),   // tope del nudge de sostenido (km/h)
  CAP_G: Number(process.env.WIND_ANCHOR_CAP_G || 15),   // tope del nudge de racha (km/h)
  HOURS: Number(process.env.WIND_ANCHOR_HOURS || 3),    // nº de horas próximas que se anclan
  MIN_NOTE: Number(process.env.WIND_ANCHOR_MIN_NOTE || 8), // bias a partir del cual marcar baja confianza
  STATION: process.env.AEMET_STATION || '6325O',
  LAT: Number(process.env.AIRPORT_LAT || 36.8439),
  LNG: Number(process.env.AIRPORT_LNG || -2.3701),
  TZ: 'Europe/Madrid'
};

// ───────── lógica PURA (unit-testable, sin red) ─────────
export function computeBias(omNow, obsNow, cfg=ANCHOR_CFG){
  // omNow/obsNow: {wind,gust}. Devuelve nudges no negativos y con tope.
  if(!omNow||!obsNow||omNow.wind==null||obsNow.wind==null) return {biasWind:0,biasGust:0};
  const bw = Math.max(0, Math.min(cfg.CAP_W, Math.round(obsNow.wind - omNow.wind)));
  const bgRaw = (omNow.gust!=null&&obsNow.gust!=null) ? (obsNow.gust - omNow.gust) : bw;
  const bg = Math.max(0, Math.min(cfg.CAP_G, Math.round(bgRaw)));
  // La racha solo se sube si Open-Meteo se queda corto en la racha (bg). NO se fuerza a subir al
  // nivel del viento: si OM ya sobreestima la racha, bg=0 y no la inflamos. El suelo "racha >= viento
  // corregido" lo garantiza applyWindAnchor al aplicar, asi que no hace falta un max(bg,bw) aqui.
  return { biasWind:bw, biasGust:bg };
}

// Aplica el ancla a HOY (time 0..23) en la ventana [nowHour, nowHour+HOURS), decayendo linealmente.
// Muta y devuelve `hourly`. Devuelve también los índices tocados. Días futuros (time>=24) intactos.
export function applyWindAnchor(hourly, bias, nowHour, cfg=ANCHOR_CFG){
  const info={applied:false,biasWind:bias.biasWind|0,biasGust:bias.biasGust|0,touched:0,lowConfidence:false};
  if(!hourly||!Array.isArray(hourly.time)) return info;
  if(!(bias.biasWind>0||bias.biasGust>0)) return info;
  const H=Math.max(1,cfg.HOURS);
  for(let i=0;i<hourly.time.length;i++){
    const t=hourly.time[i];
    if(t<nowHour||t>=nowHour+H||t>=24) continue;         // solo hoy y próximas horas
    const factor=1-(t-nowHour)/H;                          // 1 en la hora actual → 0 al final de la ventana
    const nw=Math.round(bias.biasWind*factor), ng=Math.round(bias.biasGust*factor);
    if(nw<=0&&ng<=0) continue;
    if(hourly.wind[i]!=null) hourly.wind[i]=Math.round(hourly.wind[i])+nw;
    if(hourly.gust!=null&&hourly.gust[i]!=null) hourly.gust[i]=Math.max(Math.round(hourly.gust[i])+ng, hourly.wind[i]);
    else if(hourly.gust!=null) hourly.gust[i]=hourly.wind[i];
    info.touched++;
  }
  info.applied=info.touched>0;
  info.lowConfidence=(bias.biasWind>=cfg.MIN_NOTE);
  return info;
}

// ───────── red (SOLO en CI; reutiliza el patrón validado de validar-rachas.mjs) ─────────
const agent=new https.Agent({keepAlive:true,maxSockets:1,minVersion:'TLSv1.2',maxVersion:'TLSv1.2'});
function getRaw(url,accept,depth){depth=depth||0;return new Promise((res,rej)=>{const req=https.get(url,{agent,timeout:20000,headers:{'user-agent':'playasdealmeria.es anclar-viento/1.0','accept':accept||'*/*'}},r=>{const loc=r.headers.location;if(r.statusCode>=300&&r.statusCode<400&&loc&&depth<3){r.resume();res(getRaw(new URL(loc,url).toString(),accept,depth+1));return;}const ch=[];r.on('data',c=>ch.push(c));r.on('end',()=>res({ok:r.statusCode>=200&&r.statusCode<300,status:r.statusCode,buffer:Buffer.concat(ch)}));r.on('error',rej);});req.on('timeout',()=>req.destroy(new Error('timeout')));req.on('error',rej);});}
async function getJSON(url){const r=await getRaw(url,'application/json');if(!r.ok)throw new Error('HTTP '+r.status);return JSON.parse(r.buffer.toString('utf8'));}
function madridHourISO(d){const p=new Intl.DateTimeFormat('sv-SE',{timeZone:ANCHOR_CFG.TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(d);return p.replace(' ','T').slice(0,13)+':00';}
export function pickAemetLatest(rows){if(!Array.isArray(rows))return null;const w=rows.filter(r=>r&&r.vv!=null&&r.vmax!=null);if(!w.length)return null;w.sort((a,b)=>String(a.fint||'').localeCompare(String(b.fint||'')));const r=w[w.length-1];return {wind:Math.round(Number(r.vv)*3.6),gust:Math.round(Number(r.vmax)*3.6),fint:r.fint||null,dir:r.dv!=null?Math.round(r.dv):null};}

// Devuelve {biasWind,biasGust,nowHour,obs,om} o null si no hay observación (fallo no crítico).
export async function fetchAnchorBias(nowDate){
  const key=process.env.AEMET_API_KEY||process.env.AEMET_OPENDATA_KEY||'';
  if(!key){ return null; }
  const now=nowDate||new Date();
  const isoHour=madridHourISO(now);
  let om=null,obs=null;
  try{
    const omURL=`https://api.open-meteo.com/v1/forecast?latitude=${ANCHOR_CFG.LAT}&longitude=${ANCHOR_CFG.LNG}&hourly=wind_speed_10m,wind_gusts_10m&timezone=${encodeURIComponent(ANCHOR_CFG.TZ)}&forecast_days=1&wind_speed_unit=kmh`;
    const j=await getJSON(omURL); const H=j.hourly; const i=H&&Array.isArray(H.time)?H.time.indexOf(isoHour):-1;
    if(i>=0&&H.wind_speed_10m?.[i]!=null&&H.wind_gusts_10m?.[i]!=null) om={wind:Math.round(H.wind_speed_10m[i]),gust:Math.round(H.wind_gusts_10m[i])};
  }catch(e){}
  try{
    const meta=await getJSON(`https://opendata.aemet.es/opendata/api/observacion/convencional/datos/estacion/${ANCHOR_CFG.STATION}?api_key=${key}`);
    if(meta&&meta.datos){ obs=pickAemetLatest(await getJSON(meta.datos)); }
  }catch(e){}
  if(!om||!obs) return null;
  const bias=computeBias(om,obs);
  return { ...bias, nowHour:parseInt(isoHour.slice(11,13),10), obs, om };
}

// ───────── self-test (sin red): valida lógica y reporta magnitud real del ancla ─────────
function selfTest(){
  const DIR=dirname(fileURLToPath(import.meta.url));
  const cand=[join(DIR,'rachas_validacion_2026-07.jsonl'),'/mnt/user-data/uploads/Clon GitHub/playasdealmeria-datos/rachas_validacion_2026-07.jsonl'];
  const path=cand.find(existsSync);
  if(!path){ console.log('· self-test: no encuentro el jsonl de validación'); return; }
  const recs=readFileSync(path,'utf8').split('\n').map(l=>l.trim()).filter(Boolean).map(l=>{try{return JSON.parse(l);}catch(e){return null;}}).filter(r=>r&&r.om_wind!=null&&r.obs_wind!=null&&r.om_gust!=null&&r.obs_gust!=null);
  let nudged=0,capW=0,rawErr=0,corrErr=0,sumBias=0, lowConf=0;
  for(const r of recs){
    const bias=computeBias({wind:r.om_wind,gust:r.om_gust},{wind:r.obs_wind,gust:r.obs_gust});
    if(bias.biasWind>0)nudged++;
    if(bias.biasWind===ANCHOR_CFG.CAP_W)capW++;
    if(bias.biasWind>=ANCHOR_CFG.MIN_NOTE)lowConf++;
    sumBias+=bias.biasWind;
    rawErr+=Math.abs(r.om_wind-r.obs_wind);
    corrErr+=Math.abs((r.om_wind+bias.biasWind)-r.obs_wind);   // corrección en el punto de anclaje
  }
  const n=recs.length;
  // pruebas de invariantes
  const inv=[];
  { const b=computeBias({wind:20,gust:30},{wind:10,gust:12}); inv.push(['no baja si OM ya alto (bias 0)', b.biasWind===0]); }
  { const b=computeBias({wind:4,gust:12},{wind:40,gust:60}); inv.push(['tope CAP_W', b.biasWind===ANCHOR_CFG.CAP_W]); }
  { const b=computeBias({wind:4,gust:12},{wind:11,gust:19}); inv.push(['sube el caso email (~+7)', b.biasWind===7]); }
  { const b=computeBias({wind:3,gust:16},{wind:10,gust:13}); inv.push(['no infla racha si OM ya la sobreestima (bg=0)', b.biasWind===7&&b.biasGust===0]); }
  { const hourly={time:[10,11],wind:[3,3],gust:[16,16]}; applyWindAnchor(hourly,computeBias({wind:3,gust:16},{wind:10,gust:13}),10,ANCHOR_CFG);
    inv.push(['racha no se dispara: 16 se queda en 16, no 23', hourly.gust[0]===16]); }
  { const hourly={time:[10,11,12,13,24,25],wind:[5,5,5,5,5,5],gust:[8,8,8,8,8,8]}; const info=applyWindAnchor(hourly,{biasWind:9,biasGust:12},11,ANCHOR_CFG);
    inv.push(['no toca ayer/futuro (t>=24)', hourly.wind[4]===5&&hourly.wind[5]===5]);
    inv.push(['no toca horas pasadas (t<now)', hourly.wind[0]===5]);
    inv.push(['ancla hora actual con nudge completo', hourly.wind[1]===14]);
    inv.push(['decae con la distancia', hourly.wind[2]<14 && hourly.wind[2]>5]);
    inv.push(['gust>=wind', hourly.gust.every((g,i)=>g>=hourly.wind[i])]); }
  console.log('=== anclar-viento · self-test (n='+n+' pares reales) ===');
  console.log('Ancla se activa (OM<obs) en '+nudged+'/'+n+' = '+Math.round(100*nudged/n)+'% de los casos');
  console.log('Nudge medio del sostenido: +'+(sumBias/n).toFixed(1)+' km/h · llega al tope en '+capW+' casos · marca baja confianza en '+lowConf+' ('+Math.round(100*lowConf/n)+'%)');
  console.log('Error medio |sostenido| en el punto de anclaje: crudo '+(rawErr/n).toFixed(1)+' → anclado '+(corrErr/n).toFixed(1)+' km/h');
  let ok=0; for(const [name,pass] of inv){ console.log((pass?'  PASS ':'  FAIL ')+name); if(pass)ok++; }
  console.log('Invariantes: '+ok+'/'+inv.length+(ok===inv.length?' OK':' *** FALLA'));
  process.exit(ok===inv.length?0:1);
}
if(process.argv.includes('--self-test')) selfTest();
