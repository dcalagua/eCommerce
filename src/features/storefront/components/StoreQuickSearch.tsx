import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import {
  Box,
  CircularProgress,
  ClickAwayListener,
  InputBase,
  Paper,
  Popper,
  Stack,
  Typography,
} from '@mui/material'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { SearchQuery } from '@/domain'
import { useI18n } from '@/shared/i18n/i18n-context'
import { formatMoney } from '@/shared/lib/format'
import { useDebouncedValue } from '@/shared/lib/useDebouncedValue'
import { R, T } from '@/theme/tokens'
import { useCatalogSearch, useSignedThumbnails } from '../hooks'

/** Id de la lista. Fijo: lo referencian `aria-controls` y cada opción. */
const LIST_ID = 'store-quick-search-list'

/** Cuántos productos caben en la lista sin que deje de ser un atajo. */
const LIMIT = 6

/**
 * Buscador de la cabecera de la tienda.
 *
 * **Usa `search`, no `suggest`, y eso es una decisión con coste.** `suggest`
 * está hecho para el autocompletado y devuelve solo texto —ni foto ni precio—,
 * porque se dispara con cada tecla. Aquí hace falta la foto: un nombre de
 * producto a solas obliga a abrir la ficha para saber si es el que se busca, y
 * en un catálogo con «Silla de roble natural / gris / negro» eso son tres
 * viajes. Se paga con una consulta más cara por búsqueda y se compensa con
 * `LIMIT` bajo, rebote de 250 ms y un mínimo de dos caracteres: con una letra
 * la consulta no acota nada y cuesta lo mismo que traer el catálogo entero.
 *
 * `role="search"` convierte la caja en un LANDMARK: un lector de pantalla la
 * lista junto a la cabecera y el pie, y se llega a ella sin recorrer la
 * portada. Antes ese landmark estaba en el cuerpo de la portada, a diez saltos
 * del principio; aquí está en el primer sitio donde se busca.
 *
 * Enter no elige el primer resultado: lleva al catálogo filtrado por lo
 * tecleado. Quien escribe y pulsa Enter quiere VER lo que hay, no que se
 * decida por él.
 */
