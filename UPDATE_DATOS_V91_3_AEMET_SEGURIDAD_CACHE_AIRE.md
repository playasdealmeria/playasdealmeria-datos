# v91.3 datos · AEMET seguro, cacheado y honesto

Este parche es para el repo `playasdealmeria-datos`.

## Corrige

- `getJSON()` ya no lanza errores con la URL completa sin sanitizar. Si hay `api_key=...`, se publica como `api_key=[redacted]`.
- Todos los errores de AEMET pasan por `sanitizeErrorMessage()`, incluyendo tokens JWT.
- Si AEMET OpenData falla, `aemet_alerts.ok` queda en `false`. Ya no se interpreta como “no hay avisos”.
- AEMET se reutiliza desde el `datos_playas.json` anterior durante `AEMET_CACHE_HOURS` horas, por defecto 3, para evitar HTTP 429. El tiempo, viento y mar pueden seguir regenerándose en cada workflow.
- Si OpenData falla y existe un último resultado oficial válido, se conservan esos avisos como `stale_items_used: true`, marcando `ok:false`.
- Se mantiene el bloque `air` de calidad del aire por playa.

## Seguridad

Aunque este parche evita nuevas filtraciones, la clave anterior debe darse por comprometida si ya apareció en el JSON público o en el historial. Hay que regenerarla en AEMET y cambiar el secret `AEMET_API_KEY` en GitHub.

## Aplicación

1. Copia el contenido de esta carpeta en `playasdealmeria-datos`.
2. Sustituye `build-data.mjs` y `.github/workflows/update-data.yml`.
3. Ejecuta `node --check build-data.mjs`.
4. Commit y push.
5. Cambia la clave en GitHub Secrets.
6. Espera un rato si AEMET devolvió 429 y ejecuta una sola vez la Action.

Este parche no toca Netlify y no consume créditos de Netlify.
