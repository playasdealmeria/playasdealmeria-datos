# UPDATE datos v90 · AEMET sin RSS 404

Corrección acumulada sobre v89 para el repo `playasdealmeria-datos`.

## Motivo

La v89 intentaba consultar URL directas tipo `/es/rss/avisos/...`, pero esas rutas devuelven HTTP 404 en AEMET. El JSON quedaba con `aemet_alerts.ok=false`, `items=[]` y errores RSS aunque la web siguiera funcionando.

## Cambio

- Se eliminan las URL RSS directas que daban 404.
- Se consultan las páginas oficiales de avisos de AEMET por Andalucía y por zonas costeras.
- Se consulta `hoy`, `mañana` y `pasado mañana`.
- Se conserva el filtrado por `day`, `zone` y `web_zones` para que la web muestre cada aviso solo donde toca.
- `aemet_alerts.ok` ahora indica que al menos una fuente oficial se ha podido leer, aunque no haya avisos activos.

## Zonas consultadas

- Andalucía general: `k=and&w=hoy/mna/pmna`.
- Poniente y Almería Capital: `l=610403&w=hoy/mna/pmna`.
- Levante almeriense: `l=610404&w=hoy/mna/pmna`.

## Prueba

Ejecutar:

```bash
node --check build-data.mjs
node build-data.mjs
```

Después buscar en `datos_playas.json`:

```text
aemet_alerts
```

Si AEMET tiene avisos activos para hoy, mañana o pasado mañana, aparecerán en `aemet_alerts.items`. Si no hay avisos, `items` puede estar vacío, pero `ok` debería ser `true` siempre que AEMET responda.
