import AssignmentReturnRoundedIcon from '@mui/icons-material/AssignmentReturnRounded'
import BlockRoundedIcon from '@mui/icons-material/BlockRounded'
import CancelRoundedIcon from '@mui/icons-material/CancelRounded'
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded'
import ErrorRoundedIcon from '@mui/icons-material/ErrorRounded'
import HourglassEmptyRoundedIcon from '@mui/icons-material/HourglassEmptyRounded'
import Inventory2RoundedIcon from '@mui/icons-material/Inventory2Rounded'
import LocalShippingRoundedIcon from '@mui/icons-material/LocalShippingRounded'
import LockClockRoundedIcon from '@mui/icons-material/LockClockRounded'
import PaidRoundedIcon from '@mui/icons-material/PaidRounded'
import ReplayRoundedIcon from '@mui/icons-material/ReplayRounded'
import ScheduleRoundedIcon from '@mui/icons-material/ScheduleRounded'
import type { ReactNode } from 'react'
import type { FulfillmentStatus, OrderStatus, PaymentStatus } from './types'

/**
 * Un icono por estado.
 *
 * No es adorno: es el TERCER canal. La etiqueta ya lleva texto y color, pero el
 * color de esta paleta no separa —el validador deja `--red` y `--amber` en ΔE
 * 1,8 bajo deuteranopía—, así que quien recorre la columna en diagonal se apoya
 * en la silueta del icono antes que en el tono. Leer «pagado» y «pendiente» de
 * un vistazo deja de depender de distinguir dos verdes parecidos.
 *
 * La forma se repite entre ejes a propósito cuando el significado se repite: un
 * visto es «esto está hecho» valga para el pedido, para el cobro o para la
 * entrega. Aprender el vocabulario una vez y que sirva en las tres columnas es
 * justo lo que hace que la fila se lea rápido.
 */
export const STATUS_ICON: Record<OrderStatus, ReactNode> = {
  pending: <ScheduleRoundedIcon />,
  paid: <PaidRoundedIcon />,
  fulfilled: <CheckCircleRoundedIcon />,
  cancelled: <CancelRoundedIcon />,
  refunded: <ReplayRoundedIcon />,
}

export const PAYMENT_ICON: Record<PaymentStatus, ReactNode> = {
  pending: <ScheduleRoundedIcon />,
  authorized: <LockClockRoundedIcon />,
  paid: <CheckCircleRoundedIcon />,
  partially_refunded: <HourglassEmptyRoundedIcon />,
  refunded: <ReplayRoundedIcon />,
  failed: <ErrorRoundedIcon />,
  voided: <BlockRoundedIcon />,
}

export const FULFILLMENT_ICON: Record<FulfillmentStatus, ReactNode> = {
  unfulfilled: <Inventory2RoundedIcon />,
  in_progress: <LocalShippingRoundedIcon />,
  partially_fulfilled: <HourglassEmptyRoundedIcon />,
  fulfilled: <CheckCircleRoundedIcon />,
  returned: <AssignmentReturnRoundedIcon />,
  cancelled: <BlockRoundedIcon />,
}
