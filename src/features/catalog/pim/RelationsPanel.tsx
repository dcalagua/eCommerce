import { usePagedRows } from '@/shared/ui/usePagedRows'
import { TablePager } from '@/shared/ui/TablePager'
import {
  Alert,
  Button,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material'
import { useMemo, useState } from 'react'
import { useI18n } from '@/shared/i18n/i18n-context'
import type { MessageKey } from '@/shared/i18n/messages'
import { LoadingState } from '@/shared/ui/states'
import { useFeedback } from '@/shared/ui/feedback-context'
import { CatalogError } from '../api/errors'
import { PanelHint } from './VariantsPanel'
import { useAddRelation, useRelations } from './hooks'
import { PRODUCT_RELATION_KINDS, type ProductRelationKind } from './types'
import type { Product } from '../types'

const RELATION_LABEL: Record<ProductRelationKind, MessageKey> = {
  related: 'pim.relation.related',
  cross_sell: 'pim.relation.cross_sell',
  up_sell: 'pim.relation.up_sell',
  accessory: 'pim.relation.accessory',
  substitute: 'pim.relation.substitute',
  spare_part: 'pim.relation.spare_part',
}

/**
 * Relaciones entre productos: accesorio, sustituto, venta cruzada.
 *
 * La relación es DIRIGIDA a propósito y la pantalla no ofrece crear la inversa
 * automáticamente: el sustituto de un producto descatalogado es su reemplazo, y
 * lo contrario no es cierto. Crear el par sin preguntar llenaría el catálogo de
 * sugerencias que nadie escribió.
 */
export function RelationsPanel({
  product,
  products,
  organizationId,
  companyId,
  storeId,
  canWrite,
}: {
  product: Product | null
  products: Product[]
  organizationId: string
  companyId: string
  storeId: string
  canWrite: boolean
}) {
  const { t } = useI18n()
  const { notify } = useFeedback()

  const productId = product?.id ?? null
  const relations = useRelations(productId)
  const add = useAddRelation()

  const [target, setTarget] = useState('')
  const [kind, setKind] = useState<ProductRelationKind>('related')
  const [error, setError] = useState<MessageKey | null>(null)

  const byId = useMemo(() => new Map(products.map((item) => [item.id, item])), [products])
  const candidates = useMemo(
    () => products.filter((candidate) => candidate.id !== productId),
    [products, productId],
  )

  const list = relations.data ?? []
  // Pagina lo que YA esta cargado: es para poder leer la tabla, no para
  // aligerar la consulta. Va ANTES de la primera guarda con retorno,
  // porque un hook detras de un `return` cambia de orden entre renders.
  // Ver `usePagedRows`.
  const pager = usePagedRows(list)

  if (!product) {
    return <PanelHint title={t('pim.relations.title')} body={t('pim.relations.saveFirst')} />
  }

  if (relations.isPending) return <LoadingState />


  async function onAdd() {
    if (!product || !target) return
    setError(null)
    try {
      await add.mutateAsync({
        productId: product.id,
        relatedProductId: target,
        kind,
        scope: { organizationId, companyId, storeId },
      })
      notify(t('pim.toast.saved'))
      setTarget('')
    } catch (caught) {
      setError(caught instanceof CatalogError ? caught.key : 'catalog.error.generic')
    }
  }

  return (
    <Stack spacing={2}>
      <Typography component="h3" sx={{ fontSize: 15, fontWeight: 800 }}>
        {t('pim.relations.title')}
      </Typography>

      {error && <Alert severity="error">{t(error)}</Alert>}

      {canWrite && candidates.length > 0 && (
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
          <TextField
            select
            size="small"
            fullWidth
            label={t('pim.field.product')}
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          >
            <MenuItem value="">{t('common.none')}</MenuItem>
            {candidates.map((candidate) => (
              <MenuItem key={candidate.id} value={candidate.id}>
                {candidate.sku} · {candidate.name}
              </MenuItem>
            ))}
          </TextField>

          <TextField
            select
            size="small"
            fullWidth
            label={t('pim.field.relationKind')}
            value={kind}
            onChange={(event) => setKind(event.target.value as ProductRelationKind)}
          >
            {PRODUCT_RELATION_KINDS.map((value) => (
              <MenuItem key={value} value={value}>
                {t(RELATION_LABEL[value])}
              </MenuItem>
            ))}
          </TextField>

          <Button variant="outlined" disabled={!target || add.isPending} onClick={() => void onAdd()}>
            {t('common.add')}
          </Button>
        </Stack>
      )}

      {list.length === 0 ? (
        <Typography sx={{ color: 'var(--muted)' }}>{t('pim.relations.empty')}</Typography>
      ) : (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>{t('pim.field.product')}</TableCell>
              <TableCell>{t('pim.field.relationKind')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {pager.rows.map((relation) => (
              <TableRow key={relation.id} hover>
                <TableCell sx={{ fontWeight: 700 }}>
                  {byId.get(relation.related_product_id)?.name ?? t('common.none')}
                </TableCell>
                <TableCell sx={{ color: 'var(--muted)' }}>
                  {t(RELATION_LABEL[relation.relation_kind])}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {/* El paginador solo aparece cuando hay algo que paginar: un
          "0-0 de 0" bajo un estado vacio es ruido que contradice al
          propio estado vacio. */}
      {pager.total > 0 && (
        <TablePager
          page={pager.page}
          pageSize={pager.pageSize}
          total={pager.total}
          onPageChange={pager.setPage}
        />
      )}
    </Stack>
  )
}
