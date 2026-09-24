import type { CreateCodeInput } from '../api/contracts'

/** Keep the payload bound to the server's scoped administrative authorization. */
export async function codeCreateScope(input:CreateCodeInput) {
  const payload=`${input.kind}|${input.targetUserId??''}|${input.notBefore??''}|${input.expiresAt??''}|${input.ttlSeconds??0}`
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(payload))
  return `admin:code:create:${Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('')}`
}
