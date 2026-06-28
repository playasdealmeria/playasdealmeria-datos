# Datos meteorológicos de Playas de Almería

Este repositorio público sirve únicamente para publicar `datos_playas.json`.

La web principal sigue alojada en Netlify, pero lee este JSON externo para que las actualizaciones meteorológicas no obliguen a hacer un deploy de producción en Netlify.

## Archivos

- `playas_catalogo.json`: catálogo de playas usado para consultar coordenadas.
- `build-data.mjs`: genera `datos_playas.json` con Open-Meteo.
- `.github/workflows/update-data.yml`: actualiza `datos_playas.json` cada hora.
- `datos_playas.json`: datos generados que lee la web.

## URL que lee la web

```text
https://raw.githubusercontent.com/playasdealmeria/playasdealmeria-datos/main/datos_playas.json
```

Si cambias el nombre del repositorio o del usuario/organización, actualiza `EXTERNAL_DATA_URL` en `app.js` de la web principal.
