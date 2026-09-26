import { Alert, Box, Link as MuiLink, Stack, Typography } from '@mui/material'
import { useMemo, useState } from 'react'
import type { UseFormReturn } from 'react-hook-form'
import { useCatalogSearch, useSignedThumbnails } from '@/features/storefront/hooks'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { formatMoney } from '@/shared/lib/format'
import { tenantAccentVars } from '@/theme/appearance'
import { useAppearance } from '@/theme/appearance-context'
import '@/theme/storefrontFonts'
import { R, TS, brandFontStack } from '@/theme/tokens'
import {
  THEME_PRESET_IDS,
  type StorefrontStyle,
  type ThemePreset,
} from '@/features/storefront/theme/types'
import { THEME_FONTS, THEME_PRESETS, normalizeHomeLayout, resolveStoreFont } from '@/features/storefront/theme/presets'
import { AdvancedStyleSettings } from './AdvancedStyleSettings'
import { themeColumnsReady } from './api'
import { DesignStep } from './DesignStep'
import { HomeLayoutEditor } from './HomeLayoutEditor'
import { StoreReadiness } from './StoreReadiness'
import { StorefrontPreview, type PreviewData } from './StorefrontPreview'
import { ThemeMiniPreview } from './ThemeMiniPreview'
import type { StoreFormValues } from './types'
import { ValuePropsSection } from './ValuePropsSection'

/**
 * «Diseño de tienda»: el taller donde se compone la vitrina (Storefront V2 · P10).
 *
 * ## Qué era hasta P10
 *
 * Un formulario largo con la vista previa **al final**. Se elegía el tema
 * arriba, se bajaba por siete desplegables y el editor de secciones, y se
 * llegaba a la vista previa varias pantallas después — cuando ya no se veía lo
 * que se había tocado. Cambiar el tema y ver el efecto exigía subir, cambiar,
 * bajar, mirar y volver a subir.
 *
 * Eso no es un problema de estética. Configurar una tienda es un lazo de prueba
 * y error: se cambia algo, se mira, se decide. Si el lazo no cabe en una
 * pantalla, se rompe, y lo que pasa entonces es que nadie prueba nada — se elige
 * un tema a ciegas y no se vuelve.
 *
 * ## El taller
 *
 * Dos columnas en escritorio: la **configuración a la izquierda**, que se
 * desplaza, y la **vista previa a la derecha, fija**. Se toca cualquier cosa y
 * se ve al lado sin mover la pantalla. En tableta y teléfono vuelve a ser una
 * columna —una vista previa fija en 390 px de ancho no deja sitio para
 * configurar nada— y la vista previa pasa al final, que es donde estaba.
 *
 * ## Las tres decisiones, en su orden
 *
 *  1. **El tema** — una decisión, no siete. Un comercio sabe si vende por
 *     repetición o por contemplación; no sabe —ni tiene por qué— si su tienda
 *     quiere `contentWidth: xl` con `imageRatio: portrait`.
 *  2. **Los ajustes finos** — plegados y agrupados, para la excepción.
 *  3. **El orden de la portada** — qué secciones y en qué orden.
 *
 * ## Lo que NO dicen los textos de las tarjetas
 *
 * No dicen «para farmacias» ni «para moda». Los ejemplos ayudan a elegir y las
 * restricciones estorban: en cuanto un tema dice «solo moda», el comercio de
 * muebles que lo quería deja de mirarlo. Los cuatro sirven para cualquier rubro,
 * y quien decide es quien vende.
 *
 * ## Y lo que no se expone nunca
 *
 * Ni un campo libre, ni el JSON, ni nada que no esté en el contrato de P01.
 * Cada control es una lista cerrada con una opción más —la de heredar— que es
 * la que devuelve el valor al preset sin dejar un dato pisado a medias.
 */

const ETIQUETA_TEMA: Record<ThemePreset, MessageKey> = {
  universal: 'settings.design.theme.universal',
  retail: 'settings.design.theme.retail',
  premium: 'settings.design.theme.premium',
  catalog: 'settings.design.theme.catalog',
}

