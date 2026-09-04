import { Box, Skeleton, Stack } from '@mui/material'

/**
 * El esqueleto de la portada.
 *
 * ## Por qué existe
 *
 * Al recargar se veía la portada VIEJA y un segundo después la nueva: primero
 * el hero de reserva —el lema del comercio, que no necesita datos— y al llegar
 * las ofertas, el hero real. Dos portadas seguidas en la misma carga se leen
 * como un fallo, y además invitan a pulsar algo que va a moverse.
 *
 * Con el esqueleto no hay dos versiones: hay una carga que se ve, y termina en
 * la portada de verdad. La forma imita la que viene —hero ancho, franja de
 * cuatro, dos columnas— para que al llegar los datos nada salte de sitio.
 */
export function StoreLandingSkeleton() {
  return (
    <Stack sx={{ gap: { xs: 2, md: 3 } }} aria-hidden>
      <Skeleton
        variant="rounded"
        height={280}
        sx={{ borderRadius: 'var(--sf-radius)', transform: 'none' }}
      />

      <Skeleton
        variant="rounded"
        height={76}
        sx={{ borderRadius: 'var(--sf-radius)', transform: 'none' }}
      />

      <Box
        sx={{
          display: 'grid',
          gap: { xs: 2.5, md: 3 },
          gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 5fr) minmax(0, 7fr)' },
        }}
      >
        {[5, 7].map((peso) => (
          <Stack key={peso} sx={{ gap: 1.25 }}>
            <Skeleton variant="text" width={200} height={28} />
            <Box
              sx={{
                display: 'grid',
                gap: 1.25,
                gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
              }}
            >
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton
                  key={i}
                  variant="rounded"
                  height={peso === 5 ? 210 : 280}
                  sx={{ borderRadius: 'var(--sf-radius)', transform: 'none' }}
                />
              ))}
            </Box>
          </Stack>
        ))}
      </Box>
    </Stack>
  )
}
