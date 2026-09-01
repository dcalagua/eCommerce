import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { SearchQuery } from '@/domain'
import {
  addBlockItem,
  createBlock,
  createPage,
  createSynonym,
  deleteBlock,
  deletePage,
  deleteSynonym,
  fetchBlockItems,
  fetchBlocks,
  fetchPages,
  fetchLinkablePromotions,
  fetchPreview,
  fetchSynonyms,
  moveBlock,
  removeBlockItem,
  setBlockItemPosition,
  updateBlock,
  updatePage,
  updateSynonym,
  type BlockItemInput,
  type ContentScope,
  type PageFilter,
  type PreviewInput,
} from './api'
import { createAdminCatalogSearch } from './searchAdapter'
import type { BlockFormValues, PageFormValues, SynonymFormValues } from './types'

/**
 * Estado del editor de contenido.
 *
 * Toda escritura invalida el árbol `content` **y** el de `storefront`: publicar
 * una portada cambia lo que el comprador ve, y una vitrina que siga enseñando
 * el contenido de ayer es peor que una que tarde un segundo más en refrescar.
 * Es la misma decisión que P10 tomó con las campañas.
 */
export const CONTENT_KEY = ['content'] as const

export const pagesKey = (filter: PageFilter) =>
  [...CONTENT_KEY, 'pages', filter.storeId, filter.status, filter.term] as const
export const blocksKey = (pageId: string | null) => [...CONTENT_KEY, 'blocks', pageId] as const
export const blockItemsKey = (blockId: string | null) => [...CONTENT_KEY, 'items', blockId] as const
export const previewKey = (input: PreviewInput | null) =>
  [
    ...CONTENT_KEY,
    'preview',
    input?.pageId ?? null,
    input?.at ?? null,
    input?.channelId ?? null,
    input?.segmentId ?? null,
    input?.includeDrafts ?? true,
  ] as const
export const linkablePromotionsKey = (storeId: string | null) =>
  [...CONTENT_KEY, 'linkable-promotions', storeId] as const
export const synonymsKey = (storeId: string | null, term: string) =>
  [...CONTENT_KEY, 'synonyms', storeId, term] as const
export const adminSearchKey = (storeId: string | null, query: SearchQuery) =>
  [...CONTENT_KEY, 'catalog-search', storeId, query.term, query.limit] as const

function useInvalidateContent() {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: CONTENT_KEY })
    void queryClient.invalidateQueries({ queryKey: ['storefront'] })
  }
}

export function usePages(filter: PageFilter) {
  return useQuery({
    queryKey: pagesKey(filter),
    queryFn: () => fetchPages(filter),
    enabled: filter.storeId !== null,
  })
}

export function useSavePage(scope: ContentScope | null) {
  const invalidate = useInvalidateContent()
  return useMutation({
    mutationFn: (input: { id: string | null; values: PageFormValues }) => {
      if (!scope) throw new Error('SIN_TIENDA')
      return input.id === null
        ? createPage(scope, input.values)
        : updatePage(input.id, input.values).then(() => input.id as string)
    },
    onSuccess: invalidate,
  })
}

export function useDeletePage() {
  const invalidate = useInvalidateContent()
  return useMutation({ mutationFn: deletePage, onSuccess: invalidate })
}

export function useBlocks(pageId: string | null) {
  return useQuery({
    queryKey: blocksKey(pageId),
    queryFn: () => fetchBlocks(pageId),
    enabled: pageId !== null,
  })
}

export function useSaveBlock(scope: ContentScope | null, pageId: string | null) {
  const invalidate = useInvalidateContent()
  return useMutation({
    mutationFn: (input: { id: string | null; values: BlockFormValues }) => {
      if (!scope || !pageId) throw new Error('SIN_PAGINA')
      return input.id === null
        ? createBlock(scope, pageId, input.values)
        : updateBlock(input.id, input.values).then(() => input.id as string)
    },
    onSuccess: invalidate,
  })
}

