// @vitest-environment node
/**
 * Proxy del Platform Context API (contrato §5) — la parte que se puede probar
 * sin desplegar.
 *
 * Lo que se protege aquí es la frontera de entrada de datos AJENOS. La
 * respuesta del hub decide qué módulos ve un cliente, así que una lectura
 * indulgente —«si no viene `app_active`, será que sí»— se traduce en módulos
 * regalados o en módulos apagados a quien pagó por ellos.
 */
import { describe, expect, it } from 'vitest'
import {
  contextMode,
  hubContextUrl,
  parseProvisioningSync,
  syncFromHubContext,
} from '../functions/_shared/platform-context.ts'

const ORG = '0a000000-0000-4000-8000-000000000001'
const COMPANY_PE = '0a000000-0000-4000-8000-0000000000c1'
const COMPANY_CO = '0a000000-0000-4000-8000-0000000000c2'
const OTRA_ORG = '0b000000-0000-4000-8000-000000000002'

/** La forma EXACTA que documenta el contrato §5. */
function hubResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    organization: { id: ORG, name: 'Cuenta de prueba', plan: 'enterprise' },
    companies: [
      { id: COMPANY_PE, name: 'Sociedad PE', country: 'PE', config: {} },
      { id: COMPANY_CO, name: 'Sociedad CO', country: 'CO', config: {} },
    ],
    addons: {
      [COMPANY_PE]: ['ecommerce.payments'],
      [COMPANY_CO]: ['ecommerce.payments', 'ecommerce.pricing.lists'],
    },
    app_active: true,
    ...overrides,
  }
}

function message(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('Se esperaba un fallo y no lo hubo')
}

describe('lectura de la respuesta del hub', () => {
  it('produce una fila por sociedad, con sus addons ordenados', () => {
    const rows = syncFromHubContext(hubResponse(), ORG)

    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.companyId).sort()).toEqual([COMPANY_PE, COMPANY_CO].sort())
    const co = rows.find((r) => r.companyId === COMPANY_CO)
    expect(co?.entitlements).toEqual(['ecommerce.payments', 'ecommerce.pricing.lists'])
    expect(co?.plan).toBe('enterprise')
    expect(co?.source).toBe('hub')
    expect(co?.appActive).toBe(true)
  })

  /**
   * Una URL mal configurada, una caché intermedia o un fallo del propio hub
   * pueden devolver otra organización. Escribirla sería darle a un tenant los
   * módulos de otro, y sería además muy difícil de ver después.
   */
  it('rechaza una respuesta que no es de la organizacion del token', () => {
    expect(message(() => syncFromHubContext(hubResponse(), OTRA_ORG))).toMatch(
      /la organizacion devuelta no es la del token/,
    )
  })

  /**
   * Aquí SÍ hablamos con el hub, así que un silencio sobre si la app está
   * activa es una respuesta incompleta, no un permiso. Es lo contrario del
   * criterio de la base para «nunca sincronizamos», y a propósito.
   */
  it('`app_active` ausente se lee como NO activa', () => {
    const rows = syncFromHubContext(hubResponse({ app_active: undefined }), ORG)
    expect(rows.every((r) => r.appActive === false)).toBe(true)
  })

  it('una sociedad sin addons queda con la lista vacia, no se pierde', () => {
    const rows = syncFromHubContext(hubResponse({ addons: {} }), ORG)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.entitlements.length === 0)).toBe(true)
  })

  /**
   * El hub puede activar un addon a una sociedad que no listó en `companies`.
   * Perder esa fila sería dejar sin un módulo a quien sí lo compró.
   */
  it('una sociedad que solo aparece en `addons` cuenta igual', () => {
    const rows = syncFromHubContext(
      hubResponse({ companies: [], addons: { [COMPANY_PE]: ['ecommerce.payments'] } }),
      ORG,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.companyId).toBe(COMPANY_PE)
  })

  it('descarta duplicados y normaliza a minusculas', () => {
    const rows = syncFromHubContext(
      hubResponse({
        addons: { [COMPANY_PE]: ['ecommerce.payments', 'ECOMMERCE.PAYMENTS'] },
        companies: [{ id: COMPANY_PE }],
      }),
      ORG,
    )
    expect(rows[0]?.entitlements).toEqual(['ecommerce.payments'])
  })

  it('un codigo de addon con forma invalida corta en vez de colarse', () => {
    expect(
      message(() =>
        syncFromHubContext(
          hubResponse({ addons: { [COMPANY_PE]: ['no es un codigo'] }, companies: [{ id: COMPANY_PE }] }),
          ORG,
        ),
      ),
    ).toMatch(/codigo de addon invalido/)
  })

  it('una respuesta que no tiene la forma del contrato no se adivina', () => {
    expect(message(() => syncFromHubContext(null, ORG))).toMatch(/no es un objeto/)
    expect(message(() => syncFromHubContext([], ORG))).toMatch(/no es un objeto/)
    expect(message(() => syncFromHubContext({ organization: {} }, ORG))).toMatch(
      /organization.*id.*ausente|no es uuid/,
    )
    expect(
      message(() => syncFromHubContext(hubResponse({ addons: ['no', 'es', 'mapa'] }), ORG)),
    ).toMatch(/addons/)
  })

  it('un plan ausente no es un plan vacio: es null', () => {
    const rows = syncFromHubContext(hubResponse({ organization: { id: ORG } }), ORG)
    expect(rows.every((r) => r.plan === null)).toBe(true)
  })
})

