import { arrayBufferToBase64Url, base64UrlToArrayBuffer, decodeCreationOptions, decodeRequestOptions } from './webauthn'

describe('WebAuthn base64url conversion', () => {
  it('round-trips binary without base64 padding', () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 250, 255])
    const encoded = arrayBufferToBase64Url(bytes.buffer)
    expect(encoded).not.toMatch(/[+/=]/u)
    expect(new Uint8Array(base64UrlToArrayBuffer(encoded))).toEqual(bytes)
  })

  it('decodes creation challenge, user and excluded credential IDs', () => {
    const result = decodeCreationOptions({
      challenge: 'AQI', rp: { name: 'T Lingual' }, user: { id: 'AwQ', name: 'test', displayName: 'Test' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }], excludeCredentials: [{ type: 'public-key', id: 'BQY' }],
    })
    expect([...new Uint8Array(result.challenge as ArrayBuffer)]).toEqual([1, 2])
    expect([...new Uint8Array(result.user.id as ArrayBuffer)]).toEqual([3, 4])
    expect([...new Uint8Array(result.excludeCredentials?.[0]?.id as ArrayBuffer)]).toEqual([5, 6])
  })

  it('decodes assertion allowCredential IDs', () => {
    const result = decodeRequestOptions({ challenge: 'AQI', allowCredentials: [{ type: 'public-key', id: 'Bwg' }] })
    expect([...new Uint8Array(result.allowCredentials?.[0]?.id as ArrayBuffer)]).toEqual([7, 8])
  })
})
