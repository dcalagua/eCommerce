/**
 * La cara de una familia del catalogo.
 *
 * Vive fuera de los componentes porque la usan dos: la barra de navegacion y
 * las puertas de la portada. Tenerla dentro de la barra obligaba a la portada a
 * importar de un componente de cabecera para pintar una tarjeta.
 */
import CategoryRoundedIcon from '@mui/icons-material/CategoryRounded'
import ChildCareRoundedIcon from '@mui/icons-material/ChildCareRounded'
import ContentCutRoundedIcon from '@mui/icons-material/ContentCutRounded'
import ElderlyRoundedIcon from '@mui/icons-material/ElderlyRounded'
import HealingRoundedIcon from '@mui/icons-material/HealingRounded'
import LocalPharmacyRoundedIcon from '@mui/icons-material/LocalPharmacyRounded'
import MedicalServicesRoundedIcon from '@mui/icons-material/MedicalServicesRounded'
import MonitorHeartRoundedIcon from '@mui/icons-material/MonitorHeartRounded'
import PsychologyRoundedIcon from '@mui/icons-material/PsychologyRounded'
import SanitizerRoundedIcon from '@mui/icons-material/SanitizerRounded'
import SpaRoundedIcon from '@mui/icons-material/SpaRounded'
import VaccinesRoundedIcon from '@mui/icons-material/VaccinesRounded'
import VisibilityRoundedIcon from '@mui/icons-material/VisibilityRounded'
import WaterDropRoundedIcon from '@mui/icons-material/WaterDropRounded'
import type { ComponentType } from 'react'

/**
 * La cara de cada familia.
 *
 * Se elige por PALABRA del nombre: el comercio no tiene dónde declarar un
 * icono, y pedirle que lo rellene para que su tienda no se vea gris es cobrarle
 * nuestro problema. Sin coincidencia va el icono genérico — aquí sí, porque en
 * una barra de ocho entradas el hueco vacío descuadra la fila entera.
 */
const ICONOS: readonly (readonly [readonly string[], ComponentType<{ sx?: object }>])[] = [
  [['medicamento', 'farmac', 'etico', 'generico', 'drug'], LocalPharmacyRoundedIcon],
  [['vitamina', 'suplemento', 'nutric', 'vitamin'], VaccinesRoundedIcon],
  [['dermo', 'cosmet', 'piel', 'facial', 'skin'], SpaRoundedIcon],
  [['bebe', 'infantil', 'nino', 'mama', 'baby'], ChildCareRoundedIcon],
  [['adulto mayor', 'geriatr', 'senior'], ElderlyRoundedIcon],
  [['dispositivo', 'equipo', 'instrumental', 'device'], MedicalServicesRoundedIcon],
  [['higiene', 'limpieza', 'antisep', 'hygiene'], SanitizerRoundedIcon],
  [['belleza', 'maquillaje', 'beauty'], SpaRoundedIcon],
  [['afeitad', 'cabello', 'capilar', 'shav', 'hair'], ContentCutRoundedIcon],
  [['cuidado', 'personal', 'care'], HealingRoundedIcon],
  [['cardio', 'presion', 'corazon', 'diabet', 'heart'], MonitorHeartRoundedIcon],
  [['nervioso', 'neuro', 'psiq', 'sueno', 'nerve'], PsychologyRoundedIcon],
  [['desodorante', 'antitranspirante', 'deo'], WaterDropRoundedIcon],
  [['ocular', 'oftalm', 'ojo', 'vision', 'eye'], VisibilityRoundedIcon],
]

export function iconoDe(nombre: string): ComponentType<{ sx?: object }> {
  const limpio = nombre
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
  for (const [palabras, Icono] of ICONOS) {
    if (palabras.some((palabra) => limpio.includes(palabra))) return Icono
  }
  return CategoryRoundedIcon
}
