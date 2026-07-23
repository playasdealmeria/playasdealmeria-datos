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
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { gunzipSync, unzipSync } from 'node:zlib';
import https from 'node:https'; // v91.11 datos: TLS 1.2 para la Junta

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
// v91.3 datos: AEMET se cachea internamente para evitar rate-limit.
// El workflow puede seguir actualizando tiempo/mar cada hora, pero OpenData no se golpea en cada ejecución.
const AEMET_CACHE_HOURS = Math.max(1, Number(process.env.AEMET_CACHE_HOURS||3));
const AEMET_FAIL_CACHE_MINUTES = Math.max(0, Number(process.env.AEMET_FAIL_CACHE_MINUTES||25)); // datos v91.10: TTL corto para registros FALLIDOS
const AEMET_COASTAL_ZONE_CODES = new Set(Object.keys(AEMET_ZONE_CODES));


// ---- helpers portados 1:1 desde la app ----
function avg(arr){const v=(arr||[]).filter(x=>x!=null&&!Number.isNaN(x));return v.length?v.reduce((a,b)=>a+b,0)/v.length:null;}
function maxv(arr){const v=(arr||[]).filter(x=>x!=null&&!Number.isNaN(x));return v.length?Math.max(...v):null;}
function mode(arr){const v=(arr||[]).filter(x=>x!=null);if(!v.length)return null;const m=new Map();v.forEach(x=>m.set(x,(m.get(x)||0)+1));return [...m.entries()].sort((a,b)=>b[1]-a[1])[0][0];}
function windType(dir,spd){if(spd<12)return 'flojo';if(dir>=45&&dir<=135)return 'levante';if(dir>135&&dir<200)return 'sur';if(dir>=200&&dir<=330)return 'poniente';return 'terral';}
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
  const dir=meanDir(idxs.map(i=>wh.wind_direction_10m?.[i]));
  const waveH=avg(times.map(t=>marineByTime[t]?.waveH));
  const waveDir=meanDir(times.map(t=>marineByTime[t]?.waveDir));
  const temp=avg(idxs.map(i=>wh.temperature_2m?.[i]));
  return {ico:e.ico,estadoTxt:e.estadoTxt,temp:temp!=null?Math.round(temp):null,windK:spd!=null?Math.round(spd):null,gustK:gust!=null?Math.round(gust):(spd!=null?Math.round(spd*1.3):null),windDir:dir!=null?Math.round(dir):null,waveH:waveH!=null?Math.round(waveH*10)/10:null,waveDir:waveDir!=null?Math.round(waveDir):null};
}

async function getJSON(url){
  const r=await fetch(url,{headers:{'user-agent':'playasdealmeria.es datos/1.0'}});
  if(!r.ok)throw new Error('HTTP '+r.status+' '+sanitizeURLForLog(url));
  return r.json();
}

