import { api } from '../api/client'
import type { SerializedCredential } from '../api/contracts'
import { getPasskey } from '../api/webauthn'

const mockCredential: SerializedCredential = {
  id: 'mock-credential',
  rawId: 'bW9jaw',
  type: 'public-key',
  authenticatorAttachment: null,
  clientExtensionResults: {},
  response: { clientDataJSON: 'bW9jaw' },
}

export async function authorizePasskeyAction(scope?: string) {
  const begin = await (scope ? api.passkeys.authorizationBegin(scope) : api.passkeys.authorizationBegin())
  const credential = __TLINGUAL_DEVELOPMENT_MOCK__ ? mockCredential : await getPasskey(begin.options.publicKey)
  return api.passkeys.authorizationFinish(begin.ceremonyToken, credential)
}