export function StoreQuickSearch({ storeSlug }: { storeSlug: string }) {
  const { t, locale } = useI18n()
  const navigate = useNavigate()
  const [term, setTerm] = useState('')
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)

  const debounced = useDebouncedValue(term, 250)
  const clean = debounced.trim()

  const query: SearchQuery = useMemo(
    () => ({
      term: clean,
      filters: { category: null, brands: [], availability: 'all' },
      sort: 'relevance',
      limit: LIMIT,
      offset: 0,
    }),
    [clean],
  )

  const results = useCatalogSearch(storeSlug, query, clean.length >= 2)
  const hits = clean.length >= 2 ? (results.data?.items ?? []) : []
  const thumbnails = useSignedThumbnails(hits.map((hit) => hit.imagePath ?? null))

  // Cursor del teclado. Vuelve arriba al cambiar la consulta: dejarlo donde
  // estaba seleccionaria un producto distinto del que se esta mirando.
  const [cursor, setCursor] = useState(-1)
  useEffect(() => setCursor(-1), [clean])

  function goToCatalog() {
    // Se usa lo que hay ESCRITO, no el término rebotado. El rebote existe para
    // no consultar en cada tecla; aplicarlo también aquí hacía que teclear
    // rápido y pulsar Enter antes de 250 ms no hiciera absolutamente nada —y
    // quien escribe deprisa es justo quien ya sabe lo que busca—.
    const typed = term.trim()
    if (typed === '') return
    setOpen(false)
    navigate(`/s/${storeSlug}?q=${encodeURIComponent(typed)}`)
  }

  function goToProduct(slug: string) {
    setOpen(false)
    navigate(`/s/${storeSlug}/product/${slug}`)
  }

  const showPanel = open && clean.length >= 2

  return (
    <ClickAwayListener onClickAway={() => setOpen(false)}>
      <Box role="search" sx={{ flex: 1, maxWidth: { sm: 460 }, minWidth: 0 }}>
        <Stack
          ref={anchor}
          direction="row"
          sx={{
            alignItems: 'center',
            gap: 1,
            px: 2,
            py: 0.875,
            border: '1px solid var(--sf-line-strong)',
            borderRadius: 'var(--sf-pill)',
            bgcolor: 'var(--card)',
            transition: 'border-color .15s ease, box-shadow .15s ease',
            '&:hover': { borderColor: 'var(--muted)' },
            '&:focus-within': {
              borderColor: 'var(--accent)',
              boxShadow: '0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent)',
            },
            '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
          }}
        >
          <SearchRoundedIcon sx={{ fontSize: 20, color: 'var(--muted)' }} />
          {/* Un campo de texto con lista de sugerencias ES un `combobox`, no un
              `searchbox`: es lo que hace que un lector de pantalla anuncie
              cuántas opciones hay y cuál está enfocada. Los atributos van en el
              `<input>` real (`inputProps`), no en el envoltorio de MUI, que es
              un `div` y no lo anuncia nadie. */}
          <InputBase
            fullWidth
            value={term}
            placeholder={t('store.search.placeholder')}
            inputProps={{
              'aria-label': t('store.search.open'),
              role: 'combobox',
              'aria-expanded': showPanel,
              'aria-controls': LIST_ID,
              'aria-autocomplete': 'list',
              ...(cursor >= 0 && hits[cursor]
                ? { 'aria-activedescendant': `${LIST_ID}-${hits[cursor]!.productId}` }
                : {}),
            }}
            onChange={(event) => {
              setTerm(event.target.value)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setOpen(true)
                setCursor((value) => Math.min(value + 1, hits.length - 1))
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setCursor((value) => Math.max(value - 1, -1))
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                // Sin nada marcado, Enter lleva al catálogo filtrado y NO elige
                // el primer resultado: quien escribe y pulsa Enter quiere ver
                // lo que hay, no que se decida por él.
                const picked = cursor >= 0 ? hits[cursor] : undefined
                if (picked) goToProduct(picked.slug)
                else goToCatalog()
              }
              if (event.key === 'Escape') setOpen(false)
            }}
            sx={{ fontSize: 14 }}
          />
          {results.isFetching && clean.length >= 2 && (
            <CircularProgress size={16} sx={{ color: 'var(--muted)' }} />
          )}
        </Stack>

        <Popper
          open={showPanel}
          anchorEl={anchor.current}
          placement="bottom-start"
          style={{ zIndex: 1300, width: anchor.current?.offsetWidth }}
        >
          <Paper
            elevation={0}
            sx={{
              mt: 0.5,
              border: '1px solid var(--border)',
              borderRadius: 'var(--sf-radius-sm)',
              boxShadow: 'var(--shadow-lg)',
              overflow: 'hidden',
            }}
          >
            {hits.length === 0 ? (
              <Typography sx={{ p: 2, fontSize: T.body, color: 'var(--muted)' }}>
                {results.isFetching ? t('common.loading') : t('store.search.empty')}
              </Typography>
            ) : (
              <Stack role="listbox" id={LIST_ID}>
                {hits.map((hit, index) => (
                  <Stack
                    key={hit.productId}
                    id={`${LIST_ID}-${hit.productId}`}
                    component="button"
                    type="button"
                    role="option"
                    aria-selected={index === cursor}
                    direction="row"
                    onMouseEnter={() => setCursor(index)}
                    onClick={() => goToProduct(hit.slug)}
                    sx={{
                      alignItems: 'center',
                      gap: 1.25,
                      p: 1,
                      width: '100%',
                      textAlign: 'left',
                      background: 'none',
                      border: 0,
                      borderBottom: '1px solid var(--border)',
                      cursor: 'pointer',
                      font: 'inherit',
                      color: 'inherit',
                      '&:hover, &:focus-visible': { bgcolor: 'var(--neutral-soft)' },
                      ...(hits[cursor]?.productId === hit.productId
                        ? { bgcolor: 'var(--neutral-soft)' }
                        : {}),
                    }}
                  >
                    <Thumb
                      url={hit.imagePath ? (thumbnails[hit.imagePath] ?? null) : null}
                      alt={hit.imageAlt ?? hit.name}
                    />
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography
                        sx={{
                          fontSize: 13.5,
                          fontWeight: 700,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {hit.name}
                      </Typography>
                      {hit.categoryName && (
                        <Typography sx={{ fontSize: 11.5, color: 'var(--muted)' }}>
                          {hit.categoryName}
                        </Typography>
                      )}
                    </Box>
                    {hit.price && hit.currency && (
                      <Typography sx={{ fontSize: 13, fontWeight: 800, whiteSpace: 'nowrap' }}>
                        {formatMoney(Number(hit.price), hit.currency, locale)}
                      </Typography>
                    )}
                  </Stack>
                ))}

                <Stack
                  component="button"
                  type="button"
                  onClick={goToCatalog}
                  sx={{
                    p: 1.25,
                    background: 'none',
                    border: 0,
                    cursor: 'pointer',
                    font: 'inherit',
                    color: 'var(--accent-deep)',
                    fontWeight: 800,
                    fontSize: 13,
                    '&:hover, &:focus-visible': { bgcolor: 'var(--neutral-soft)' },
                  }}
                >
                  {t('store.search.seeAll')}
                </Stack>
              </Stack>
            )}
          </Paper>
        </Popper>
      </Box>
    </ClickAwayListener>
  )
}

/**
 * Miniatura de la lista. Sin foto se pinta un hueco del mismo tamaño y NO nada:
 * una lista donde unas filas tienen imagen y otras no se descuadra entera, y el
 * salto se lee como un error de carga.
 */
function Thumb({ url, alt }: { url: string | null; alt: string }) {
  return (
    <Box
      sx={{
        width: 44,
        height: 44,
        flexShrink: 0,
        borderRadius: `${R.sm}px`,
        bgcolor: 'var(--neutral-soft)',
        overflow: 'hidden',
        display: 'grid',
        placeItems: 'center',
      }}
    >
      {url ? (
        <Box
          component="img"
          src={url}
          alt={alt}
          loading="lazy"
          sx={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        <SearchRoundedIcon aria-hidden sx={{ fontSize: 18, color: 'var(--muted)' }} />
      )}
    </Box>
  )
}
