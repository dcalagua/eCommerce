import { Card, Stack, Typography } from '@mui/material'
import { useParams } from 'react-router-dom'
import { useI18n } from '@/shared/i18n/i18n-context'
import { useDocumentMeta } from '@/shared/seo/useDocumentMeta'
import { EmptyState, ErrorState, LoadingState } from '@/shared/ui/states'
import { T } from '@/theme/tokens'
import { ContentBlocks } from './components/ContentBlocks'
import { useContentAssets, useStoreContent, useStorefront } from './hooks'
import { contentMeta, notFoundMeta } from './seo'

/**
 * Página administrable con URL propia: `/s/:storeSlug/p/:pageSlug`.
 *
 * Es la mitad visible del `landing page` del encargo. Lo que la hace útil no es
 * poder escribirla, es poder ALCANZARLA: por eso `content_pages.show_in_nav`
 * mete las que el comercio elija en el menú de la vitrina, y por eso la URL
 * lleva el slug de la página y no su uuid — una campaña se comparte por
 * WhatsApp, y un uuid no se comparte.
 *
 * Sin `content.cms`, o con la página despublicada o fuera de vigencia, se
 * responde «no encontramos esta página». Los dos casos dan lo MISMO a
 * propósito: distinguirlos le diría a un desconocido que la tienda tiene una
 * página que hoy no puede ver, que es información que nadie le debe.
 */
export function StoreContentPage() {
  const { t, locale } = useI18n()
  const { store, storeSlug } = useStorefront()
  const { pageSlug } = useParams<{ pageSlug: string }>()
  const content = useStoreContent(storeSlug, pageSlug ?? null)
  const { assets, images } = useContentAssets(content.data)

  const page = content.data?.page ?? null

  /**
   * El SEO de una página administrable lo escribe el COMERCIO: `seo_title`,
   * `seo_description` y `og_image_url` existen en `content_pages` desde P11 y
   * hasta P14 solo se usaba el primero, y solo para el `<title>`.
   *
   * Una página que no resuelve —sin `content.cms`, despublicada o fuera de
   * vigencia— sale `noindex`. Las tres se ven igual a propósito (no se le dice
   * a un desconocido qué páginas tiene la tienda sin publicar) y las tres
   * responden 200, así que sin el `noindex` el «no encontramos esta página»
   * acabaría indexado.
   */
  const ogImage = page?.ogImageUrl
    ? /^https:\/\//i.test(page.ogImageUrl)
      ? page.ogImageUrl
      : (assets[page.ogImageUrl] ?? null)
    : null

  useDocumentMeta(
    content.isPending
      ? null
      : page && content.data?.cms
        ? contentMeta({ store, storeSlug, locale, pathname: `/s/${storeSlug}` }, page, ogImage)
        : notFoundMeta({
            title: t('store.content.notFound'),
            pathname: `/s/${storeSlug}/p/${pageSlug ?? ''}`,
            siteName: store.name,
            locale,
          }),
  )

  if (content.isPending) return <LoadingState />

  if (content.isError) {
    return (
      <Card>
        <ErrorState error={content.error} onRetry={() => void content.refetch()} />
      </Card>
    )
  }

  if (!content.data?.cms || !page) {
    return (
      <Card>
        <EmptyState title={t('store.content.notFound')} description={t('store.content.notFoundBody')} />
      </Card>
    )
  }

  return (
    <Stack sx={{ gap: { xs: 2, md: 3 } }}>
      <Stack sx={{ gap: 0.5 }}>
        <Typography component="h1" sx={{ fontSize: { xs: 26, md: 34 }, fontWeight: 800 }}>
          {page.title}
        </Typography>
        {page.seoDescription ? (
          <Typography sx={{ fontSize: T.bodyStrong, color: 'var(--muted)', maxWidth: 720 }}>
            {page.seoDescription}
          </Typography>
        ) : null}
      </Stack>

      <ContentBlocks
        blocks={content.data.blocks}
        storeSlug={storeSlug}
        assets={assets}
        images={images}
      />
    </Stack>
  )
}
