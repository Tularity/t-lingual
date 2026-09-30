import type { SiteSettings } from '../api/contracts'

export function normalizeHelpMarkdown(value:string) {return value.replace(/\r\n?/gu,'\n').replace(/[\u2028\u2029]/gu,'\n')}
export async function siteSettingsScope(input:SiteSettings) {
  const payload=JSON.stringify({registrationHelpMarkdown:input.registrationHelpMarkdown,codeAttemptsPerMinute:input.codeAttemptsPerMinute,draftTranslationIntervalMs:input.draftTranslationIntervalMs})
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(payload))
  return `admin:site-settings:update:${Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('')}`
}
