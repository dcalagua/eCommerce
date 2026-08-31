-- =============================================================================
-- P17 · Contenido enriquecido: marcas de texto, enlaces en linea, listas
-- numeradas, alineacion y separador.
--
-- El editor del backoffice paso a ser un editor de verdad (TipTap sobre
-- ProseMirror) y el vocabulario de cuatro nodos se le quedaba corto: no habia
-- forma de poner una palabra en negrita ni un enlace dentro de una frase.
--
-- Lo que NO cambia, y es lo que importa:
--
--  1. **Sigue sin ser HTML.** Una marca es un BOOLEANO (`bold: true`), no una
--     etiqueta. El renderizador elige un componente de React; no hay ninguna
--     cadena del tenant que alguien interprete. `dangerouslySetInnerHTML` sigue
--     sin aparecer en el repositorio y su test de arquitectura sigue vigente.
--  2. **Sigue siendo un vocabulario CERRADO.** Claves tasadas en el nodo y en
--     el tramo; una clave de mas invalida el nodo entero, no se ignora.
--  3. **Sigue siendo PLANO.** Cinco tipos de nodo y ni un arbol. Por eso no hay
--     tablas: una tabla es filas dentro de celdas dentro de filas, y ese
--     anidamiento es justo lo que este CHECK existe para no tener que auditar.
--
-- Compatibilidad: el texto de un nodo puede seguir siendo una CADENA. Todo lo
-- publicado antes de esta migracion sigue siendo valido y se pinta igual; no se
-- reescribe ni una fila. Lo nuevo es que ademas puede ser una lista de tramos.
--
-- Solo se sustituyen funciones (`create or replace`): los CHECK que las llaman
-- no se tocan, y como el cambio solo AMPLIA lo admitido, ninguna fila existente
-- deja de cumplirlos.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ebim.rich_text_span_is_safe — un tramo de texto con marcas.
--
-- Cinco claves ademas del texto y ni una mas. `href` pasa por el mismo guard
-- que el resto de enlaces del CMS: el sumidero es el mismo `<a>` del comprador.
-- ---------------------------------------------------------------------------
create or replace function ebim.rich_text_span_is_safe(p_span jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select coalesce(
    jsonb_typeof(p_span) = 'object'
    and not exists (
      select 1
      from jsonb_object_keys(p_span) as k(key)
      where k.key not in ('text', 'bold', 'italic', 'underline', 'strike', 'href')
    )
    and jsonb_typeof(p_span -> 'text') = 'string'
    and char_length(p_span ->> 'text') between 1 and 2000
    -- Nada que se parezca a una etiqueta, ni siquiera como texto: ese texto
    -- acaba en un correo o en un CSV exportado, y esos si interpretan.
    and (p_span ->> 'text') !~ '<[a-zA-Z/!]'
    and (not p_span ? 'bold'      or jsonb_typeof(p_span -> 'bold')      = 'boolean')
    and (not p_span ? 'italic'    or jsonb_typeof(p_span -> 'italic')    = 'boolean')
    and (not p_span ? 'underline' or jsonb_typeof(p_span -> 'underline') = 'boolean')
    and (not p_span ? 'strike'    or jsonb_typeof(p_span -> 'strike')    = 'boolean')
    and (not p_span ? 'href' or (
      jsonb_typeof(p_span -> 'href') = 'string'
      and char_length(p_span ->> 'href') >= 1
      and ebim.is_safe_href(p_span ->> 'href')
    )),
    false
  );
$fn$;

revoke execute on function ebim.rich_text_span_is_safe(jsonb) from public;
grant execute on function ebim.rich_text_span_is_safe(jsonb) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- ebim.rich_text_value_is_safe — el texto de un nodo o el de un elemento de
-- lista: una CADENA (el formato de siempre) o un array de tramos.
-- ---------------------------------------------------------------------------
create or replace function ebim.rich_text_value_is_safe(p_value jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select coalesce(
    case jsonb_typeof(p_value)
      when 'string' then
        char_length(p_value #>> '{}') between 1 and 2000
        and (p_value #>> '{}') !~ '<[a-zA-Z/!]'
      when 'array' then
        jsonb_array_length(p_value) between 1 and 50
        and not exists (
          select 1
          from jsonb_array_elements(p_value) as s(value)
          where not ebim.rich_text_span_is_safe(s.value)
        )
      else false
    end,
    false
  );
$fn$;

revoke execute on function ebim.rich_text_value_is_safe(jsonb) from public;
grant execute on function ebim.rich_text_value_is_safe(jsonb) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- ebim.rich_text_node_is_safe — ahora con cinco tipos y ocho claves posibles.
--
-- Ojo con el `coalesce` final: un CHECK que recibe NULL PASA. Sin envolver el
-- resultado, un documento con una forma que la expresion no sabe evaluar seria
-- exactamente el que se cuela.
-- ---------------------------------------------------------------------------
create or replace function ebim.rich_text_node_is_safe(p_node jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select coalesce(
    jsonb_typeof(p_node) = 'object'
    and jsonb_typeof(p_node -> 'type') = 'string'
    and (p_node ->> 'type') in ('paragraph', 'heading', 'list', 'quote', 'divider')
    -- Vocabulario cerrado de claves. Una clave desconocida no se ignora: rompe.
    and not exists (
      select 1
      from jsonb_object_keys(p_node) as k(key)
      where k.key not in ('type', 'text', 'level', 'items', 'href', 'linkLabel', 'align', 'ordered')
    )
    and case (p_node ->> 'type')
      -- El separador no dice nada, asi que no puede llevar nada dentro.
      when 'divider' then
        not p_node ? 'text' and not p_node ? 'items' and not p_node ? 'level'
        and not p_node ? 'href' and not p_node ? 'linkLabel'
        and not p_node ? 'align' and not p_node ? 'ordered'
      when 'list' then
        jsonb_typeof(p_node -> 'items') = 'array'
        and jsonb_array_length(p_node -> 'items') between 1 and 20
        and not exists (
          select 1
          from jsonb_array_elements(p_node -> 'items') as it(value)
          where not ebim.rich_text_value_is_safe(it.value)
        )
        and not p_node ? 'text'
        and (not p_node ? 'ordered' or jsonb_typeof(p_node -> 'ordered') = 'boolean')
        -- La alineacion de una lista no existe: alinear vinetas a la derecha
        -- deja la sangria en el aire.
        and not p_node ? 'align'
      else
        ebim.rich_text_value_is_safe(p_node -> 'text')
        and not p_node ? 'items'
        and not p_node ? 'ordered'
    end
    -- El titular solo tiene dos niveles: el `h1` de la pagina es el titulo, y
    -- dejar que un bloque escriba otro rompe el arbol de encabezados (WCAG).
    and ((p_node ->> 'type') <> 'heading' or (p_node ->> 'level') in ('2', '3'))
    and ((p_node ->> 'type') = 'heading' or not p_node ? 'level')
    and (not p_node ? 'align' or (p_node ->> 'align') in ('left', 'center', 'right'))
    and (not p_node ? 'href' or (
      jsonb_typeof(p_node -> 'href') = 'string'
      and ebim.is_safe_href(p_node ->> 'href')
    ))
    and (not p_node ? 'linkLabel' or (
      jsonb_typeof(p_node -> 'linkLabel') = 'string'
      and char_length(p_node ->> 'linkLabel') between 1 and 120
      and (p_node ->> 'linkLabel') !~ '<[a-zA-Z/!]'
    ))
    -- Una etiqueta de enlace sin enlace es un texto que parece pulsable.
    and (not p_node ? 'linkLabel' or p_node ? 'href'),
    false
  );
$fn$;

comment on function ebim.rich_text_node_is_safe(jsonb) is
  'Nodo admisible: paragraph/heading/list/quote/divider, claves tasadas, texto en cadena o en tramos con marcas cerradas. No es HTML.';

comment on function ebim.rich_text_is_safe(jsonb) is
  'Documento enriquecido admisible: array plano de nodos con vocabulario cerrado de claves y marcas. No es HTML: no hay etiqueta que escapar.';
