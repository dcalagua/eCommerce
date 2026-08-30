-- =============================================================================
-- P16-SaaS · 1/3 — El enlace del tenant deja de admitir la barra invertida
--
-- HALLAZGO (confirmado, no teorico). `ebim.is_safe_href` (P11-SaaS) aceptaba
-- como "ruta interna" cualquier cadena que empiece por `/` y no por `//`:
--
--     p_value like '/%' and p_value not like '//%'
--
-- El navegador NO piensa igual. En el analizador de URL de WHATWG, para los
-- esquemas especiales (`http`/`https`) la BARRA INVERTIDA es equivalente a la
-- barra normal. Medido:
--
--     new URL('/\evil.com', 'https://tienda.com').href  ->  https://evil.com/
--
-- Es decir: `/\evil.com` pasaba el CHECK como enlace interno y el navegador lo
-- resolvia a OTRO DOMINIO. Cualquiera que pueda escribir contenido del CMS
-- —`cta_href` de un bloque, o el `href` de un nodo de texto enriquecido— podia
-- dejar publicado en la vitrina de la tienda un boton que lleva al comprador a
-- un sitio de terceros con la marca del comercio todavia en la barra. Es un
-- redirector abierto ALMACENADO, y sirve exactamente para phishing.
--
-- No hace falta React Router para llegar: un `<a href="/\evil.com">` normal lo
-- hace igual, porque lo resuelve el navegador y no la aplicacion. Por eso la
-- correccion va en la BASE, que es donde esta la autoridad, y no solo en el
-- componente que pinta (que tambien se refuerza, `src/shared/lib/safeHref.ts`).
--
-- Lo que cambia, exactamente:
--   · Lista blanca de esquemas: IGUAL (https, ruta interna, mailto, tel).
--   · Se anade: ni una barra invertida en ninguna posicion.
--   · Se anade: ni un caracter de control (0x00-0x1F, 0x7F). `\t`, `\n` y `\r`
--     se ELIMINAN del medio de un esquema al analizar la URL, asi que
--     `java\tscript:alert(1)` es `javascript:alert(1)` para el navegador y no
--     lo era para la lista negra de refuerzo.
--   · Se anade: la ruta interna no puede empezar por `/\` (redundante con lo
--     anterior, escrito aparte para que se lea la intencion).
--
-- REMEDIACION de lo ya guardado. Redefinir la funcion NO revalida las filas
-- existentes: un CHECK solo se evalua al escribir. Sin la limpieza de abajo,
-- una fila envenenada seguiria publicandose y ademas se volveria imposible de
-- editar (el CHECK saltaria en el UPDATE). Se limpian las dos superficies.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. La funcion
-- ---------------------------------------------------------------------------
create or replace function ebim.is_safe_href(p_value text)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select coalesce(
    p_value is null
    or (
      char_length(p_value) between 1 and 2048
      and p_value !~ '[[:space:]]'
      -- La barra invertida es barra para el navegador. `/\evil.com` sale de
      -- este dominio. No hay ningun enlace legitimo que la necesite.
      and strpos(p_value, chr(92)) = 0
      -- Los caracteres de control se DESCARTAN al analizar la URL, asi que
      -- sirven para partir por la mitad un esquema prohibido.
      and p_value !~ '[[:cntrl:]]'
      and (
        p_value like 'https://%'
        or (p_value like '/%' and p_value not like '//%')
        or p_value like 'mailto:%'
        or p_value like 'tel:%'
      )
      -- Cinturon ademas del tirante: aunque el prefijo pasara, un esquema
      -- ejecutable en cualquier posicion descalifica el enlace.
      and lower(p_value) !~ 'javascript:|vbscript:|data:'
    ),
    false
  );
$fn$;

comment on function ebim.is_safe_href(text) is
  'Enlace admisible en contenido del tenant: https, ruta interna, mailto o tel. Lista blanca de esquema, sin barra invertida y sin caracteres de control: `/\evil.com` sale del dominio en el navegador (P16-SaaS).';

-- ---------------------------------------------------------------------------
-- 2. Remediacion: la llamada a la accion de un bloque
--
-- Se anula el PAR completo. `content_blocks_cta_pair` exige que etiqueta y
-- destino existan a la vez; dejar la etiqueta sola seria un boton que no lleva
-- a ninguna parte, y ademas no pasaria el CHECK.
-- ---------------------------------------------------------------------------
update public.content_blocks
   set cta_href = null,
       cta_label = null
 where cta_href is not null
   and not ebim.is_safe_href(cta_href);

-- ---------------------------------------------------------------------------
-- 3. Remediacion: el enlace dentro del texto enriquecido
--
-- Al nodo se le quitan `href` y `linkLabel` y se queda como texto. Quitar solo
-- `href` dejaria un `linkLabel` huerfano, que `ebim.rich_text_node_is_safe`
-- rechaza ("una etiqueta de enlace sin enlace es un texto que parece
-- pulsable"), y la fila quedaria imposible de guardar.
-- ---------------------------------------------------------------------------
update public.content_blocks
   set body = (
     select jsonb_agg(
              case
                when node.value ? 'href' and not ebim.is_safe_href(node.value ->> 'href')
                  then (node.value - 'href') - 'linkLabel'
                else node.value
              end
              order by node.ord
            )
       from jsonb_array_elements(public.content_blocks.body) with ordinality as node(value, ord)
   )
 where body is not null
   and jsonb_typeof(body) = 'array'
   and exists (
     select 1
     from jsonb_array_elements(body) as n(value)
     where n.value ? 'href'
       and not ebim.is_safe_href(n.value ->> 'href')
   );
