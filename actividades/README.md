# Recolector de actividades — datos v91.390

Módulo independiente para 49 playas, sin conexión al feed público ni a workflows. Los archivos de captura se guardan fuera de repositorios Git y espejos. No usar el repositorio público de datos como almacén. La herramienta no activa ninguna programación, no crea cuentas y no utiliza secretos.

Almacenamiento inicial elegido: PC del propietario. Las nuevas capturas comprimen también el sobre `capture.json.gz` con gzip nivel 9, sin pérdida y sin instalar dependencias. Siguen leyéndose y restaurándose sobres antiguos `capture.json`, sin reescribirlos. En una muestra real, el total pasa de 2,40 MB a 0,34 MB (~86 % menos); a cuatro capturas diarias serían unos 41 MB por 30 días. Es una extrapolación de una captura, no un tamaño máximo. Los límites de espacio se mantienen. Un PC apagado no recoge datos; publicar el código no activa un horario. Una copia en el mismo disco ayuda frente a errores de archivos, pero no frente a avería del disco.

## Captura y recuperación

`node actividades/cli.mjs plan` muestra 15 consultas agrupadas: 49 referencias meteorológicas y 98 puntos marinos (cercano/contexto). Tres días anteriores y tres días de previsión, con UTC y sin redondear los originales. Los días anteriores son salida del modelo, no observaciones. Los originales son los bytes del cuerpo HTTP entregados por fetch (tras su descompresión de transporte), comprimidos sin modificar para almacenamiento; se conservan hash y recibos.

`node actividades/cli.mjs capture CARPETA_PRIVADA 20260926T12` ejecuta una captura manual. Repetir exactamente ciclo y contrato verifica y devuelve el archivo sin red. Un ciclo parcialmente escrito queda `.pending`: se conserva y requiere revisión, no se vuelve a consultar automáticamente. Un bloqueo existente tampoco se elimina automáticamente.

`node actividades/cli.mjs plan 2026-09-24` muestra 309 consultas si se incluye óptica. `capture CARPETA_PRIVADA 20260926T12-optical 2026-09-24` solicita además TUR, SPM y CHL de una fecha explícita para los 98 puntos. Es una opción experimental, no una búsqueda automática de la última imagen. Dataset fijado: verificar vigencia antes de activar. No trae máscaras de calidad ni vecindario y no estima visibilidad. No forma parte de la captura física por defecto. Queda pendiente sustituir las consultas puntuales repetidas por ingestión óptica diaria deduplicada, una vez resueltas calidad y publicación de nuevos productos.

`node actividades/cli.mjs verify CARPETA_DE_CAPTURA` comprueba inventario y hashes. `node actividades/cli.mjs restore ORIGEN DESTINO` verifica todas las capturas fuente antes de copiar; conserva destinos existentes idénticos y aborta ante conflicto. No borra historia. Si la escritura falla, queda una carpeta pendiente recuperable. Fuente y destino deben permanecer sin cambios de terceros durante la restauración. La copia no configura copias remotas ni garantiza conservación fuera del ordenador: esa integración es una tanda posterior.

## Límites y semántica

Máximo 309 peticiones por captura, secuenciales, separadas 400 ms, sin reintentos; timeout 45 s; 8 MiB por respuesta, 32 MiB de cuerpos por ciclo, reserva de 64 MiB de almacenamiento por ciclo y tope total 256 MiB por archivo. HTTP 403 o 429 detiene las peticiones restantes al mismo host y las registra como no realizadas. Se detiene antes de iniciar si falta reserva. No hay purga automática. Revisar consumo antes de ampliar límites o activar cuatro ventanas al día. Una petición agrupada no equivale necesariamente a una unidad de cuota del proveedor; verificar licencia y plan para el uso operativo concreto.

Se guardan nulos y respuestas HTTP fallidas. El estado `received` significa respuesta interpretable, no que todas sus variables sean útiles; consultar el estado por variable. Se distinguen campo ausente, forma incorrecta, unidad inesperada, dato no numérico, huecos parciales y número recibido pendiente de validación. La copia normalizada convierte exclusivamente km/h a m/s y conserva nulos; el original permanece completo.

Open-Meteo Best Match no identifica una celda nativa por cada variable ni la emisión exacta de cada modelo. Esos campos quedan nulos. La coordenada devuelta es de la respuesta y no se atribuye a todas las variables. Calcular antelación desde recepción, distinguir horas anteriores, y no etiquetarla como plazo desde emisión. Corrientes son contexto regional: no permiten asegurar ausencia de corrientes de retorno. No sumar Stokes sin comprobar si el producto ya la incorpora.

Los puntos de muestreo proceden de cartografía histórica; no son sectores de práctica verificados. No trasladar sin más el contexto de 750 m a la orilla. El recolector no modifica abrigo, orientación, baremo, seguridad, fotos, reportes comunitarios ni fichas. Datos estáticos adicionales, observaciones de visibilidad reales y adaptación costera siguen pendientes.

Fuentes: [Open-Meteo meteorología](https://open-meteo.com/en/docs), [Marine](https://open-meteo.com/en/docs/marine-weather-api), [Copernicus WMTS](https://help.marine.copernicus.eu/en/articles/6478168-how-to-use-the-copernicus-marine-web-map-tile-service-wmts). Conservar atribuciones y revisar términos de acceso antes de operación; esta herramienta no concede nuevas licencias.

## Pruebas

`node --test test/actividades-v390.test.mjs` usa datos sintéticos, sin red, en carpetas temporales. La validación de una captura real comprueba funcionamiento e integridad, no precisión científica. No hay dependencia externa nueva. Este parche añade archivos, pero no programa ni publica nada.
