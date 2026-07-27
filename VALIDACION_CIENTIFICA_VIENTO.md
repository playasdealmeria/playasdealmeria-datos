# Validación científica de viento

Este repositorio registra datos para evaluar las previsiones, pero **no recalibra automáticamente** el baremo de Playas de Almería.

## Archivo vigente

`viento_validacion_v2_YYYY-MM.jsonl` usa el esquema 2 y mantiene dos clases de registro independientes:

- `forecast`: snapshot de Open-Meteo `best_match`, que es la selección que consume actualmente la web.
- `observation`: observación reciente de una estación oficial AEMET.

Cada registro conserva estación, sector costero, hora de captura, hora válida UTC, unidades y semántica de la fuente. La unión se hace después por `station.id + valid_time_utc`, nunca por “último dato disponible”.

Los antiguos `rachas_validacion_YYYY-MM.jsonl` se conservan como material histórico, pero el analizador v2 no los mezcla porque contienen duplicados y emparejamientos con desfases horarios.

## Comandos

```text
node --check validar-rachas.mjs
node --check analizar-rachas.mjs
node --test
node validar-rachas.mjs
node analizar-rachas.mjs
node analizar-rachas.mjs --json
```

No se añade ninguna dependencia: todo usa módulos incluidos en Node.

## Criterios antes de tocar el baremo

Las métricas se publican por estación y horizonte. Los indicadores de cobertura (`días`, `pares` y eventos observados de racha ≥40 km/h) son advertencias de tamaño muestral, no una declaración automática de fiabilidad.

Antes de proponer una corrección deben cumplirse, como mínimo:

1. horas UTC exactamente alineadas;
2. muestras de varios episodios y estaciones, no repeticiones del mismo episodio;
3. separación por horizonte de previsión;
4. análisis de error en viento y racha;
5. validación fuera de muestra;
6. revisión humana de valores extremos y metadatos de estación.

## Fuentes alternativas en evaluación

- **AEMET HARMONIE-AROME**: modelo oficial de 2,5 km, con viento y racha máxima, 48 horas. Es candidato a piloto meteorológico, no sustituto automático: la descarga pública entrega la última pasada y la dirección publicada está remuestreada a una malla más gruesa.
- **IFAPA RIA**: red oficial abierta con estaciones de Adra, Almería, La Mojonera, Níjar y Cuevas de Almanzora. Puede ampliar la cobertura observacional, pero debe verificarse altura del anemómetro, intervalo de promedio y disponibilidad horaria antes de mezclarla con AEMET.
- **Puertos del Estado**: fuente prioritaria para oleaje observado y modelos costeros SWAN/SAPO. El portal simplificado de Almería no es integrable tal cual: el 27-07-2026 mostraba como último ciclo el 30-11-2022. Debe usarse Portus/Portuscopia o un servicio oficial vigente y documentado.
- **Copernicus Marine IBI**: previsión de oleaje horaria a 1/36° con pasadas conservadas, control de calidad y altura, periodo y dirección. Es una buena referencia regional y de backtesting, pero sigue sin resolver por sí sola la transformación hasta la orilla.
- **Open-Meteo Single Runs**: archivo de pasadas individuales. Permite backtesting sin look-ahead desde abril de 2026 para la mayoría de modelos y desde marzo de 2024 para ECMWF IFS. Se evaluará como piloto separado para no confundir un modelo identificado con el `best_match` que ve el usuario.

La sustitución de una fuente solo se planteará después de una comparación paralela y reproducible contra observaciones.
