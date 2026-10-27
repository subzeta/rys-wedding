# Raquel & Sergio

La invitación sigue siendo HTML/CSS/JavaScript estático, publicado en GitHub Pages.
El álbum «Recuerdos de nuestra boda» está en `/rys-wedding/salseo/`. El enlace anterior `/rys-wedding/galeria/` redirige al nuevo álbum. No cambia el formulario de asistencia.

Producción: `https://subzeta.github.io/rys-wedding/salseo/`.
API: `https://rys-gallery.subzeta.workers.dev`.
Los códigos y el secreto de sesión se conservan en `.env.gallery-production.local`,
un archivo privado ignorado por Git. Guarda una copia en tu gestor de contraseñas.

## Galería: cómo funciona

- Fotos y vídeos originales en un bucket **R2 Standard privado**.
- Copias JPEG de hasta 1600 píxeles y 500 KB para mostrar las fotos y portadas.
- Los vídeos se reproducen dentro del visor con controles nativos. Solo se solicita el original al pulsar reproducir; no hay reproducción automática. Las flechas recorren fotos y vídeos.
- Código compartido para invitados y otro código privado para los administradores.
- Ambos códigos ignoran mayúsculas/minúsculas y espacios al principio o al final.
- El código se intercambia por una sesión firmada de 12 horas, guardada solo en la pestaña.
- El Worker accede a R2 por un binding. No se requieren claves S3 ni Cloudflare Images.
- Hasta 100 MiB por foto y 1 GiB por vídeo, en bloques de 8 MiB, con dos reintentos automáticos por bloque. Los límites se validan en el servidor.
- Subidas en una ventana aparte, progreso visible y fotos recién subidas resaltadas en el mosaico.
- Los administradores pueden eliminar originales y portadas desde cada tarjeta, con confirmación. Los invitados no pueden borrar archivos.
- Todos los invitados pueden descargar originales, seleccionar varios recuerdos o descargar todo, sin ZIP. La descarga comienza al pulsar el botón, con archivos individuales consecutivos y su nombre y tipo originales. Cada original se obtiene por completo y se guarda mediante una URL local del navegador para evitar que un enlace externo abra la foto. No se abre el menú de compartir ni una lista de enlaces. El navegador puede pedir permiso para varias descargas; los archivos se guardan en Descargas. Los enlaces firmados duran cinco minutos y se generan al usarlos. En móviles con poca memoria, los vídeos muy grandes pueden requerir más recursos porque se prepara un archivo completo cada vez.

## Preparación local

Requiere Node 22. Al instalar Wrangler se instala también el entorno local de Workers/R2.

```sh
npm ci
cp gallery-worker/.dev.vars.example gallery-worker/.dev.vars
npm run gallery:dev
```

Pon códigos de prueba en `.dev.vars` (mínimo 6 caracteres para invitados, 16 para administrador, distintos entre sí) y un secreto de sesión aleatorio de al menos 32 caracteres. El archivo está ignorado por Git. Ninguna credencial debe estar en `salseo/config.js`.

En otra terminal:

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

Abre `http://127.0.0.1:8080/salseo/`. En local la galería usa automáticamente el Worker en `http://127.0.0.1:8787`. R2 se emula en disco; no sube archivos a Cloudflare.

## Conectar con Cloudflare y publicar

1. Habilita R2 en tu cuenta de Cloudflare si aún no lo está. Cloudflare puede pedir un método de pago.
2. Inicia sesión desde tu navegador, sin compartir tokens por chat:

   ```sh
   npx wrangler login
   ```

3. Crea el bucket privado (o cambia `bucket_name` en `gallery-worker/wrangler.jsonc` si ya tienes uno dedicado):

   ```sh
   npx wrangler r2 bucket create rys-wedding-gallery
   ```

   Mantén desactivados el acceso público `r2.dev` y los dominios públicos del bucket. No necesita CORS: todas las peticiones pasan por el Worker.

4. Guarda los tres secretos. Cada comando los pide de forma interactiva:

   ```sh
   npx wrangler secret put GUEST_CODE --config gallery-worker/wrangler.jsonc
   npx wrangler secret put ADMIN_CODE --config gallery-worker/wrangler.jsonc
   npx wrangler secret put SESSION_SECRET --config gallery-worker/wrangler.jsonc
   ```

   El código de invitados debe tener al menos 6 caracteres y el privado 16. Para `SESSION_SECRET`, genera y guarda una cadena aleatoria de al menos 32 caracteres (por ejemplo, desde tu gestor de contraseñas). No compartas el código privado en el QR. Cambiar `SESSION_SECRET` invalida todas las sesiones abiertas.