describe('camino de aprovisionamiento del operador', () => {
  it('lee el tenant del cuerpo, porque no hay token del que derivarlo', () => {
    const row = parseProvisioningSync({
      organization_id: ORG,
      company_id: COMPANY_PE,
      entitlements: ['ecommerce.payments'],
      plan: 'piloto',
    })
    expect(row).toEqual({
      organizationId: ORG,
      companyId: COMPANY_PE,
      appActive: true,
      plan: 'piloto',
      entitlements: ['ecommerce.payments'],
      source: 'provisioning',
    })
  })

  /**
   * Nunca se confunde con el hub: el diagnóstico enseña el origen, y «lo cargó
   * el operador» y «lo dijo el hub» no se responden igual en una incidencia.
   */
  it('siempre se marca como `provisioning`', () => {
    const row = parseProvisioningSync({ organization_id: ORG, company_id: COMPANY_PE })
    expect(row.source).toBe('provisioning')
    expect(row.entitlements).toEqual([])
  })

  it('rechaza lo que no es un uuid de tenant', () => {
    expect(message(() => parseProvisioningSync({ organization_id: '1000', company_id: COMPANY_PE })))
      .toMatch(/organization_id/)
    expect(message(() => parseProvisioningSync({ organization_id: ORG, company_id: 'PE01' })))
      .toMatch(/company_id/)
  })

  it('rechaza un codigo de addon con forma invalida', () => {
    expect(
      message(() =>
        parseProvisioningSync({
          organization_id: ORG,
          company_id: COMPANY_PE,
          entitlements: ['Ecommerce Payments'],
        }),
      ),
    ).toMatch(/ENTITLEMENT_INVALIDO|codigo de addon/)
  })

  it('rechaza `app_active` que no es booleano', () => {
    expect(
      message(() =>
        parseProvisioningSync({
          organization_id: ORG,
          company_id: COMPANY_PE,
          app_active: 'si',
        }),
      ),
    ).toMatch(/app_active/)
  })
})

describe('transporte', () => {
  it('el modo lo decide la cabecera, no el cuerpo', () => {
    const conClave = new Request('https://x.test', {
      headers: { 'x-ebim-provisioning-key': 'clave' },
    })
    expect(contextMode(conClave)).toBe('provisioning')
    expect(contextMode(new Request('https://x.test'))).toBe('session')
  })

  /**
   * La credencial va en cabecera y JAMÁS en la URL: una URL queda en logs, en
   * el `Referer` y en cualquier proxy por el que pase.
   */
  it('la URL lleva el org_id y la app, nunca la credencial', () => {
    const url = hubContextUrl('https://hub.test/functions/v1/platform-context', ORG, 'ecommerce')
    expect(url).toContain(`org_id=${ORG}`)
    expect(url).toContain('app=ecommerce')
    expect(url).toContain('/functions/v1/platform-context')
    expect(url.toLowerCase()).not.toMatch(/key|token|secret|authorization/)
  })
})