// ===== v91.9 datos: banderas y ocupación OFICIALES (Junta de Andalucía) — ACTIVO desde 9 jul 2026 =====
// Autorización: el IECA (ref. _7738) traslada que andalucia.org, fuente del dato, no pone
// inconveniente a la reutilización siempre que se cite la fuente. Guardar ese correo.
// Uso declarado por escrito a andalucia.org: ~40 playas cada 30 min (~80 peticiones/hora),
// con caché, User-Agent identificado y espera ante 429/5xx.
// APAGADO DE EMERGENCIA SIN DEPLOY: definir JUNTA_OFICIAL=false en el workflow.
const JUNTA_OFICIAL   = String(process.env.JUNTA_OFICIAL ?? 'true').toLowerCase() !== 'false';
const JUNTA_BASE      = process.env.JUNTA_BASE || 'https://maps.andalucia.org/rest-turistico/rest/beach/get/';
const JUNTA_PAUSE_MS  = Math.max(0, Number(process.env.JUNTA_PAUSE_MS || 150));
const JUNTA_TIMEOUT_MS= Math.max(1000, Number(process.env.JUNTA_TIMEOUT_MS || 6000));
const JUNTA_BUDGET_MS = Math.max(10000, Number(process.env.JUNTA_BUDGET_MS || 120000));
const JUNTA_UA        = process.env.JUNTA_UA || 'playasdealmeria-datos/1.0 (+https://playasdealmeria.es; contacto: playasdealmeria.es@gmail.com)';
const JUNTA_ATTR      = 'Junta de Andalucía · andalucia.org';
const JUNTA_URL_PUB   = 'https://www.andalucia.org/';
// Mapeo COMPLETO 40/40: generado el 3 jul y depurado/completado A MANO por el propietario el mismo día.
// Nota: Mojácar Playa usa "Playa Descargador" como tramo representativo (no hay entrada única de Mojácar en el servicio).
const JUNTA_MAP={
  '10':16540, // Playa del Zapillo (id confirmado a mano 3 jul)
  '18':16465, // Los Genoveses (a mano 3 jul)
  '19':16247, // Playa del Mónsul (a mano 3 jul)
  '20':16234, // Barronal (a mano 3 jul)
  '28':16254, // Cala del Plomo (a mano 3 jul)
  '30':16469, // Playa de los Muertos (a mano 3 jul)
  '34':16286, // Playa de Macenas (a mano 3 jul)
  '35':16354, // El Sombrerico (a mano 3 jul)
  '43':16236, // Los Cocedores (a mano 3 jul)
  '1':16541, // Playa de San Nicolás (610m)
  '2':16226, // Playa de Balanegra (corregida a mano 3 jul)
  '3':16460, // Balerma - Guardias Viejas (corregida a mano 3 jul)
  '4':16210, // Poniente Almerimar beach (968m)
  '5':16596, // Punta Entinas - Sabinar beach (1463m)
  '6':16204, // Playa de Aguadulce (1129m)
  '7':16431, // Playa de la Romanilla (779m)
  '8':16548, // Playa Serena / Urbanización de Roquetas (FIX 21jul: 16384 era 'Playa de la Bajadilla')
  '9':33967, // Playa de San Miguel (432m)
  '11':16487, // Playa de Nueva Almería (2034m)
  '12':16297, // Costacabana beach (954m)
  '13':16355, // El Toyo beach (627m)
  '14':16539, // Playa de San Miguel de Cabo de Gata (1444m)
  '15':16407, // La Fabriquilla beach (127m)
  '16':16410, // La Garrofa beach (1326m)
  '17':16538, // San José beach (337m)
  '21':16260, // Cala Rajá (487m)
  '22':16307, // Arco and el Esparto beaches (129m)
  '23':16495, // Plage Peñón Blanco (203m)
  '24':16511, // Playazo de Rodalquilar (2263m)
  '25':16449, // Las Negras beach (1069m)
  '26':16261, // Cala San Pedro (860m)
  '27':16241, // Cala de Enmedio (507m)
  '29':16206, // Aguamarga beach (427m)
  '31':16461, // Playa de los Barquicos-Los Cocones (236m)
  '32':16329, // Playa Descargador — tramo central de Mojácar Playa (elegida a mano 3 jul)
  '33':16477, // Playa Marina de la Torre (330m)
  '36':33955, // Playa Pósito Garrucha (153m)
  '37':16591, // El Playazo (1458m)
  '38':16512, // Playazo de Villaricos (FIX 21jul: 30489 era 'Cala Verde')
  '41':16245, // Cala de la Tía Antonia (902m)
  '44':16451, // Las Salinas de Cabo de Gata (mapa 21jul)
  '45':16340, // Playa del Palmer (mapa 21jul)
  '47':16243, // Cala de la Media Luna (mapa 21jul)
  '48':16232, // Cala Arena (mapa 21jul)
  '49':16211, // Playa del Corralete (mapa 21jul)
};
const JUNTA_FLAG={BAPLAVERDE:'verde',BAPLAAMARILLA:'amarilla',BAPLAROJA:'roja',BAPLANEGRA:'negra'};
// [label ES, código estable]. El código viaja al JSON para que la web traduzca sin comparar cadenas.
const JUNTA_OCU={
  OCUPLABAJA:['Baja','baja'],
  OCUPLAMEDBAJA:['Media-baja','media_baja'],
  OCUPLAMEDIA:['Media','media'],
  OCUPLAMEDALTA:['Media-alta','media_alta'],
  OCUPLAALTA:['Alta','alta'],
};
const juntaSleep=ms=>new Promise(r=>setTimeout(r,ms));
/* ===== v91.11 datos: TLS 1.2 para la Junta =====
   Medido en el runner de GitHub (9 jul 2026), contra la MISMA IP y en el MISMO segundo:
     TCP puro                  ✓ 88 ms
     curl -4 / openssl (TLS13) ✓ http=200
     node, TLS por defecto     ✗ TIMEOUT 12,1 s
     node, TLS 1.2             ✓ http=200 en 413 ms
   Node 24 manda un ClientHello grande (grupos post-cuánticos de OpenSSL); se parte en dos
   segmentos TCP y un balanceador delante de la Junta descarta el segundo. Con TLS 1.2 el
   saludo cabe en un segmento y pasa.
   Solo se aplica a la Junta. AEMET y Open-Meteo siguen con fetch: no tienen el problema.
   Si algún día arreglan el balanceador: JUNTA_TLS_MAX=TLSv1.3, sin tocar código. */
