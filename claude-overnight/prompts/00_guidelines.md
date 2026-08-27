OBJETIVO: preparar el repo vacio para el SaaS Ecommerce multitenant de EBIM.

FUENTE OBLIGATORIA DE LINEAMIENTOS:
H:\.shortcut-targets-by-id\18EpkGLYe5uFBNbzY0CkamAMxv9ycP9g4\EBIM-Plataforma

La carpeta anterior fue agregada a tu contexto con --add-dir. Sus lineamientos tienen prioridad sobre cualquier supuesto de este prompt.

Haz solo esto:
1. Inspecciona la carpeta de lineamientos y localiza documentos relevantes a arquitectura, frontend, UI/UX, seguridad, Supabase, Git, testing y convenciones.
2. Lee solo lo necesario; no copies documentos completos al contexto ni al repo.
3. Si hay archivos binarios o muy grandes, extrae solo reglas relevantes usando las herramientas disponibles.
4. Si la carpeta no es accesible o no puedes leer al menos una fuente relevante, DETENTE y registra el bloqueo. NO marques VERIFIED.
5. Crea CLAUDE.md <= 140 lineas con las reglas efectivas para este repo.
6. Crea docs/EBIM_GUIDELINES_TRACE.md <= 100 lineas con: rutas exactas de fuentes leidas + reglas clave derivadas. No copies contenido extenso.
7. Crea docs/STATE.md <= 120 lineas con:
   GUIDELINES_STATUS: VERIFIED
   fase actual
   decisiones
   pendientes
   checklist P00-P08
8. Crea docs/architecture.md breve con la arquitectura inicial compatible con los lineamientos.

Restricciones conocidas, solo si no contradicen Drive:
- SaaS multitenant.
- React + TypeScript.
- MUI.
- Supabase Postgres/Auth/Edge Functions/Storage.
- Storage Supabase para imagenes.
- RLS para aislamiento tenant.
- service_role nunca en frontend.
- tenant_id nunca hardcodeado.
- storefront publico separado logicamente del backoffice.

Git:
- Si el repo no esta inicializado, inicializalo siguiendo la convencion encontrada en Drive.
- No push, no PR, no deploy remoto.
- No tocar archivos fuera del repo salvo lectura de lineamientos.
- Commit solo si aplica: chore: initialize ebim ecommerce standards

Minimiza tokens: no expliques teoria ni repitas archivos. Salida final <= 12 lineas.
