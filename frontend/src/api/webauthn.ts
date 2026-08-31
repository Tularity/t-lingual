import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  SerializedCredential,
} from './contracts'

export function base64UrlToArrayBuffer(value: string): ArrayBuffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = window.atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes.buffer
}

export function arrayBufferToBase64Url(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value)
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
}

export function decodeCreationOptions(options: PublicKeyCredentialCreationOptionsJSON): PublicKeyCredentialCreationOptions {
  return {
    ...options,
    challenge: base64UrlToArrayBuffer(options.challenge),
    user: { ...options.user, id: base64UrlToArrayBuffer(options.user.id) },
    excludeCredentials: options.excludeCredentials?.map((credential) => ({
      ...credential,
      id: base64UrlToArrayBuffer(credential.id),
    })),
  }
}

export function decodeRequestOptions(options: PublicKeyCredentialRequestOptionsJSON): PublicKeyCredentialRequestOptions {
  return {
    ...options,
    challenge: base64UrlToArrayBuffer(options.challenge),
    allowCredentials: options.allowCredentials?.map((credential) => ({
      ...credential,
      id: base64UrlToArrayBuffer(credential.id),
    })),
  }
}

export function serializeCredential(credential: PublicKeyCredential): SerializedCredential {
  const common = {
    id: credential.id,
    rawId: arrayBufferToBase64Url(credential.rawId),
    type: 'public-key' as const,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
  }
  if (credential.response instanceof AuthenticatorAttestationResponse) {
    return {
      ...common,
      response: {
        clientDataJSON: arrayBufferToBase64Url(credential.response.clientDataJSON),
        attestationObject: arrayBufferToBase64Url(credential.response.attestationObject),
        transports: credential.response.getTransports?.() ?? [],
      },
    }
  }
  if (credential.response instanceof AuthenticatorAssertionResponse) {
    return {
      ...common,
      response: {
        clientDataJSON: arrayBufferToBase64Url(credential.response.clientDataJSON),
        authenticatorData: arrayBufferToBase64Url(credential.response.authenticatorData),
        signature: arrayBufferToBase64Url(credential.response.signature),
        userHandle: credential.response.userHandle ? arrayBufferToBase64Url(credential.response.userHandle) : null,
      },
    }
  }
  throw new Error('Unsupported passkey response type')
}

function requirePasskeySupport() {
  if (!window.isSecureContext || !('PublicKeyCredential' in window) || !navigator.credentials) {
    throw new Error('Passkeys require a supported browser and a secure HTTPS connection.')
  }
}

export async function createPasskey(options: PublicKeyCredentialCreationOptionsJSON): Promise<SerializedCredential> {
  requirePasskeySupport()
  const credential = await navigator.credentials.create({ publicKey: decodeCreationOptions(options) })
  if (!(credential instanceof PublicKeyCredential)) throw new Error('Passkey creation was cancelled.')
  return serializeCredential(credential)
}

export async function getPasskey(options: PublicKeyCredentialRequestOptionsJSON): Promise<SerializedCredential> {
  requirePasskeySupport()
  const credential = await navigator.credentials.get({ publicKey: decodeRequestOptions(options) })
  if (!(credential instanceof PublicKeyCredential)) throw new Error('Passkey sign-in was cancelled.')
  return serializeCredential(credential)
}