const JUNTA_TLS_MAX = process.env.JUNTA_TLS_MAX || 'TLSv1.2';
const juntaAgent = new https.Agent({
  keepAlive: true,          // 40 peticiones seguidas al mismo host: se reaprovecha la conexión
  maxSockets: 1,            // en serie, como hasta ahora: sin ráfagas contra un servicio público
  minVersion: 'TLSv1.2',
  maxVersion: JUNTA_TLS_MAX,
});
// Devuelve un objeto con la forma mínima de una Response: {ok, status, json()}.
// Así el resto de fetchJuntaOficial() no cambia ni una línea.
function juntaFetchOnce(url){
  return new Promise((resolve,reject)=>{
    const req=https.get(url,{
      agent:juntaAgent,
      timeout:JUNTA_TIMEOUT_MS,
      headers:{'Accept':'application/json','Accept-Language':'es','User-Agent':JUNTA_UA}
    },res=>{
      const trozos=[];
      res.on('data',c=>trozos.push(c));
      res.on('end',()=>{
        const cuerpo=Buffer.concat(trozos).toString('utf8');
        resolve({
          ok:res.statusCode>=200&&res.statusCode<300,
          status:res.statusCode,
          json:async()=>JSON.parse(cuerpo)
        });
      });
      res.on('error',reject);
    });
    // 'timeout' es inactividad del socket: hay que destruirlo a mano o la promesa cuelga.
    req.on('timeout',()=>{req.destroy(new Error('timeout tras '+JUNTA_TIMEOUT_MS+' ms'));});
    req.on('error',reject);
  });
}
// Un reintento con espera ante 429/5xx o error de red. Nunca más: si el servicio va mal, se cede el turno.
async function juntaFetch(url){
  let last=null;
  for(let i=0;i<2;i++){
    try{
      const r=await juntaFetchOnce(url);
      if((r.status===429||r.status>=500)&&i===0){await juntaSleep(3000);continue;}
      return r;
    }catch(e){ last=e; if(i===0){await juntaSleep(3000);continue;} }
  }
  throw last||new Error('juntaFetch agotado');
}
async function fetchJuntaOficial(){
  const meta={
    enabled:JUNTA_OFICIAL,
    source:'Catálogo General de Playas de Andalucía · visor "Playas Seguras de Andalucía"',
    attribution:JUNTA_ATTR,
    url:JUNTA_URL_PUB,
    license_note:'Reutilización autorizada citando la fuente (respuesta del IECA, ref. _7738, 9 jul 2026).',
    fetched_at:new Date().toISOString(),
    requested:0, count:0, count_flags:0, // datos v91.11: se retira el contador de ocupación (dato no mantenido por la fuente)
    tls:JUNTA_TLS_MAX, // v91.11 datos: TLS 1.2 para la Junta: con TLS 1.3 el balanceador de la Junta descarta el ClientHello de Node
    ok:false, truncated:false, elapsed_ms:0, errors:[]
  };
  if(!JUNTA_OFICIAL){ console.log('· Datos oficiales Junta: DESACTIVADOS (JUNTA_OFICIAL=false)'); return {data:{},meta}; }
  const out={};
  const t0=Date.now();
  const entries=Object.entries(JUNTA_MAP);
  meta.requested=entries.length;
  for(const [ourId,jid] of entries){
    if(Date.now()-t0>JUNTA_BUDGET_MS){ meta.truncated=true; break; }
    try{
      const r=await juntaFetch(JUNTA_BASE+jid);
      if(r.ok){
        const j=await r.json();const p=(j&&j.payload)||{};const rec={};
        const f=p.beach_flag&&p.beach_flag.code;if(f&&JUNTA_FLAG[f])rec.oflag=JUNTA_FLAG[f];
        /* datos v91.11: RETIRADA la lectura del antiguo campo de ocupación de la Junta.
           Veredicto del 13 jul sobre 368 commits/7 días: las 40 playas SIEMPRE en el mismo
           valor ("media-baja"), 0 cambios, 0 intradía — con jid distintos y verificados por
           playa, eso descarta un bug nuestro; es un dato que la fuente no mantiene en la
           práctica (a diferencia de la bandera, que sí varía y es obligación del socorrismo).
           Ver AUDITORIA/PENDIENTES. La web ya lo ignoraba (OCUPACION_VISIBLE=false); esto
           solo deja de pedirlo y de escribirlo. */
        if(p.beach_state&&p.beach_state.code)rec.abierta=(p.beach_state.code==='ESPLASABIERTA');
        if(rec.oflag){
          rec.oflagSource=JUNTA_ATTR;
          rec.ofiAt=new Date().toISOString(); // hora REAL de lectura, no la del build
          out[ourId]=rec;
        }
      } else if(meta.errors.length<3){ meta.errors.push('HTTP '+r.status+' en playa '+ourId); }
      await juntaSleep(JUNTA_PAUSE_MS); // pausa respetuosa entre peticiones
    }catch(e){
      if(meta.errors.length<3)meta.errors.push('playa '+ourId+': '+String(e&&e.message||e).slice(0,80));
      // sin dato oficial para esta playa: la web usa la bandera orientativa
    }
  }
  // v91.10 datos: desglose banderas/ocupación: 'count' es "playas con ALGO". Lo que de verdad interesa vigilar es cada cosa por su lado.
  const __recs__=Object.values(out);
  meta.count=__recs__.length;
  meta.count_flags=__recs__.filter(r=>r.oflag).length;
  meta.elapsed_ms=Date.now()-t0;
  meta.ok=meta.count>0 && !meta.truncated;
  console.log('· Datos oficiales Junta: '+meta.count+'/'+meta.requested+' playas ('+meta.count_flags+' banderas) en '+meta.elapsed_ms+' ms'+(meta.truncated?' (presupuesto agotado)':''));
  // Igual que AEMET: el run NO se pone rojo. Solo avisa. Si se repite varios días, mirar el servicio.
  // Igual que AEMET: el run NO se pone rojo. Solo avisa.
  // Ojo: NO se vigila 'count_flags' con un porcentaje. La cobertura de banderas de la Junta es
  // irregular por diseño (hay playas que nunca la publican: el propio visor las pinta en gris).
  // Lo que sí es anómalo es que NO haya ninguna: eso huele a cambio en el servicio.
  if(meta.count_flags===0 && meta.requested>0) console.log('::warning::CERO banderas oficiales en las '+meta.requested+' playas. ¿Ha cambiado el servicio de la Junta? La web mostrará bandera orientativa en todas.');
  return {data:out,meta};
}
const __OFI_RES__=await fetchJuntaOficial();
const __OFI__=__OFI_RES__.data;
const __OFI_META__=__OFI_RES__.meta;
// ===== El Ejido: banderas oficiales del Ayuntamiento (rellenan las que la Junta no publica) =====
// El Ejido gestiona su propio socorrismo y publica la bandera diaria en su API pública
// (elejido.es/playas/api). La Junta tiene estas playas en su catálogo pero NO recibe su bandera.
// Dato público de una administración; se cita la fuente y se cachea. Kill-switch: EJIDO_OFICIAL=false.
const EJIDO_OFICIAL = String(process.env.EJIDO_OFICIAL ?? 'true').toLowerCase() !== 'false';
const EJIDO_URL     = process.env.EJIDO_URL || 'https://elejido.es/playas/api/?url=infoplayas';
const EJIDO_ATTR    = 'Ayuntamiento de El Ejido';
const EJIDO_TIMEOUT_MS = Math.max(1000, Number(process.env.EJIDO_TIMEOUT_MS || 6000));
// nuestro_id <- [ids de El Ejido] (muchos-a-uno). Se toma la PEOR bandera entre las sub-playas.
const EJIDO_MAP = { '3':[4,6,8], '4':[2,3] }; // 3 Balerma-Guardias Viejas <- Balerma(4)+Guardias(6)+Piedra del Moro(8) · 4 Almerimar <- Levante(2)+Poniente(3)
const EJIDO_SEV = { verde:1, amarilla:2, roja:3, negra:4 };
function ejidoNorm(s){ s=String(s||'').toLowerCase().trim(); if(s==='amarillo')s='amarilla'; if(s==='rojo')s='roja'; return s; }
function ejidoWorse(a,b){ return (EJIDO_SEV[b]||0)>(EJIDO_SEV[a]||0)?b:a; }
async function fetchEjidoOficial(){
  const meta={enabled:EJIDO_OFICIAL, source:EJIDO_ATTR, requested:Object.keys(EJIDO_MAP).length, count:0, count_flags:0, elapsed_ms:0, errors:[]};
  if(!EJIDO_OFICIAL){ console.log('· Datos oficiales El Ejido: DESACTIVADOS (EJIDO_OFICIAL=false)'); return {data:{},meta}; }
  const t0=Date.now(); const out={};
  try{
    const ctrl=new AbortController(); const to=setTimeout(()=>ctrl.abort(), EJIDO_TIMEOUT_MS);
    let arr;
    try{ arr=await fetch(EJIDO_URL,{headers:{'User-Agent':JUNTA_UA,'Accept':'application/json'},signal:ctrl.signal}).then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}); }
    finally{ clearTimeout(to); }
    if(!Array.isArray(arr)) throw new Error('respuesta no es un array');
    const byId={}; for(const b of arr) byId[b.id]=b;
    for(const [ourId,subIds] of Object.entries(EJIDO_MAP)){
      let flag=null, upd=null;
      for(const sid of subIds){
        const sb=byId[sid]; if(!sb) continue;
        const f=ejidoNorm(sb.bandera); if(!EJIDO_SEV[f]) continue;
        flag = flag ? ejidoWorse(flag,f) : f;
        if(sb.actualizado && (!upd || String(sb.actualizado)>upd)) upd=String(sb.actualizado);
      }
      if(flag){ out[ourId]={oflag:flag, oflagSource:EJIDO_ATTR, ofiAt:new Date().toISOString()}; meta.count++; meta.count_flags++; }
    }
  }catch(e){ meta.errors.push(String(e&&e.message||e).slice(0,120)); console.log('! El Ejido oficial: '+meta.errors[0]); }
  meta.elapsed_ms=Date.now()-t0;
  console.log('· Datos oficiales El Ejido: '+meta.count_flags+'/'+meta.requested+' playas con bandera en '+meta.elapsed_ms+' ms');
  return {data:out, meta};
}
const __EJIDO_RES__=await fetchEjidoOficial();
const __EJIDO__=__EJIDO_RES__.data;
// CASCADA de fuentes oficiales MUNICIPALES, en orden de prioridad.
// PRIORIDAD: el ayuntamiento manda en la BANDERA (es quien iza el socorrismo y suele ser más fresco);
// la Junta queda de base y aporta la OCUPACIÓN. Si nadie da bandera → la app usa la estimada.
// Extensible: añadir aquí Carboneras/Zenkra, Roquetas, etc. cuando estén listas (orden = prioridad).
const __MUNI_OFI__=[__EJIDO__];
// ===== Roquetas de Mar: banderas oficiales (la Junta NO las publica; su web sí) =====
// Web municipal Drupal (módulo tic_proteccion_playas), renderizada en servidor. Cada playa es un
// bloque id="tooltip_{slug}" con su bandera-{color}.png dentro. Dato público de administración; se
// cita la fuente y se cachea (kill-switch ROQUETAS_OFICIAL=false). Sin hotlinkear imágenes.
const ROQUETAS_OFICIAL = String(process.env.ROQUETAS_OFICIAL ?? 'true').toLowerCase() !== 'false';
const ROQUETAS_URL = process.env.ROQUETAS_URL || 'https://roquetasdemar.es/tu-ayuntamiento/areas-municipales/turismo-y-playas/playas';
const ROQUETAS_ATTR = 'Ayuntamiento de Roquetas de Mar';
const ROQUETAS_TIMEOUT_MS = Math.max(1000, Number(process.env.ROQUETAS_TIMEOUT_MS || 6000));
// nuestro_id <- [slugs de tooltip en la web de Roquetas] (muchos-a-uno, PEOR bandera).
// #8 combina Playa Serena + Urbanización Roquetas. bajadilla/bajos/cerrillos/salinas no tienen ficha nuestra.
const ROQUETAS_MAP = { '6':['aguadulce'], '7':['romanilla'], '8':['playa_serena','urbanizacion_roquetas'], '11':['ventilla'] };
async function fetchRoquetasOficial(){
  const meta={enabled:ROQUETAS_OFICIAL, source:ROQUETAS_ATTR, requested:Object.keys(ROQUETAS_MAP).length, count:0, count_flags:0, elapsed_ms:0, errors:[]};
  if(!ROQUETAS_OFICIAL){ console.log('· Datos oficiales Roquetas: DESACTIVADOS (ROQUETAS_OFICIAL=false)'); return {data:{},meta}; }
  const t0=Date.now(); const out={};
  try{
    const ctrl=new AbortController(); const to=setTimeout(()=>ctrl.abort(), ROQUETAS_TIMEOUT_MS);
    let html;
    try{ html=await fetch(ROQUETAS_URL,{headers:{'User-Agent':JUNTA_UA,'Accept':'text/html'},signal:ctrl.signal}).then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.text();}); }
    finally{ clearTimeout(to); }
    // bandera del bloque id="tooltip_{slug}", acotada hasta el siguiente tooltip (no contamina con leyenda ni vecinos)
    const flagAt=slug=>{ const i=html.indexOf('id="tooltip_'+slug+'"'); if(i<0) return null; const j=html.indexOf('tooltip_', i+12); const seg=html.slice(i, j<0? i+1500 : j); const m=seg.match(/bandera-(verde|amarilla|roja|negra)/); return m?m[1]:null; };
    for(const [ourId,slugs] of Object.entries(ROQUETAS_MAP)){
      let flag=null;
      for(const s of slugs){ const f=flagAt(s); if(!f||!EJIDO_SEV[f]) continue; flag=flag?ejidoWorse(flag,f):f; }
      if(flag){ out[ourId]={oflag:flag, oflagSource:ROQUETAS_ATTR, ofiAt:new Date().toISOString()}; meta.count++; meta.count_flags++; }
    }
  }catch(e){ meta.errors.push(String(e&&e.message||e).slice(0,120)); console.log('! Roquetas oficial: '+meta.errors[0]); }
  meta.elapsed_ms=Date.now()-t0;
  console.log('· Datos oficiales Roquetas: '+meta.count_flags+'/'+meta.requested+' playas con bandera en '+meta.elapsed_ms+' ms');
  return {data:out, meta};
}
const __ROQUETAS_RES__=await fetchRoquetasOficial();
const __ROQUETAS__=__ROQUETAS_RES__.data;
__MUNI_OFI__.push(__ROQUETAS__);


