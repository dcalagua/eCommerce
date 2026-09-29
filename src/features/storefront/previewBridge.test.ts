import { describe, expect, it } from 'vitest'
import { PREVIEW_FIELDS, isStorePreview, sanitizePreviewOverrides } from './previewBridge'

describe('el puente de la vista previa (Resumen v2)', () => {
  it('solo deja pasar campos de presentación: ni tienda, ni ids, ni precios', () => {
    const limpio = sanitizePreviewOverrides({
      theme_preset: 'retail',
      accent_color: '#d71a28',
      store_id: 'otra-tienda',
      price: '0.01',
      organization_id: 'x',
    })
    expect(limpio).toEqual({ theme_preset: 'retail', accent_color: '#d71a28' })
  })

  it('lo que no es un objeto no pisa nada', () => {
    expect(sanitizePreviewOverrides(null)).toEqual({})
    expect(sanitizePreviewOverrides('theme_preset=retail')).toEqual({})
    expect(sanitizePreviewOverrides(['theme_preset'])).toEqual({})
  })

  it('la lista blanca no incluye nada que identifique la tienda', () => {
    for (const campo of PREVIEW_FIELDS) {
      expect(campo).not.toMatch(/(^|_)id$|slug|store_id|organization|company|price/)
    }
  })

  it('fuera de un iframe la vitrina nunca está en modo vista previa', () => {
    // En los tests `window.parent === window`, como en una pestaña normal.
    window.history.replaceState(null, '', '/s/tienda?vista_previa=1')
    expect(isStorePreview()).toBe(false)
  })
})
