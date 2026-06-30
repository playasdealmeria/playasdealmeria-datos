# v91.2 · AEMET OpenData: seguridad y fallo no silencioso

Parche para el repo `playasdealmeria-datos`.

## Qué corrige

- Sanitiza errores y URLs para que `AEMET_API_KEY` no pueda aparecer en `datos_playas.json`.
- Si OpenData devuelve HTTP 429 u otro error, el JSON ya no debe publicar la URL con la clave.
- Si OpenData falla y el HTML solo se ha podido leer pero no se ha parseado de forma estructurada, `aemet_alerts.ok` queda en `false` para evitar un falso “sin avisos”.
- Mantiene el fallback HTML como diagnóstico, pero no lo considera fiable si no hay filas o avisos estructurados.

## Pasos recomendados

1. Regenerar o sustituir la API key de AEMET, porque una clave anterior apareció en un JSON público.
2. Actualizar el secret `AEMET_API_KEY` en GitHub Actions.
3. Copiar este `build-data.mjs` al repo `playasdealmeria-datos`.
4. Ejecutar `node --check build-data.mjs`.
5. Commit y push.
6. Esperar un rato si AEMET ha devuelto HTTP 429 antes de relanzar la Action.

No toca Netlify y no requiere despliegue de la web principal.