5. Revisa los dominios permitidos en `ALLOWED_ORIGINS`. Para producción puedes dejar solo `https://subzeta.github.io`. Los namespaces de los dos limitadores deben ser únicos en tu cuenta. El de login permite 30 intentos/minuto por IP; el de nuevas subidas, 20/minuto por sesión. Son límites locales por centro de datos, no un tope de gasto global.
6. Despliega:

   ```sh
   npm run gallery:deploy
   ```

7. Copia la URL HTTPS que devuelve Wrangler en `API_URL` de `salseo/config.js`. Es pública y **no es un token**. Si usas un dominio propio para el Worker, añádelo también al `connect-src` de la política CSP en `salseo/index.html`.
8. Publica los cambios de la web por el proceso habitual de GitHub Pages. La URL será `https://subzeta.github.io/rys-wedding/salseo/` y puedes convertirla en un QR desde el navegador.

No hace falta un token de Cloudflare Images ni usar la suscripción de Images para esta implementación. Si prefieres automatizar el despliegue en el futuro, configura un token limitado como secreto de CI; nunca en la web.

## Llevarse el álbum completo

Con Python 3.9 o posterior, sin dependencias externas:

```sh
python3 tools/export-gallery.py https://rys-gallery.subzeta.workers.dev recuerdos
```

Pide el código privado sin mostrarlo ni guardarlo. Descarga los originales por streaming, un directorio por archivo para conservar nombres repetidos, y guarda un catálogo con fecha, autor y nombre original. Si se interrumpe, vuelve a ejecutarlo: salta los archivos que ya tienen el tamaño esperado. No borra archivos en R2. Todos los invitados también pueden descargar originales, selecciones o el álbum completo desde la galería.

Cuando termine la boda, cambia `UPLOADS_ENABLED` a `"false"` y redespliega para cerrar las subidas. Comprueba la exportación antes de eliminar el bucket desde Cloudflare.

## Reparar portadas de vídeos

Si una subida se guardó sin portada, un administrador puede repararla con Python 3 y `ffmpeg` instalado:

```sh
python3 tools/repair-previews.py https://rys-gallery.subzeta.workers.dev
```

Solo procesa vídeos publicados sin portada, usa archivos temporales que elimina después y conserva intactos los originales. El servidor comprueba el permiso de administrador y el JPEG antes de publicar la portada.

## Límites conocidos

- La página debe permanecer abierta durante la subida. Los bloques ya recibidos se conservan para reintentar en esa pestaña; cerrar o recargar la página pierde esa cola y requiere seleccionar de nuevo los archivos. No se promete subida en segundo plano en iOS/Android.
- La portada se extrae en el navegador. Si el dispositivo no puede decodificar una foto HEIC/AVIF o un vídeo, aparece una tarjeta genérica; el original se conserva sin conversión. También se usa una tarjeta genérica si falla la subida de la portada.
- Las sesiones pendientes y portadas de subidas abandonadas pueden dejar objetos pequeños en R2. R2 aborta por defecto las subidas multipart incompletas a los siete días; se puede configurar una regla de ciclo de vida. No pongas una caducidad general a `originals/` o `previews/`: borraría recuerdos válidos.
- El control de tamaños y frecuencia reduce abusos, pero no impone una cuota global de almacenamiento. Puedes cerrar todas las subidas con `UPLOADS_ENABLED`.
- Las fotos ampliadas muestran la copia ligera. Las descargas conservan el original, también para invitados. La reproducción usa enlaces privados limitados a un vídeo, válidos hasta que caduque la sesión, y peticiones parciales de bytes para avanzar sin cargar todo el vídeo en memoria. El formato y códec originales deben ser compatibles con el navegador; si no lo son, se ofrece descargar el original. No se generan conversiones ni copias adicionales.
- Antes de publicar, probar fotos HEIC/JPEG y vídeos MOV/MP4 desde al menos un iPhone y un Android reales, incluida una conexión interrumpida.

## Verificación

```sh
npm test
npm run gallery:check
```

Las pruebas cubren autenticación, separación de permisos, subida multipart, tamaño/formato, publicación idempotente y enlaces de descarga limitados. El segundo comando empaqueta y valida el Worker sin desplegar ni crear recursos remotos.
