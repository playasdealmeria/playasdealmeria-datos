# Datos meteorológicos de Playas de Almería

Este repositorio público genera y publica `datos_playas.json`.

La web principal sigue alojada en Netlify, pero lee este JSON externo para que las actualizaciones meteorológicas no obliguen a desplegar de nuevo la web.

## Archivos principales

- `playas_catalogo.json`: catálogo fuente de playas y coordenadas.
- `build-data.mjs`: genera `datos_playas.json` consultando las fuentes meteorológicas.
- `.github/workflows/update-data.yml`: actualiza y valida el feed cada 30 minutos.
- `datos_playas.json`: archivo generado que consume la web.
- `validar-rachas.mjs`: registra previsiones y observaciones de viento sin tocar el feed público.
- `analizar-rachas.mjs`: compara únicamente pares exactos del esquema científico v2.
- `VALIDACION_CIENTIFICA_VIENTO.md`: contrato de datos, límites y fuentes alternativas.

## URL que lee la web

```text
https://raw.githubusercontent.com/playasdealmeria/playasdealmeria-datos/main/datos_playas.json
```

Si cambia el nombre del repositorio o del usuario u organización, también debe actualizarse `EXTERNAL_DATA_URL` en `app.js` del repositorio web.

## Validaciones locales

```text
node --check build-data.mjs
node --check validar-rachas.mjs
node --check analizar-rachas.mjs
node --test
node analizar-rachas.mjs
```

El proyecto no necesita instalar paquetes para estas comprobaciones.

No se deben editar a mano `datos_playas.json` ni los archivos JSONL de validación. Los genera el workflow y el análisis nunca debe mezclar el formato legacy con el esquema v2.
