# v91 · AEMET OpenData con fallback HTML

Cambios:

- `build-data.mjs` intenta usar primero la API oficial AEMET OpenData si existe el secreto `AEMET_API_KEY`.
- Endpoint usado por defecto: `avisos_cap/ultimoelaborado/area/esp`, filtrando después solo las zonas costeras de Almería:
  - `610403` · Poniente y Almería Capital
  - `610404` · Levante almeriense
- Parseo del formato CAP/XML estructurado.
- Si no hay clave o falla OpenData, se mantiene el fallback HTML de v90.
- Se añaden diagnósticos en `aemet_alerts`:
  - `method`
  - `opendata`
  - `html_fallback_used`
  - `warnings`
  - `errors`

Para activar OpenData:

1. Solicitar API Key en el portal oficial de AEMET OpenData.
2. GitHub → repo `playasdealmeria-datos` → Settings → Secrets and variables → Actions.
3. Crear secret: `AEMET_API_KEY`.
4. Ejecutar manualmente el workflow `Actualizar datos meteorológicos`.
5. Comprobar que `datos_playas.json` incluye `aemet_alerts.method: "opendata_cap"`.

Si no configuras la clave, seguirá funcionando con `method: "html_fallback"`.