const AYUDA_TEMA: Record<ThemePreset, MessageKey> = {
  universal: 'settings.design.theme.universalHelp',
  retail: 'settings.design.theme.retailHelp',
  premium: 'settings.design.theme.premiumHelp',
  catalog: 'settings.design.theme.catalogHelp',
}

/**
 * El texto de cada valor del contrato, para el resumen de la tarjeta (P12).
 *
 * El resumen se arma de la DEFINICIÓN del preset, no de una frase escrita a
 * mano: el día que `retail` pase de cinco columnas a seis, la tarjeta lo dice
 * sin que nadie la toque. Una descripción redactada se queda vieja en silencio.
 */
const ETIQUETA_VALOR: Record<string, MessageKey> = {
  standard: 'settings.design.value.standard',
  compact: 'settings.design.value.compact',
  product: 'settings.design.value.product',
  statement: 'settings.design.value.statement',
  comfortable: 'settings.design.value.comfortable',
  tiles: 'settings.design.value.tiles',
  pills: 'settings.design.value.pills',
  square: 'settings.design.value.square',
  portrait: 'settings.design.value.portrait',
  landscape: 'settings.design.value.landscape',
  spacious: 'settings.design.value.spacious',
  // Storefront V3 · P02
  brand: 'settings.design.value.brand',
  editorial: 'settings.design.value.editorial',
  mosaic: 'settings.design.value.mosaic',
  bento: 'settings.design.value.bento',
  circles: 'settings.design.value.circles',
  // Resumen v2 · contrato V5 (Retail «Feria de ofertas»)
  icons: 'settings.design.value.icons',
  flash: 'settings.design.value.flash',
  banners: 'settings.design.value.banners',
  cover: 'settings.design.value.cover',
  contain: 'settings.design.value.contain',
  lg: 'settings.design.value.lg',
  xl: 'settings.design.value.xl',
}

/** El valor que significa «no lo piso, lo hereda del tema». */
const HEREDAR = ''

/** Resumen v2 · Los pasos del taller, en orden (sirven de ancla: `#diseno-tema`…). */
const ORDEN_PASOS = ['tema', 'portada', 'forma', 'confianza', 'revisar'] as const

