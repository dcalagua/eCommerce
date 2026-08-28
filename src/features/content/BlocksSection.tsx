import ViewQuiltOutlinedIcon from '@mui/icons-material/ViewQuiltOutlined'
import {
  Box,
  Button,
  Card,
  Chip,
  Divider,
  MenuItem,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material'
import { useMemo, useState } from 'react'
import { CONTENT_BLOCK_TYPES, blockAcceptsItems } from '@/domain/content'
import { useTenant } from '@/features/tenant/tenant-context'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { useDebouncedValue } from '@/shared/lib/useDebouncedValue'
import { FormDrawer } from '@/shared/ui/FormDrawer'
import { SearchField } from '@/shared/ui/SearchField'
import { TableSkeleton } from '@/shared/ui/TableSkeleton'
import { useFeedback } from '@/shared/ui/feedback-context'
import { EmptyState, ErrorState, UnauthorizedState } from '@/shared/ui/states'
import { ContentError } from './errors'
import {
  useAddBlockItem,
  useAdminCatalogSearch,
  useBlockItems,
  useBlocks,
  useDeleteBlock,
  useLinkablePromotions,
  useMoveBlock,
  useSaveBlock,
} from './hooks'
import {
  blockFormSchema,
  toBodyDraft,
  validateBlockForm,
  type BlockFormValues,
  type ContentBlockRow,
} from './types'
import { parseRichText } from '@/domain/content'
import { useRemoveBlockItem } from './hooks'

function emptyForm(): BlockFormValues {
  return {
    block_type: 'hero',
    position: 0,
    title: '',
    subtitle: '',
    body: '',
    media_url: null,
    media_alt: '',
    cta_label: '',
    cta_href: '',
    category_id: null,
    promotion_id: null,
    item_limit: 8,
    is_active: true,
    publish_from: new Date().toISOString().slice(0, 16),
    publish_to: '',
    channel_id: null,
    segment_id: null,
    columns: 4,
  }
}

function toForm(row: ContentBlockRow): BlockFormValues {
  const settings = (row.settings ?? {}) as Record<string, unknown>
  return {
    block_type: row.block_type,
    position: row.position,
    title: row.title ?? '',
    subtitle: row.subtitle ?? '',
    body: toBodyDraft(parseRichText(row.body)),
    media_url: row.media_url,
    media_alt: row.media_alt ?? '',
    cta_label: row.cta_label ?? '',
    cta_href: row.cta_href ?? '',
    category_id: row.category_id,
    promotion_id: row.promotion_id,
    item_limit: row.item_limit,
    is_active: row.is_active,
    publish_from: row.publish_from.slice(0, 16),
    publish_to: row.publish_to ? row.publish_to.slice(0, 16) : '',
    channel_id: row.channel_id,
    segment_id: row.segment_id,
    columns: typeof settings.columns === 'number' ? settings.columns : 4,
  }
}

/**
 * Bloques de una página: el editor.
 *
 * Dos decisiones de esta pantalla que no son de maquetación:
 *
 *  1. **El contenido enriquecido se escribe como TEXTO con marcas mínimas**
 *     (`## `, `### `, `> `, `- `), no en un editor visual. Un editor visual
 *     produce marcado y el marcado hay que sanearlo; con esto, lo que se
 *     escribe no puede contener una etiqueta — la sintaxis no la reconoce y el
 *     validador la rechaza. Es la misma decisión que hace que el documento
 *     guardado no sea HTML.
 *  2. **Los productos de una colección se BUSCAN**, no se pegan por uuid. Es el
 *     primer llamante del `SearchPort` del backoffice y cierra la deuda que P10
 *     dejó escrita al no poner buscador en el editor de alcance de campañas.
 */
export function BlocksSection({ pageId }: { pageId: string | null }) {
  const { t } = useI18n()
  const { notify } = useFeedback()
  const { activeStore, tenant, activeCompanyId, can } = useTenant()
  const canManage = can('store.manage')

  const [editing, setEditing] = useState<ContentBlockRow | null>(null)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<BlockFormValues>(emptyForm)
  const [itemsFor, setItemsFor] = useState<ContentBlockRow | null>(null)

  const blocks = useBlocks(pageId)

  const scope = useMemo(
    () =>
      tenant && activeCompanyId && activeStore
        ? {
            organizationId: tenant.organization_id,
            companyId: activeCompanyId,
            storeId: activeStore.id,
          }
        : null,
    [tenant, activeCompanyId, activeStore],
  )

  const save = useSaveBlock(scope, pageId)
  const remove = useDeleteBlock()
  const move = useMoveBlock()
  // Solo cuando hace falta: un desplegable de campañas en un bloque de texto es
  // una consulta que nadie pidió.
  const promotions = useLinkablePromotions(
    activeStore?.id ?? null,
    open && form.block_type === 'campaign',
  )

  const list = blocks.data ?? []
  const parsed = blockFormSchema.safeParse(form)
  const issues = parsed.success ? validateBlockForm(parsed.data) : []
  const firstIssue = parsed.success
    ? (issues[0]?.key ?? null)
    : (parsed.error.issues[0]?.message ?? 'content.error.generic')

  function openCreate() {
    setForm({ ...emptyForm(), position: list.length })
    setEditing(null)
    setOpen(true)
  }

  function openEdit(row: ContentBlockRow) {
    setForm(toForm(row))
    setEditing(row)
    setOpen(true)
  }

  async function submit() {
    if (!parsed.success || issues.length > 0) return
    try {
      await save.mutateAsync({ id: editing?.id ?? null, values: parsed.data })
      notify(t(editing ? 'content.blocks.updated' : 'content.blocks.created'), 'success')
      setOpen(false)
    } catch (error) {
      const key: MessageKey = error instanceof ContentError ? error.key : 'content.error.generic'
      notify(t(key), 'error')
    }
  }

  async function drop(row: ContentBlockRow) {
    try {
      await remove.mutateAsync(row.id)
      notify(t('content.blocks.deleted'), 'success')
    } catch (error) {
      const key: MessageKey = error instanceof ContentError ? error.key : 'content.error.generic'
      notify(t(key), 'error')
    }
  }

  if (!canManage) {
    return (
      <UnauthorizedState
        title={t('content.forbidden.title')}
        description={t('content.forbidden.body')}
      />
    )
  }

  if (!pageId) {
    return (
      <EmptyState
        title={t('content.blocks.noPageTitle')}
        description={t('content.blocks.noPageBody')}
        icon={<ViewQuiltOutlinedIcon fontSize="small" />}
      />
    )
  }

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1.5} alignItems="center" justifyContent="space-between">
        <Typography sx={{ color: 'var(--muted)' }}>{t('content.blocks.help')}</Typography>
        <Button variant="contained" onClick={openCreate}>
          {t('content.blocks.new')}
        </Button>
      </Stack>

      <Card>
        {blocks.isPending && <TableSkeleton columns={5} />}
        {blocks.isError && <ErrorState error={blocks.error} onRetry={() => void blocks.refetch()} />}
        {!blocks.isPending && !blocks.isError && list.length === 0 && (
          <EmptyState
            title={t('content.blocks.emptyTitle')}
            description={t('content.blocks.emptyBody')}
            icon={<ViewQuiltOutlinedIcon fontSize="small" />}
            action={
              <Button variant="contained" onClick={openCreate}>
                {t('content.blocks.new')}
              </Button>
            }
          />
        )}
        {list.length > 0 && (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell align="right">#</TableCell>
                <TableCell>{t('content.blocks.type')}</TableCell>
                <TableCell>{t('content.blocks.title')}</TableCell>
                <TableCell>{t('content.blocks.state')}</TableCell>
                <TableCell align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {list.map((row, index) => (
                <TableRow key={row.id} hover>
                  <TableCell align="right">{row.position}</TableCell>
                  <TableCell>{t(`content.block.${row.block_type}` as MessageKey)}</TableCell>
                  <TableCell>{row.title ?? '—'}</TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      label={t(row.is_active ? 'content.blocks.active' : 'content.blocks.inactive')}
                      color={row.is_active ? 'primary' : 'default'}
                    />
                  </TableCell>
                  <TableCell align="right">
                    <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                      <Button
                        size="small"
                        disabled={index === 0 || move.isPending}
                        onClick={() =>
                          void move.mutateAsync({ id: row.id, position: Math.max(row.position - 1, 0) })
                        }
                        aria-label={`${t('content.blocks.up')} ${row.title ?? row.block_type}`}
                      >
                        {t('content.blocks.up')}
                      </Button>
                      <Button
                        size="small"
                        disabled={index === list.length - 1 || move.isPending}
                        onClick={() =>
                          void move.mutateAsync({ id: row.id, position: row.position + 1 })
                        }
                        aria-label={`${t('content.blocks.down')} ${row.title ?? row.block_type}`}
                      >
                        {t('content.blocks.down')}
                      </Button>
                      {blockAcceptsItems(row.block_type) && (
                        <Button size="small" onClick={() => setItemsFor(row)}>
                          {t('content.items.manage')}
                        </Button>
                      )}
                      <Button size="small" onClick={() => openEdit(row)}>
                        {t('common.edit')}
                      </Button>
                      <Button size="small" color="error" onClick={() => void drop(row)}>
                        {t('common.delete')}
                      </Button>
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <FormDrawer
        open={open}
        title={editing ? t('content.blocks.edit') : t('content.blocks.new')}
        onClose={() => setOpen(false)}
        busy={save.isPending}
        width={620}
        actions={
          <>
            <Button onClick={() => setOpen(false)} disabled={save.isPending}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="contained"
              onClick={() => void submit()}
              disabled={!parsed.success || issues.length > 0 || save.isPending}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        <Stack spacing={2}>
          <TextField
            select
            label={t('content.blocks.type')}
            value={form.block_type}
            onChange={(event) =>
              setForm({ ...form, block_type: event.target.value as BlockFormValues['block_type'] })
            }
          >
            {CONTENT_BLOCK_TYPES.map((type) => (
              <MenuItem key={type} value={type}>
                {t(`content.block.${type}` as MessageKey)}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            label={t('content.blocks.title')}
            value={form.title}
            onChange={(event) => setForm({ ...form, title: event.target.value })}
          />
          <TextField
            label={t('content.blocks.subtitle')}
            value={form.subtitle}
            onChange={(event) => setForm({ ...form, subtitle: event.target.value })}
          />
          {/* El bloque APUNTA a la campaña; la campaña no sabe que existe el
              bloque. Se enseña su estado efectivo al lado del nombre porque
              anunciar una campaña caducada es un error caro y silencioso, y el
              desplegable es donde se ve. Lo que NUNCA sale a la vitrina es el
              código del cupón: eso sería regalar el folleto. */}
          {form.block_type === 'campaign' && (
            <TextField
              select
              label={t('content.blocks.promotion')}
              value={form.promotion_id ?? ''}
              helperText={t('content.blocks.promotionHelp')}
              onChange={(event) =>
                setForm({ ...form, promotion_id: event.target.value || null })
              }
            >
              <MenuItem value="">{t('content.blocks.promotionNone')}</MenuItem>
              {(promotions.data ?? []).map((promotion) => (
                <MenuItem key={promotion.id} value={promotion.id}>
                  {`${promotion.name} · ${t(
                    `content.status.${promotion.effective_status}` as MessageKey,
                  )}`}
                </MenuItem>
              ))}
            </TextField>
          )}
          <TextField
            label={t('content.blocks.body')}
            value={form.body}
            onChange={(event) => setForm({ ...form, body: event.target.value })}
            multiline
            minRows={5}
            helperText={t('content.blocks.bodyHelp')}
          />
          <TextField
            label={t('content.blocks.ctaLabel')}
            value={form.cta_label}
            onChange={(event) => setForm({ ...form, cta_label: event.target.value })}
          />
          <TextField
            label={t('content.blocks.ctaHref')}
            value={form.cta_href}
            onChange={(event) => setForm({ ...form, cta_href: event.target.value })}
            helperText={t('content.blocks.ctaHrefHelp')}
          />
          <TextField
            label={t('content.blocks.mediaAlt')}
            value={form.media_alt}
            onChange={(event) => setForm({ ...form, media_alt: event.target.value })}
            helperText={t('content.blocks.mediaAltHelp')}
          />
          <TextField
            type="number"
            label={t('content.blocks.columns')}
            value={form.columns}
            onChange={(event) => setForm({ ...form, columns: Number(event.target.value) })}
          />
          <TextField
            type="number"
            label={t('content.blocks.itemLimit')}
            value={form.item_limit}
            onChange={(event) => setForm({ ...form, item_limit: Number(event.target.value) })}
          />
          <TextField
            type="datetime-local"
            label={t('content.pages.from')}
            value={form.publish_from}
            onChange={(event) => setForm({ ...form, publish_from: event.target.value })}
            InputLabelProps={{ shrink: true }}
          />
          <TextField
            type="datetime-local"
            label={t('content.pages.to')}
            value={form.publish_to}
            onChange={(event) => setForm({ ...form, publish_to: event.target.value })}
            InputLabelProps={{ shrink: true }}
          />
          <Stack direction="row" spacing={1} alignItems="center">
            <Switch
              checked={form.is_active}
              onChange={(event) => setForm({ ...form, is_active: event.target.checked })}
              inputProps={{ 'aria-label': t('content.blocks.active') }}
            />
            <Typography sx={{ fontWeight: 700 }}>{t('content.blocks.active')}</Typography>
          </Stack>
          {firstIssue && (
            <Typography sx={{ color: 'var(--red)', fontWeight: 700, fontSize: 12 }}>
              {t(firstIssue as MessageKey)}
            </Typography>
          )}
        </Stack>
      </FormDrawer>

      <CollectionDrawer block={itemsFor} onClose={() => setItemsFor(null)} />
    </Stack>
  )
}

/**
 * Los productos de una colección: se buscan y se añaden.
 *
 * El buscador es el `SearchPort` del backoffice, así que encuentra también lo
 * NO publicado — y lo marca. Poder añadir a la portada un producto todavía en
 * borrador es deliberado: se prepara la campaña antes de publicar el catálogo,
 * y la vitrina no lo enseñará hasta que lo esté porque la resolución lee de
 * `public_products`.
 */
function CollectionDrawer({
  block,
  onClose,
}: {
  block: ContentBlockRow | null
  onClose: () => void
}) {
  const { t } = useI18n()
  const { notify } = useFeedback()
  const { activeStore, tenant, activeCompanyId } = useTenant()
  const [term, setTerm] = useState('')
  const search = useDebouncedValue(term, 300)

  const items = useBlockItems(block?.id ?? null)
  const results = useAdminCatalogSearch(activeStore?.id ?? null, search, block !== null)

  const scope = useMemo(
    () =>
      tenant && activeCompanyId && activeStore
        ? {
            organizationId: tenant.organization_id,
            companyId: activeCompanyId,
            storeId: activeStore.id,
          }
        : null,
    [tenant, activeCompanyId, activeStore],
  )

  const add = useAddBlockItem(scope)
  const drop = useRemoveBlockItem()

  const current = items.data ?? []

  async function attach(productId: string) {
    if (!block) return
    try {
      await add.mutateAsync({
        blockId: block.id,
        blockType: block.block_type,
        itemKind: block.block_type === 'category_collection' ? 'category' : 'product',
        productId: block.block_type === 'category_collection' ? null : productId,
        categoryId: block.block_type === 'category_collection' ? productId : null,
        position: current.length,
      })
      notify(t('content.items.added'), 'success')
    } catch (error) {
      const key: MessageKey = error instanceof ContentError ? error.key : 'content.error.generic'
      notify(t(key), 'error')
    }
  }

  return (
    <FormDrawer
      open={block !== null}
      title={t('content.items.title')}
      subtitle={block?.title ?? undefined}
      onClose={onClose}
      width={620}
      actions={<Button onClick={onClose}>{t('common.close')}</Button>}
    >
      <Stack spacing={2}>
        <Typography sx={{ color: 'var(--muted)' }}>{t('content.items.help')}</Typography>

        <Box>
          <Typography sx={{ fontWeight: 800, mb: 1 }}>{t('content.items.current')}</Typography>
          {current.length === 0 ? (
            <Typography sx={{ color: 'var(--muted)' }}>{t('content.items.empty')}</Typography>
          ) : (
            <Stack spacing={0.5}>
              {current.map((item) => (
                <Stack
                  key={item.id}
                  direction="row"
                  spacing={1}
                  alignItems="center"
                  justifyContent="space-between"
                >
                  <Typography sx={{ fontSize: 12 }}>
                    {`${item.position}. ${item.product_id ?? item.category_id ?? ''}`}
                  </Typography>
                  <Button size="small" color="error" onClick={() => void drop.mutateAsync(item.id)}>
                    {t('common.delete')}
                  </Button>
                </Stack>
              ))}
            </Stack>
          )}
        </Box>

        <Divider />

        <SearchField
          value={term}
          onChange={setTerm}
          placeholder={t('content.items.search')}
          ariaLabel={t('content.items.search')}
        />

        {results.data && results.data.items.length > 0 && (
          <Stack spacing={0.5}>
            {results.data.items.map((hit) => (
              <Stack
                key={hit.productId}
                direction="row"
                spacing={1}
                alignItems="center"
                justifyContent="space-between"
              >
                <Box>
                  <Typography sx={{ fontWeight: 700, fontSize: 13 }}>{hit.name}</Typography>
                  <Typography sx={{ fontSize: 11, color: 'var(--muted)' }}>
                    {hit.published ? t('content.items.published') : t('content.items.draft')}
                  </Typography>
                </Box>
                <Button size="small" onClick={() => void attach(hit.productId)}>
                  {t('content.items.add')}
                </Button>
              </Stack>
            ))}
          </Stack>
        )}
        {results.data && results.data.mode === 'empty' && search.trim().length >= 2 && (
          <Typography sx={{ color: 'var(--muted)' }}>{t('content.items.noResults')}</Typography>
        )}
      </Stack>
    </FormDrawer>
  )
}
