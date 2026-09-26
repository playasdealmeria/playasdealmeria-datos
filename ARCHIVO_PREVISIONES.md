# Archivo prospectivo de respuestas de viento

Datos v91.389. Complementa `viento_validacion_v2_YYYY-MM.jsonl`; no lo sustituye, no reescribe historia ni cambia el feed o el baremo.

Se guarda la respuesta JSON completa ya obtenida por la consulta de validación a Open-Meteo, antes de redondear o seleccionar horizontes. Son los seis puntos de referencia de estaciones y sus horas solicitadas, no las 49 playas ni mediciones de orilla. No añade peticiones, estaciones, variables ni frecuencia. Se conserva el JSON interpretado, no los bytes HTTP originales ni sus cabeceras. La captura no implica que todos los valores sean válidos: unidades, nulos y huecos permanecen en el payload.

Cada sobre conserva consulta, coordenadas solicitadas, estaciones, respuesta con celdas y unidades, comienzo de petición y recepción. `model_run_utc` sigue nulo: recepción no equivale a emisión del modelo. Es best_match, no un modelo o pasada identificados. `hourly.time` pertenece a GMT según la consulta. Al evaluar, calcular antelación desde la recepción y la hora válida UTC; separar horas anteriores a la recepción, no tratarlas como pronósticos prospectivos. La serie v2 nueva usa también recepción para su antelación; la anterior conserva su semántica original.

## Conservación

Ruta: `archivo_previsiones_v1/AAAA-MM/SHA256.json.gz`. SHA256 identifica el sobre sin comprimir; gzip reduce espacio sin perder números o nulos. Una misma captura se conserva una vez; respuestas recibidas en momentos diferentes son capturas diferentes aunque sus valores coincidan. Cada fichero se publica completo y sin sobrescribir uno existente. La copia de recuperación valida todas las entradas antes de escribir. No hay purga automática ni un simple artefacto que caduque: el workflow incorpora los ficheros al repositorio de datos junto a su actualización ordinaria.

Límite inicial de 50 MiB comprimidos por mes y 8 MiB sin comprimir por captura. Al superarlo se detiene ese guardado con advertencia y estado de fallo del recolector; no borra historia y conserva la escritura v2. El paso científico sigue siendo no crítico para el feed. Debe revisarse el crecimiento antes de subir límites o elegir almacenamiento externo. La escritura/copia presupone un único escritor (el grupo de concurrencia del workflow); no coordina procesos ajenos simultáneos.

Antes de un posible rechazo del push, el workflow hace copia verificada en RUNNER_TEMP. Después del reset al remoto recupera esas capturas, añade las nuevas de la regeneración y las incorpora al siguiente intento. La recuperación es unión por huella: no sustituye el archivo remoto. Si falla la verificación, se aborta el reintento. No recupera capturas nunca descargadas, guardados interrumpidos antes de completar ni ejecuciones canceladas antes de publicar. Tampoco arregla retrospectivamente las pérdidas de v2 o del historial de banderas en reintentos antiguos.

El nuevo archivo es público al publicarse el repositorio. Solo contiene consultas meteorológicas públicas y metadatos de estaciones oficiales, sin claves AEMET ni observaciones de usuarios. No cambia accesos, permisos o secretos.

## Comprobación y recuperación local

`node --test test/archivo-previsiones-v389.test.mjs` verifica integridad y recorrido de recuperación en directorios temporales, sin red. `node archivo-previsiones.mjs copy ORIGEN DESTINO` verifica y une archivos sin borrar ni sobrescribir; no es una orden para ejecutar sobre producción sin la autorización correspondiente.

El piloto privado WeatherNext/HARMONIE utiliza otro repositorio y estado. Sus artefactos renovables de tres días y su límite de tamaño requieren una conservación separada; este parche no los convierte en archivo duradero ni amplía sus permisos. No confundir esta mejora con una validación de precisión o de visibilidad para snorkel.
