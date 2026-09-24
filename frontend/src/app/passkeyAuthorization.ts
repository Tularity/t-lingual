import { api } from '../api/client'
import type { SerializedCredential, PasskeyAuthorizationResponse } from '../api/contracts'
import { getPasskey } from '../api/webauthn'

const mockCredential: SerializedCredential = {
  id: 'mock-credential',
  rawId: 'bW9jaw',
  type: 'public-key',
  authenticatorAttachment: null,
  clientExtensionResults: {},
  response: { clientDataJSON: 'bW9jaw' },
}

let recoveryGrant: PasskeyAuthorizationResponse | null = null
export function setRecoveryAuthorization(grant:PasskeyAuthorizationResponse|null) { recoveryGrant=grant }
export function recoveryAuthorizationExpiresAt() { return recoveryGrant?.expiresAt ?? null }
export async function authorizePasskeyAction(scope?: string) {
  if(scope==='passkeys:add' && recoveryGrant) {
    const grant=recoveryGrant
    if(Date.parse(grant.expiresAt)>Date.now())return grant
    recoveryGrant=null
  }
  const begin = await (scope ? api.passkeys.authorizationBegin(scope) : api.passkeys.authorizationBegin())
  const credential = __TLINGUAL_DEVELOPMENT_MOCK__ ? mockCredential : await getPasskey(begin.options.publicKey)
  return api.passkeys.authorizationFinish(begin.ceremonyToken, credential)
}
