# v91.1 · Workflow AEMET OpenData también en reintento

Este parche corrige un detalle del workflow del repo `playasdealmeria-datos`.

## Problema

En v91, la primera ejecución de `node build-data.mjs` recibía `AEMET_API_KEY`, pero si el `git push` era rechazado porque el remoto había avanzado, el workflow hacía un segundo `node build-data.mjs` dentro del bloque de reintento. Ese segundo intento podía no recibir la clave y caer a `html_fallback`.

## Corrección

La variable queda a nivel de job:

```yaml
jobs:
  update-data:
    env:
      AEMET_API_KEY: ${{ secrets.AEMET_API_KEY }}
      AEMET_OPENDATA_AREA: esp
```

Así cualquier llamada a `node build-data.mjs`, incluida la del reintento, usa AEMET OpenData.

## Cómo aplicar

1. Copiar el contenido de `v91_1_data_workflow_retry_patch/` dentro del repo `playasdealmeria-datos`.
2. Sustituir `.github/workflows/update-data.yml`.
3. Commit y push.
4. Ejecutar manualmente la Action `Actualizar datos meteorológicos`.
5. Comprobar en `datos_playas.json`:

```json
"method": "opendata_cap",
"html_fallback_used": false,
"errors": []
```

Este cambio no afecta a Netlify y no consume créditos de Netlify.
