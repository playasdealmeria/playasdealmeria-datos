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

## Procedencia de las banderas / Flag provenance

Las banderas publicadas por administraciones se conservan con su procedencia. La fecha de una previsión meteorológica o de nuestra descarga no confirma una bandera. Sin una fecha propia utilizable, la web mantiene su estimación. Los partes anteriores y el fin del servicio no se presentan como confirmaciones actuales. Los sectores agrupados requieren una lectura completa; no se traslada la bandera de una playa vecina. La previsión y la comodidad estimada no garantizan seguridad: prevalecen la señalización y las instrucciones de los responsables de la playa.

Flags published by local authorities retain their provenance. A weather forecast date or our retrieval time does not confirm a flag. Without usable source timing, the website keeps its estimate. Older reports and ended lifeguard service are not presented as current confirmations. Grouped sectors require complete readings; a neighbouring beach does not fill a gap. Forecasts and estimated comfort do not guarantee safety: follow signs and instructions from beach staff.

El histórico existente no se reescribe. Los nuevos registros de bandera incluyen evidencia temporal y solo se añaden si el parte cumple la vigencia exigida. Los pilotos de nuevas fuentes permanecen fuera del feed público.