// ===== fin datos oficiales Junta =====

// Equivalente servidor de fetchScenariosAt(lat,lng): devuelve {days, hourly}
async function scenariosAt(lat,lng){
  const u=`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m&hourly=temperature_2m,relative_humidity_2m,precipitation,precipitation_probability,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,uv_index_max,sunrise,sunset&timezone=auto&forecast_days=${FORECAST_DAYS}&wind_speed_unit=kmh`;
  const wx=await getJSON(u);
  let sst=null,marD=null,marH=null; // datos v91.14-B: sin dato marino -> null (se arrastra el ultimo conocido en main)
  try{
    const mar=await getJSON(`https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lng}&current=sea_surface_temperature&hourly=wave_height,wave_direction,sea_level_height_msl&daily=wave_height_max,wave_direction_dominant&timezone=auto&forecast_days=${FORECAST_DAYS}`);
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
    const spd=d.wind_speed_10m_max?.[i]??(i===0?cur.wind_speed_10m:0)??0; // datos v91.14: dia 0 = max del dia (no la foto current)
    const dir=d.wind_direction_10m_dominant?.[i]??(i===0?cur.wind_direction_10m:0)??0; // datos v91.14: dia 0 = dominante del dia
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
      rachas:Math.round(d.wind_gusts_10m_max?.[i]??(i===0?cur.wind_gusts_10m:spd*1.3)??spd*1.3), // datos v91.14: dia 0 = max de 24h
      sale:d.sunrise?.[i]?String(d.sunrise[i]).slice(11,16):'06:50', // datos v91.14-B: el literal viejo daba '' (slice fuera de rango)
      pone:d.sunset?.[i]?String(d.sunset[i]).slice(11,16):'21:30', // datos v91.14-B
      uv:d.uv_index_max?.[i]!=null?Math.round(d.uv_index_max[i]):null, // datos v91.14-B: guardaba el array, no el elemento (Math.round(null)=0)
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
    hourly.wave.push(marineByTime[t]?.waveH??null); // datos v91.14-B: sin fabricar 0 m
    hourly.waveDir.push(marineByTime[t]?.waveDir!=null?Math.round(marineByTime[t].waveDir):null); // datos v91.14-B: sin fabricar 180
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
function meanDir(vals){const v=(vals||[]).filter(validNum).map(Number);if(!v.length)return null;let s=0,c=0;for(const d of v){const r=d*Math.PI/180;s+=Math.sin(r);c+=Math.cos(r);}if(Math.abs(s)<1e-9&&Math.abs(c)<1e-9)return null;const a=Math.round(Math.atan2(s,c)*180/Math.PI);return ((a%360)+360)%360;} // datos v91.13: media CIRCULAR de direcciones (0=360). La aritmetica rompia el terral (350-010 -> ~180 = sur).
function roundMax(vals){const v=(vals||[]).filter(validNum).map(Number);return v.length?Math.round(Math.max(...v)):null;}
function roundMin(vals){const v=(vals||[]).filter(validNum).map(Number);return v.length?Math.round(Math.min(...v)):null;}
function common(vals,fallback=null){const v=(vals||[]).filter(x=>x!=null);if(!v.length)return fallback;const m=new Map();v.forEach(x=>m.set(String(x),(m.get(String(x))||0)+1));return [...m.entries()].sort((a,b)=>b[1]-a[1])[0][0];}
function aggregatePart(parts){
  const src=(parts||[]).filter(Boolean);
  if(!src.length)return null;
  const ico=common(src.map(x=>x.ico),'⛅');
  const estadoTxt=common(src.map(x=>x.estadoTxt),'variable');
  const windK=roundAvg(src.map(x=>x.windK));
  const windDir=meanDir(src.map(x=>x.windDir));
  return {
    ico,
    estadoTxt,
    temp:roundAvg(src.map(x=>x.temp)),
    windK,
    gustK:roundMax(src.map(x=>x.gustK)),
    windDir,
    waveH:avg(src.map(x=>x.waveH))!=null?Math.round(avg(src.map(x=>x.waveH))*10)/10:null,
    waveDir:meanDir(src.map(x=>x.waveDir))
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
    out.code.push(Number(common(g.code,0)));out.wind.push(roundAvg(g.wind));out.gust.push(roundMax(g.gust));out.wdir.push(meanDir(g.wdir));
    out.wave.push(avg(g.wave)!=null?Math.round(avg(g.wave)*10)/10:null);out.waveDir.push(meanDir(g.waveDir));
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
      waveDir:meanDir(list.map(x=>x.waveDir)),
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



function sanitizeURLForLog(url){
  // v91.52: se recorta la query COMPLETA, no solo el valor de la clave.
  // Dejar el literal "api_key=[redacted]" en los mensajes de error hacía saltar
  // el escáner de secretos del workflow (falso positivo).
  return String(url||'').replace(/https?:\/\/[^\s"'<>]+/gi, m => {
    const i = m.indexOf('?');
    return i >= 0 ? m.slice(0, i) : m;
  });
}
function sanitizeErrorMessage(msg){
  return sanitizeURLForLog(String(msg||''))
    .replace(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[redacted-token]');
}

function sanitizeAemetRecord(record, opts={}){
  const a=record&&typeof record==='object'?JSON.parse(JSON.stringify(record)):{};
  a.source=a.source||'AEMET Meteoalerta';
  a.fetched_at=a.fetched_at||new Date().toISOString();
  a.items=Array.isArray(a.items)?a.items:[];
  a.errors=(Array.isArray(a.errors)?a.errors:[]).map(sanitizeErrorMessage).slice(0,8);
  a.warnings=(Array.isArray(a.warnings)?a.warnings:[]).map(sanitizeErrorMessage).slice(0,12);
  if(a.method!=='opendata_cap' || a.html_fallback_used || a.errors.length){
    a.ok=false;
  }else{
    a.ok=!!a.ok;
  }
  if(opts.cached){a.cached=true;a.cache_age_minutes=opts.cacheAgeMinutes;}
  if(opts.staleFrom){a.stale_items_used=true;a.stale_from=opts.staleFrom;}
  return a;
}
function aemetAgeMinutes(a){
  const t=Date.parse(a&&a.fetched_at||'');
  if(!Number.isFinite(t))return Infinity;
  return Math.max(0,Math.round((Date.now()-t)/60000));
}
function shouldReuseAemet(a){
  const age=aemetAgeMinutes(a);
  if(!Number.isFinite(age))return false;
  // datos v91.10: la caché larga (AEMET_CACHE_HOURS) es solo para ÉXITOS (anti
  // rate-limit: no reconsultar lo que ya tienes). Un registro FALLIDO (ok:false)
  // se reutiliza como mucho AEMET_FAIL_CACHE_MINUTES: cachear un fallo 3 h
  // retrasaba la recuperación y la verificación de arreglos (visto el 11 jul
  // con el TLS de AEMET: el run de las 21:35 ni intentó la llamada).
  const maxMin=(a&&a.ok===true)?AEMET_CACHE_HOURS*60:AEMET_FAIL_CACHE_MINUTES;
  return age <= maxMin;
}
async function readPreviousAemet(){
  try{
    const prev=JSON.parse(await readFile(new URL('./datos_playas.json',import.meta.url),'utf8'));
    return prev&&prev.aemet_alerts?prev.aemet_alerts:null;
  }catch(e){return null;}
}

function stripHTML(x){return String(x||'').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&aacute;/gi,'á').replace(/&eacute;/gi,'é').replace(/&iacute;/gi,'í').replace(/&oacute;/gi,'ó').replace(/&uacute;/gi,'ú').replace(/&ntilde;/gi,'ñ').replace(/&#243;/g,'ó').replace(/&#237;/g,'í').replace(/\s+/g,' ').trim();}
function norm(s){return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();}
function htmlDecode(x){return stripHTML(String(x||'').replace(/<!\[CDATA\[|\]\]>/g,''));}
function xmlDecode(x){return htmlDecode(String(x||'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'"));}
async function getText(url){
  const r=await fetch(url,{headers:{'user-agent':'playasdealmeria.es datos/1.0','accept':'text/html,application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8'}});
  if(!r.ok)throw new Error('HTTP '+r.status+' '+sanitizeURLForLog(url));
  return await r.text();
}
/* ===== datos v91.9 · AEMET OpenData por node:https con TLS<=1.2 =====
   Sintoma: "OpenData: fetch failed" cronico tras migrar el repo a Node 24.
   Causa: el ClientHello del fetch de undici (Node 24) no completa el handshake
   con el terminador TLS de opendata.aemet.es — el MISMO mal que el balanceador
   de la Junta (v91.11 datos). Remedio identico: agente https con TLS 1.2.
   Sin Accept-Encoding: la respuesta llega sin comprimir (el .tar.gz de env.datos
   es formato de CONTENIDO y lo decodifica decodeAemetPayload, no transporte).
   Sigue redirecciones (max 3): https.get no las sigue solo y fetch si lo hacia. */
const AEMET_TIMEOUT_MS = 20000;
const aemetAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 1,
  minVersion: 'TLSv1.2',
  maxVersion: 'TLSv1.2',
});
function aemetGetRaw(url, accept, depth){
  depth = depth || 0;
  return new Promise((resolve,reject)=>{
    const req=https.get(url,{
      agent:aemetAgent,
      timeout:AEMET_TIMEOUT_MS,
      headers:{'user-agent':'playasdealmeria.es datos/1.0','accept':accept||'*/*'}
    },res=>{
      const loc=res.headers.location;
      if(res.statusCode>=300&&res.statusCode<400&&loc&&depth<3){
        res.resume();
        resolve(aemetGetRaw(new URL(loc,url).toString(),accept,depth+1));
        return;
      }
      const trozos=[];
      res.on('data',c=>trozos.push(c));
      res.on('end',()=>{
        resolve({
          ok:res.statusCode>=200&&res.statusCode<300,
          status:res.statusCode,
          buffer:Buffer.concat(trozos),
          contentType:res.headers['content-type']||'',
          contentEncoding:res.headers['content-encoding']||''
        });
      });
      res.on('error',reject);
    });
    req.on('timeout',()=>{req.destroy(new Error('timeout tras '+AEMET_TIMEOUT_MS+' ms'));});
    req.on('error',reject);
  });
}
async function getAemetJSON(url, tries = 3){
  // v91.52: AEMET OpenData devuelve 429 de forma esporádica. Reintentamos con
  // espera creciente antes de rendirnos y caer al caché de avisos.
  // datos v91.9: la petición va por aemetGetRaw (node:https, TLS<=1.2); el fetch
  // de undici moría en el handshake con Node 24 ("fetch failed").
  const waits = [3000, 10000];
  let last = 0;
  for (let i = 0; i < tries; i++){
    const r = await aemetGetRaw(url,'application/json');
    if (r.ok) return JSON.parse(r.buffer.toString('utf8'));
    last = r.status;
    const retriable = r.status === 429 || r.status >= 500;
    if (!retriable || i === tries - 1) break;
    console.warn(`  ! AEMET HTTP ${r.status}; reintento ${i+1}/${tries-1} en ${waits[i]/1000}s`);
    await new Promise(res => setTimeout(res, waits[i]));
  }
  throw new Error('HTTP '+last+' '+sanitizeURLForLog(url));
}
async function getBinary(url){
  const r=await aemetGetRaw(url,'application/xml,text/xml,application/gzip,application/x-tar,*/*'); // datos v91.9: TLS<=1.2, como getAemetJSON
  if(!r.ok)throw new Error('HTTP '+r.status+' '+sanitizeURLForLog(url));
  return {buffer:r.buffer,contentType:r.contentType,contentEncoding:r.contentEncoding};
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
      errors.push(sanitizeErrorMessage(e.message));
    }
  }
  return {items:dedupeAemet(items),okSources,errors,warnings,methods,fallbackUsed,tableRows};
}
async function fetchAemetAlerts(previousAemet=null){
  const started=new Date().toISOString();
  const errors=[]; const warnings=[];
  const prev=previousAemet?sanitizeAemetRecord(previousAemet):null;
  if(prev&&shouldReuseAemet(prev)){
    const age=aemetAgeMinutes(prev);
    const reused=sanitizeAemetRecord(prev,{cached:true,cacheAgeMinutes:age});
    if(!reused.warnings.some(w=>/cache/i.test(w)))reused.warnings.push(`AEMET reutilizado desde caché interna (${age} min) para evitar rate-limit.`);
    return reused;
  }
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
      errors.push('OpenData: '+sanitizeErrorMessage(e.message+(e&&e.cause&&e.cause.message?' — causa: '+e.cause.message:''))); // datos v91.9: undici esconde el motivo real en e.cause
      warnings.push('Se usa fallback HTML porque AEMET OpenData ha fallado.');
    }
  }else{
    warnings.push('AEMET_API_KEY no configurada; se usa fallback HTML.');
  }
  const html=await fetchAemetHTMLAlerts();
  warnings.push(...html.warnings.map(sanitizeErrorMessage));
  if(html.okSources>0 && html.items.length===0 && html.tableRows===0){
    warnings.push('AEMET HTML leído pero sin avisos estructurados; no se considera una fuente fiable si OpenData falla.');
  }
  const prevGood=prev && prev.method==='opendata_cap' && Array.isArray(prev.items) ? prev : null;
  const items=(html.items&&html.items.length)?html.items.slice(0,30):(prevGood?prevGood.items.slice(0,50):[]);
  const result={
    source:'AEMET Meteoalerta',
    fetched_at:started,
    // Si OpenData falla, la salud es false aunque haya fallback o datos antiguos.
    ok:false,
    method:'html_fallback',
    items,
    checked_days:AEMET_DAYS.map(d=>d.label),
    checked_zones:Object.values(AEMET_ZONE_CODES).map(z=>z.zone),
    opendata:{enabled:hasKey,areas:AEMET_OPENDATA_AREAS},
    html:{ok_sources:html.okSources,methods:html.methods,fallback_used:html.fallbackUsed,table_rows:html.tableRows},
    html_fallback_used:true,
    errors:[...errors,...html.errors].map(sanitizeErrorMessage).slice(0,8),
    warnings:warnings.map(sanitizeErrorMessage).slice(0,12)
  };
  if(prevGood && !(html.items&&html.items.length)){
    result.stale_items_used=true;
    result.stale_from=prevGood.fetched_at||'';
    result.warnings.unshift('Se conservan los últimos avisos oficiales válidos porque AEMET OpenData ha fallado ahora.');
  }
  return sanitizeAemetRecord(result);
}

// ===== datos v91.12: ARCHIVO HISTÓRICO DE BANDERAS OFICIALES (verdad de campo para calibrar el baremo) =====
// Cada ejecución, DURANTE horario de socorrismo (10-21 Madrid) y solo en playas con bandera OFICIAL,
// añade una línea JSONL casando la bandera real con el tiempo de ESE momento (hora actual de la serie
// horaria, con la dirección CRUDA del viento). Fichero mensual para acotar tamaño y el peso en git.
// NO toca datos_playas.json. Fallo = no crítico (nunca tumba el build). Uso: analizar
// «(viento,racha,dir,oleaje,exp) -> bandera que pusieron» y sustituir umbrales inventados por umbrales
// medidos (empezando por el ajuste PROVISIONAL del viento flojo, web v91.106).
function madridParts(){
  const p=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',hour:'2-digit',hour12:false}).formatToParts(new Date());
  const g=t=>{const f=p.find(x=>x.type===t);return f?f.value:null;};
  return {year:g('year'),month:g('month'),hour:Number(g('hour'))};
}
function currentHourWeather(bd){
  const H=bd&&bd.hourly; if(!H||!Array.isArray(H.time)||!H.time.length) return {};
  const {hour}=madridParts();
  let best=-1,bestd=99;
  for(let i=0;i<H.time.length;i++){const t=H.time[i]; if(t>=24)break; const d=Math.abs((t%24)-hour); if(d<bestd){bestd=d;best=i;}}
  if(best<0)best=0; const i=best; const g=(a)=>a&&a[i]!=null?a[i]:null;
  return {windK:g(H.wind),gustK:g(H.gust),windDir:g(H.wdir),waveH:g(H.wave),waveDir:g(H.waveDir),temp:g(H.temp),code:g(H.code)};
}
async function appendFlagHistory(beaches,catalog){
  try{
    const {year,month,hour}=madridParts();
    if(hour<10||hour>=21){ console.log('· Histórico de banderas: fuera de 10-21, no se registra'); return; }
    /* datos v91.13b: ya NO se graba exp. Es un atributo MUTABLE (se corrigio en 15/40 el 15 jul) y no se denormaliza dentro de un log de solo-anadir: el registro lleva id, asi que exp se DERIVA al analizar uniendo con playas_catalogo.json. Asi este bug no puede repetirse. */
    const ts=new Date().toISOString(); const lines=[];
    for(const [id,bd] of Object.entries(beaches)){
      if(!bd||!bd.oflag) continue;                       // solo verdad de campo (bandera oficial)
      const w=currentHourWeather(bd);
      lines.push(JSON.stringify({ts,id:Number(id),oflag:bd.oflag,abierta:(bd.abierta==null?null:bd.abierta),windK:(w.windK==null?null:w.windK),gustK:(w.gustK==null?null:w.gustK),windDir:(w.windDir==null?null:w.windDir),waveH:(w.waveH==null?null:w.waveH),waveDir:(w.waveDir==null?null:w.waveDir),temp:(w.temp==null?null:w.temp),code:(w.code==null?null:w.code)}));
    }
    if(!lines.length){ console.log('· Histórico de banderas: sin banderas oficiales que registrar'); return; }
    const fname='banderas_historico_'+year+'-'+month+'.jsonl';
    await appendFile(new URL('./'+fname,import.meta.url), lines.join('\n')+'\n');
    console.log('· Histórico de banderas: +'+lines.length+' registros en '+fname);
  }catch(e){ console.log('· Histórico de banderas: fallo no crítico ('+String(e&&e.message||e).slice(0,90)+')'); }
}
// ===== fin archivo histórico de banderas =====
async function readPrevBeaches(){ try{ const prev=JSON.parse(await readFile(new URL('./datos_playas.json',import.meta.url),'utf8')); return prev&&prev.beaches?prev.beaches:{}; }catch(e){ return {}; } } // datos v91.14-B
async function main(){
  const catalog=JSON.parse(await readFile(new URL('./playas_catalogo.json',import.meta.url),'utf8'));
  if(!Array.isArray(catalog)||!catalog.length)throw new Error('playas_catalogo.json vacío');
  console.log('Generando datos para',catalog.length,'playas…');

  const prevBeaches=await readPrevBeaches(); // datos v91.14-B: para arrastrar el último agua conocido
  const beaches={},air={};
  await mapLimit(catalog,CONCURRENCY,async b=>{
    const [sc,aq]=await Promise.all([scenariosAt(b.lat,b.lng),airAt(b.lat,b.lng)]);
    {const _id=String(b.id);const _off=Object.assign(sc,__OFI__[_id]||{});for(const _src of __MUNI_OFI__){const _m=_src[_id];if(_m&&_m.oflag){_off.oflag=_m.oflag;_off.oflagSource=_m.oflagSource;_off.ofiAt=_m.ofiAt;break;}}beaches[b.id]=_off;} // v91.8: oflag/ocupación oficiales si están activos
    { const __bo=beaches[b.id]; // datos v91.14-B: arrastrar el último agua conocido si la Marine API falló
      if(__bo&&Array.isArray(__bo.days)&&__bo.days.some(x=>x&&x.agua==null)){
        const __pd=prevBeaches[b.id]&&Array.isArray(prevBeaches[b.id].days)?prevBeaches[b.id].days:null;
        const __last=__pd?((__pd.find(x=>x&&x.agua!=null)||{}).agua):null;
        __bo.days.forEach((day,di)=>{ if(day&&day.agua==null){ const pa=(__pd&&__pd[di]&&__pd[di].agua!=null)?__pd[di].agua:__last; if(pa!=null)day.agua=pa; } });
      } }
    air[b.id]=aq;
    process.stdout.write('.');
  });
  process.stdout.write('\n');

  await appendFlagHistory(beaches,catalog); // datos v91.12: registrar (bandera oficial, tiempo real) para calibrar

  console.log('Generando resumen provincial…');
  // Resumen de portada: agregación real de las playas de la costa.
  // La máxima/minima de "Hoy en la costa de Almería" sale de las playas, no de un punto fijo.
  const province=aggregateProvinceFromBeaches(beaches);

  console.log('Consultando avisos oficiales AEMET…');
  const previousAemet=await readPreviousAemet();
  const aemet_alerts=await fetchAemetAlerts(previousAemet).catch(e=>sanitizeAemetRecord({source:'AEMET Meteoalerta',fetched_at:new Date().toISOString(),ok:false,items:[],errors:[sanitizeErrorMessage(e.message)]}));

  const out={
    generated_at:new Date().toISOString(),
    source:'Open-Meteo (forecast + marine + air-quality) + AEMET Meteoalerta',
    province,
    aemet_alerts,
    official:__OFI_META__, // v91.9: atribución obligatoria + salud del servicio de la Junta
    beaches,
    air
  };
  await writeFile(new URL('./datos_playas.json',import.meta.url),JSON.stringify(out));
  const okBeaches=Object.keys(beaches).length;
  const okAir=Object.values(air).filter(a=>!a.error).length;
  console.log(`OK · ${okBeaches} playas con clima/mar · ${okAir} con calidad del aire · resumen costa ${province?'sí':'no'} · avisos AEMET ${aemet_alerts.items.length} · oficiales Junta ${__OFI_META__.count_flags} banderas (de ${__OFI_META__.requested})`);
}

main().catch(e=>{console.error('ERROR:',e);process.exit(1)});