export function useDeleteBlock() {
  const invalidate = useInvalidateContent()
  return useMutation({ mutationFn: deleteBlock, onSuccess: invalidate })
}

export function useMoveBlock() {
  const invalidate = useInvalidateContent()
  return useMutation({
    mutationFn: (input: { id: string; position: number }) => moveBlock(input.id, input.position),
    onSuccess: invalidate,
  })
}

export function useBlockItems(blockId: string | null) {
  return useQuery({
    queryKey: blockItemsKey(blockId),
    queryFn: () => fetchBlockItems(blockId),
    enabled: blockId !== null,
  })
}

export function useAddBlockItem(scope: ContentScope | null) {
  const invalidate = useInvalidateContent()
  return useMutation({
    mutationFn: (input: BlockItemInput) => {
      if (!scope) throw new Error('SIN_TIENDA')
      return addBlockItem(scope, input)
    },
    onSuccess: invalidate,
  })
}

export function useRemoveBlockItem() {
  const invalidate = useInvalidateContent()
  return useMutation({ mutationFn: removeBlockItem, onSuccess: invalidate })
}

export function useMoveBlockItem() {
  const invalidate = useInvalidateContent()
  return useMutation({ mutationFn: setBlockItemPosition, onSuccess: invalidate })
}

/**
 * Vista previa. `staleTime: 0`: es lo único de esta pantalla que tiene que
 * enseñar el estado de AHORA MISMO — servir una foto de hace un minuto sería
 * exactamente el fallo que la vista previa existe para evitar.
 */
export function usePreview(input: PreviewInput | null) {
  return useQuery({
    queryKey: previewKey(input),
    queryFn: () => fetchPreview(input as PreviewInput),
    enabled: input !== null,
    staleTime: 0,
  })
}

/**
 * Campañas que un bloque `campaign` puede anunciar.
 *
 * Se leen aunque la sociedad no tenga `promotions` contratada: la policy de
 * `promotion_overview` solo exige membresía, y un bloque que anuncia una
 * campaña que ya no descuenta tiene que poder señalarse y corregirse en vez de
 * desaparecer del desplegable.
 */
export function useLinkablePromotions(storeId: string | null, enabled = true) {
  return useQuery({
    queryKey: linkablePromotionsKey(storeId),
    queryFn: () => fetchLinkablePromotions(storeId),
    enabled: enabled && storeId !== null,
  })
}

export function useSynonyms(storeId: string | null, term: string) {
  return useQuery({
    queryKey: synonymsKey(storeId, term),
    queryFn: () => fetchSynonyms(storeId, term),
    enabled: storeId !== null,
  })
}

export function useSaveSynonym(scope: ContentScope | null) {
  const invalidate = useInvalidateContent()
  return useMutation({
    mutationFn: (input: { id: string | null; values: SynonymFormValues }) => {
      if (!scope) throw new Error('SIN_TIENDA')
      return input.id === null
        ? createSynonym(scope, input.values)
        : updateSynonym(input.id, input.values)
    },
    onSuccess: invalidate,
  })
}

export function useDeleteSynonym() {
  const invalidate = useInvalidateContent()
  return useMutation({ mutationFn: deleteSynonym, onSuccess: invalidate })
}

/**
 * Buscador de productos del editor, con CANCELACIÓN.
 *
 * Es el primer llamante del `SearchPort` del backoffice. Sin él, montar una
 * colección sería pegar uuids: la deuda que P10 dejó escrita al no poner
 * buscador en el editor de alcance de campañas.
 */
export function useAdminCatalogSearch(storeId: string | null, term: string, enabled = true) {
  const query: SearchQuery = { term, limit: 12, sort: 'relevance' }
  return useQuery({
    queryKey: adminSearchKey(storeId, query),
    queryFn: ({ signal }) => createAdminCatalogSearch(storeId).search({ ...query, signal }),
    enabled: enabled && storeId !== null && term.trim().length >= 2,
    placeholderData: (previous) => previous,
  })
}
