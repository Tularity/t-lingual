/**
 * What a signed-in browser is — Chrome, on Windows — read from the
 * user-agent string the server recorded, for the interface to name in the
 * reader's language. A string that is not a browser's is kept as it came,
 * shortened.
 */
export function describeDevice(userAgent: string): { browser: string; system: string } | { raw: string } {
  const agent = userAgent.trim()
  const raw = agent.length > 60 ? `${agent.slice(0, 59)}…` : agent
  if (!/Mozilla\/|AppleWebKit|Gecko\//u.test(agent)) return { raw }
  const browser = /Edg(?:A|iOS)?\//u.test(agent) ? 'Edge'
    : /OPR\/|Opera/u.test(agent) ? 'Opera'
    : /SamsungBrowser\//u.test(agent) ? 'Samsung Internet'
    : /Firefox\/|FxiOS\//u.test(agent) ? 'Firefox'
    : /Chrome\/|CriOS\//u.test(agent) ? 'Chrome'
    : /Safari\//u.test(agent) ? 'Safari'
    : ''
  const system = /iPhone/u.test(agent) ? 'iPhone'
    : /iPad/u.test(agent) ? 'iPad'
    : /Android/u.test(agent) ? 'Android'
    : /Windows/u.test(agent) ? 'Windows'
    : /Mac OS X|Macintosh/u.test(agent) ? 'macOS'
    : /CrOS/u.test(agent) ? 'ChromeOS'
    : /Linux/u.test(agent) ? 'Linux'
    : ''
  return browser && system ? { browser, system } : { raw: browser || system || raw }
}