export function StorefrontDesignSection({
  form,
  busy = false,
  storeId = null,
  storeSlug = null,
  pasosAbiertos = [0],
}: {
  form: UseFormReturn<StoreFormValues>
  busy?: boolean
  /**
   * La tienda, para el panel de calidad visual (Storefront V2 · P13).
   *
   * Opcionales porque esta sección se monta también sin tienda activa —una
   * cuenta recién creada— y entonces no hay nada que medir. Sin ellos el panel
   * no se pinta: un panel de calidad con siete líneas a cero no informa de
   * nada, asusta.
   */
  storeId?: string | null
  storeSlug?: string | null
  /** Resumen v2 · Qué pasos empiezan abiertos (por índice). En la app, el primero. */
  pasosAbiertos?: readonly number[]
}) {
  const { t } = useI18n()
  const preset = form.watch('theme_preset')
  const estilo = form.watch('storefront_style')

  /**
   * El estilo EFECTIVO: lo que el tema dice, con lo pisado encima (V3 · P12).
   *
   * El formulario guarda solo lo que el comercio apartó del tema —eso es lo que
   * permite que mejorar un tema llegue a quien no lo tocó—, así que para
   * resolver lo que `auto` significa hoy hace falta la mezcla. Es la misma que
   * hace el motor al leer la fila.
   */
  const estiloEfectivo = { ...THEME_PRESETS[preset], ...estilo }

  /**
   * Resumen v2 · Qué pasos están abiertos. Uno a la vez en la app; quien monta
   * el taller puede abrir varios (los tests, que miran el contenido y no el
   * plegado).
   */
  const [abiertos, setAbiertos] = useState<ReadonlySet<number>>(() => new Set(pasosAbiertos))
  const [visto, setVisto] = useState(() => Math.max(0, ...pasosAbiertos))
  function abrir(indice: number) {
    setAbiertos(new Set([indice]))
    setVisto((previo) => Math.max(previo, indice))
    const quieto = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    requestAnimationFrame(() =>
      document.getElementById(`diseno-${ORDEN_PASOS[indice]}`)?.scrollIntoView?.({ block: 'start', behavior: quieto ? 'auto' : 'smooth' }),
    )
  }
  function alternar(indice: number) {
    if (abiertos.has(indice)) setAbiertos(new Set())
    else abrir(indice)
  }
  const fuenteDelTema = resolveStoreFont(form.watch('font_family'), preset)
  const encendidas = normalizeHomeLayout(form.watch('home_layout')).sections.filter((seccion) => seccion.enabled).length
  const cambiados = Object.keys(estilo ?? {}).length

  /**
   * Resumen v2 · LA TIENDA DE VERDAD en la vista previa.
   *
   * Hasta aquí la vista previa salía en el verde de la suite, con «Producto de
   * ejemplo 1» y «Aquí va la frase de tu portada»: se elegía un tema mirando una
   * tienda que no era la suya. Ahora lleva, SIN GUARDAR:
   *  - el color del formulario, como variables en línea SOLO en su zona (el
   *    backoffice de alrededor sigue en el suyo);
   *  - la letra que se va a pintar (la elegida o la que propone el tema);
   *  - el titular y el mensaje de la portada;
   *  - los seis productos más recientes, con su foto y su precio.
   */
  const { locale } = useI18n()
  const { appearance } = useAppearance()
  const acento = form.watch('accent_color')
  const tinta = useMemo(
    () => (/^#[0-9a-f]{6}$/i.test(acento ?? '') ? tenantAccentVars(acento as string, appearance.mode) : {}),
    [acento, appearance.mode],
  )
  const letra = brandFontStack(resolveStoreFont(form.watch('font_family'), preset))
  const muestra = useCatalogSearch(
    storeSlug ?? undefined,
    { term: '', filters: {}, sort: 'recent', limit: 6, offset: 0 },
    Boolean(storeSlug),
  )
  const hits = muestra.data?.items ?? []
  const miniaturas = useSignedThumbnails(hits.map((hit) => hit.imagePath ?? null))
  const datos: PreviewData = useMemo(
    () => ({
      products: hits.map((hit) => ({
        name: hit.name,
        price: formatMoney(Number(hit.price ?? 0), hit.currency ?? 'PEN', locale),
        compareAt:
          hit.compareAtPrice && Number(hit.compareAtPrice) > Number(hit.price ?? 0)
            ? formatMoney(Number(hit.compareAtPrice), hit.currency ?? 'PEN', locale)
            : null,
        imageUrl: hit.imagePath ? (miniaturas[hit.imagePath] ?? null) : null,
      })),
      heroTitle: form.watch('hero_title') || null,
      heroSubtitle: form.watch('hero_subtitle') || null,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hits, miniaturas, locale, form.watch('hero_title'), form.watch('hero_subtitle')],
  )

  /**
   * La base puede ir por detrás del código.
   *
   * Entre que se publica esta pantalla y se aplica su migración hay una ventana
   * —a veces de minutos, a veces de días— en la que las tres columnas no
   * existen. Enseñar los controles ahí sería peor que no enseñarlos: alguien
   * elegiría su tema, pulsaría Guardar y no pasaría nada. Un formulario que no
   * guarda es una mentira más cara que una sección que avisa.
   */
  if (!themeColumnsReady()) {
    return (
      <Alert severity="info" icon={false}>
        {t('settings.design.unavailable')}
      </Alert>
    )
  }

  function elegirTema(nuevo: ThemePreset) {
    form.setValue('theme_preset', nuevo, { shouldDirty: true })
  }

  function pisar(clave: keyof StorefrontStyle, valor: string) {
    const siguiente = { ...estilo }
    if (valor === HEREDAR) delete siguiente[clave]
    else Object.assign(siguiente, { [clave]: valor })
    form.setValue('storefront_style', siguiente, { shouldDirty: true })
  }

  return (
    <Box
      data-testid="design-workspace"
      sx={{
        display: 'grid',
        gap: { xs: 2.5, lg: 3 },
        alignItems: 'start',
        /**
         * Dos columnas desde `lg`, y ni una antes.
         *
         * El panel de configuración necesita unos 380 px para que un desplegable
         * con «Usar tema: Comodidad» no parta el texto en dos líneas, y la vista
         * previa necesita lo que le quede. Por debajo de `lg` no hay sitio para
         * las dos: se apilan, que es como estaba y sigue funcionando.
         *
         * En pantallas muy anchas el panel crece hasta 520 px en vez de dejar
         * que se estire la vista previa hasta 1600: un marco de escritorio mide
         * 1280 px lógicos y el resto sería gris.
         */
        gridTemplateColumns: {
          xs: '1fr',
          lg: 'minmax(380px, 420px) minmax(0, 1fr)',
          xl: 'minmax(440px, 520px) minmax(0, 1fr)',
        },
      }}
    >
      <Stack
        component="section"
        aria-label={t('settings.design.workspace.config')}
        spacing={2.5}
        sx={{ minWidth: 0 }}
      >
        {/* Resumen v2 · EL TALLER EN CINCO PASOS.
            Antes, tema, ajustes, portada y preparación iban seguidos en un solo
            scroll, sin orden ni final. Ahora son pasos con su resumen: cerrado,
            cada uno dice lo que se eligió; abierto, lleva el borde del acento. */}
        <DesignStep
          id="tema"
          numero={1}
          titulo={t('settings.design.step.theme')}
          resumen={`${t(ETIQUETA_TEMA[preset])} · ${t(`settings.font.${fuenteDelTema}` as MessageKey)}`}
          abierto={abiertos.has(0)}
          hecho={visto > 0}
          onAlternar={() => alternar(0)}
          siguiente={{ etiqueta: t('settings.design.step.next').replace('{step}', t('settings.design.step.home')), onClick: () => abrir(1) }}
        >
          <Typography sx={{ fontSize: TS.label, color: 'var(--muted)' }}>
            {t('settings.design.theme.help')}
          </Typography>
          {/* `radiogroup` y no cuatro botones: son cuatro opciones EXCLUYENTES, y
              un lector de pantalla necesita saber que elegir una descarta las
              otras tres. Con botones sueltos anunciaría cuatro acciones. */}
          <Box
            role="radiogroup"
            aria-label={t('settings.design.theme.title')}
            sx={{
              display: 'grid',
              gap: 1.5,
              // Dos columnas también en el panel del taller: cuatro tarjetas en
              // fila dentro de 420 px dejarían el título en tres líneas.
              gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
            }}
          >
            {THEME_PRESET_IDS.map((id) => {
              const elegido = preset === id
              return (
                <Box
                  key={id}
                  role="radio"
                  tabIndex={0}
                  aria-checked={elegido}
                  aria-disabled={busy || undefined}
                  onClick={() => !busy && elegirTema(id)}
                  onKeyDown={(event) => {
                    if (busy) return
                    // Espacio y Enter: los dos gestos con los que se activa un
                    // control de este tipo. Solo uno deja fuera a media gente.
                    if (event.key === ' ' || event.key === 'Enter') {
                      event.preventDefault()
                      elegirTema(id)
                    }
                  }}
                  sx={{
                    cursor: busy ? 'default' : 'pointer',
                    p: 1.5,
                    borderRadius: `${R.lg}px`,
                    border: '2px solid',
                    borderColor: elegido ? 'var(--accent)' : 'var(--border)',
                    bgcolor: elegido ? 'var(--accent-soft)' : 'var(--card)',
                    opacity: busy ? 0.6 : 1,
                    '&:focus-visible': { outline: '2px solid var(--accent)', outlineOffset: 2 },
                  }}
                >
                  {/* La miniatura va PRIMERO: elegir un tema es una decisión
                      visual, y hasta P12 se tomaba leyendo cuatro frases. Se
                      dibuja con la definición del preset, así que no se
                      desincroniza de la tienda. */}
                  {/* Resumen v2 · La miniatura en el color de la TIENDA, no en el
                      de la suite: se elige mirando la propia tienda. */}
                  <Box style={tinta}>
                    <ThemeMiniPreview preset={id} />
                  </Box>

                  <Typography
                    sx={{
                      fontSize: TS.bodyStrong,
                      fontWeight: 800,
                      mt: 1,
                      color: elegido ? 'var(--accent-deep)' : 'var(--text)',
                    }}
                  >
                    {t(ETIQUETA_TEMA[id])}
                  </Typography>
                  {/* Y la letra que propone, escrita en esa letra. */}
                  <Stack direction="row" sx={{ alignItems: 'baseline', gap: 0.75, mt: 0.25 }}>
                    <Typography
                      aria-hidden
                      sx={{ fontFamily: brandFontStack(THEME_FONTS[id]), fontSize: 20, fontWeight: 700, lineHeight: 1 }}
                    >
                      Aa
                    </Typography>
                    <Typography sx={{ fontSize: TS.label, fontWeight: 700, color: 'var(--muted)' }}>
                      {t(`settings.font.${THEME_FONTS[id]}` as MessageKey)}
                    </Typography>
                  </Stack>
                  <Typography sx={{ fontSize: TS.label, color: 'var(--muted)', mt: 0.5 }}>
                    {t(AYUDA_TEMA[id])}
                  </Typography>
                  {/* Y las diferencias en datos, para quien no puede ver la
                      miniatura y para quien quiere el número exacto. */}
                  <Typography
                    sx={{ fontSize: TS.label, color: 'var(--muted)', mt: 0.5, fontWeight: 700 }}
                  >
                    {resumen(id, t)}
                  </Typography>
                </Box>
              )
            })}
          </Box>
        </DesignStep>

        <DesignStep
          id="portada"
          numero={2}
          titulo={t('settings.design.step.home')}
          resumen={t('settings.design.step.homeSummary').replace('{n}', String(encendidas))}
          abierto={abiertos.has(1)}
          hecho={visto > 1}
          onAlternar={() => alternar(1)}
          siguiente={{ etiqueta: t('settings.design.step.next').replace('{step}', t('settings.design.step.style')), onClick: () => abrir(2) }}
        >
          {/* El tema efectivo baja al editor: el panel de presentación por
              sección necesita saber qué significa `auto` hoy para poder
              escribirlo en el desplegable (V3 · P12). */}
          <HomeLayoutEditor form={form} busy={busy} preset={preset} style={estiloEfectivo} />
        </DesignStep>

        <DesignStep
          id="forma"
          numero={3}
          titulo={t('settings.design.step.style')}
          resumen={
            cambiados === 0
              ? t('settings.design.step.styleInherit')
              : t('settings.design.step.styleSummary').replace('{n}', String(cambiados))
          }
          abierto={abiertos.has(2)}
          hecho={visto > 2}
          onAlternar={() => alternar(2)}
          siguiente={{ etiqueta: t('settings.design.step.next').replace('{step}', t('settings.design.step.trust')), onClick: () => abrir(3) }}
        >
          <AdvancedStyleSettings
            preset={preset}
            style={estilo}
            busy={busy}
            onChange={pisar}
            onReset={() => form.setValue('storefront_style', {}, { shouldDirty: true })}
          />
        </DesignStep>

        <DesignStep
          id="confianza"
          numero={4}
          titulo={t('settings.design.step.trust')}
          resumen={t('settings.design.step.trustSummary')}
          abierto={abiertos.has(3)}
          hecho={visto > 3}
          onAlternar={() => alternar(3)}
          siguiente={{ etiqueta: t('settings.design.step.next').replace('{step}', t('settings.design.step.review')), onClick: () => abrir(4) }}
        >
          {/* Las garantías («Por qué comprarnos») viven aquí desde el Resumen
              v2. Iban en General para no obligar a bajar por los ajustes de
              diseño hasta llegar a escribirlas; con pasos, tienen el suyo. */}
          <Stack sx={{ gap: 0.5 }}>
            <Typography sx={{ fontSize: TS.bodyStrong, fontWeight: 700 }}>{t('settings.valueProps.title')}</Typography>
            <Typography sx={{ fontSize: TS.label, color: 'var(--muted)' }}>{t('settings.valueProps.help')}</Typography>
          </Stack>
          <ValuePropsSection form={form} busy={busy} />
          {/* La barra de avisos, el logotipo y el interruptor claro/oscuro NO
              se editan aquí: tienen UN sitio, Marca. Aquí se dice dónde. */}
          <Typography sx={{ fontSize: TS.label, color: 'var(--muted)' }}>
            {t('settings.design.step.trustBrandHint')}{' '}
            <MuiLink href="#branding" sx={{ fontWeight: 800 }}>
              {t('settings.design.step.goToBrand')}
            </MuiLink>
          </Typography>
        </DesignStep>

        <DesignStep
          id="revisar"
          numero={5}
          titulo={t('settings.design.step.review')}
          resumen={t('settings.design.step.reviewSummary')}
          abierto={abiertos.has(4)}
          hecho={false}
          onAlternar={() => alternar(4)}
        >
        {storeId && storeSlug ? (
          <StoreReadiness
            storeId={storeId}
            storeSlug={storeSlug}
            store={{
              logo_url: form.watch('logo_url'),
              banner_url: form.watch('banner_url'),
              support_email: form.watch('support_email'),
              contact_phone: form.watch('contact_phone'),
              contact_address: form.watch('contact_address'),
              brand_lockup: form.watch('brand_lockup'),
              store_description: form.watch('store_description'),
              hero_subtitle: form.watch('hero_subtitle'),
            }}
          />
        ) : null}
          <Typography sx={{ fontSize: TS.label, color: 'var(--muted)' }}>
            {t('settings.design.step.reviewHint')}
          </Typography>
        </DesignStep>
      </Stack>

      {/**
       * La vista previa, fija mientras se configura.
       *
       * `position: sticky` solo desde `lg`, que es donde hay dos columnas: en
       * una sola, fijar la vista previa la dejaría tapando el formulario.
       *
       * El `top` deja pasar la cabecera de la página y las pestañas; la altura
       * máxima descuenta eso y la barra de Guardar, que flota abajo. Sin ese
       * descuento, la vista previa se mete debajo de la barra y las últimas
       * secciones de la tienda quedan detrás de dos botones.
       *
       * Lee el formulario SIN guardar: se cambia el tema a la izquierda y se ve
       * aquí antes de decidir. La tienda pública no se entera hasta pulsar
       * Guardar.
       */}
      <Box
        component="section"
        aria-label={t('settings.design.preview.title')}
        sx={{
          minWidth: 0,
          position: { xs: 'static', lg: 'sticky' },
          top: { lg: 16 },
          maxHeight: { lg: 'calc(100vh - 120px)' },
          overflowY: { lg: 'auto' },
          // Aire a la derecha del contenido desplazable, para que la barra de
          // desplazamiento no se coma el borde del marco.
          pr: { lg: 0.5 },
        }}
      >
        {/* El color y la letra de la tienda, solo en esta zona. La letra se
            fuerza sobre la tipografía de MUI, que trae la de la suite. */}
        <Box
          data-preview-tenant
          style={{ ...tinta, fontFamily: letra }}
          sx={{ '& .MuiTypography-root': { fontFamily: 'inherit' } }}
        >
        <StorefrontPreview
          data={datos}
          storeName={form.watch('name') || form.watch('business_display_name')}
          themePreset={preset}
          style={estilo}
          layout={form.watch('home_layout')}
          /**
           * La identidad del comercio, sin guardar (V3 · P13).
           *
           * Es lo que le da paridad a la cabecera: el lockup elegido, el
           * logotipo —o su ausencia, que cambia lo que se pinta— y los avisos
           * escritos. Los tres se editan en Marca y se MIRAN aquí, que es la
           * división que P12 dejó escrita.
           */
          identity={{
            logoUrl: form.watch('logo_url'),
            brandLockup: form.watch('brand_lockup'),
            announcements: form.watch('announcement_messages'),
          }}
        />
        </Box>
      </Box>
    </Box>
  )
}

/**
 * Las diferencias del tema, en una línea y sacadas de su definición.
 *
 * Columnas, tarjeta y portada: las tres que de verdad cambian cómo se ve una
 * tienda. Salen de `THEME_PRESETS`, así que cambiar un preset cambia esta línea.
 */
function resumen(preset: ThemePreset, t: (key: MessageKey) => string): string {
  const d = THEME_PRESETS[preset]
  return [
    t('settings.design.theme.columns').replace('{n}', String(d.gridColumns.lg)),
    t(ETIQUETA_VALOR[d.productCardVariant] ?? 'settings.design.style.inherit'),
    t(ETIQUETA_VALOR[d.heroVariant] ?? 'settings.design.style.inherit'),
  ].join(' · ')
}
