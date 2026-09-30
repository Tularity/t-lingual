// Explicit opt-in. Production builds always remove the mock implementation.
import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { createServer as createTlsServer } from 'node:tls'
import { createServer } from 'vite'
import { demoOperations } from './demo-operations.mjs'

process.env.VITE_USE_MOCK_API = 'true'
const port = Number(process.env.PORT || 5173)
const server = await createServer({ mode: 'development', plugins: [demoOperations()], server: { host: '0.0.0.0', port, strictPort: true } })
await server.listen()
server.printUrls()

// Another device on the network reaches the demo over HTTPS: the clipboard,
// the Web Crypto API and the microphone exist only in a secure context, which
// plain HTTP is only on this machine's own localhost. TLS ends here and the
// bytes go on to the HTTP server unchanged, so pages and the live-reload
// socket behave exactly as they do over HTTP.
const { DEMO_TLS_CERT: certFile, DEMO_TLS_KEY: keyFile } = process.env
if (certFile && keyFile) {
  const httpsPort = Number(process.env.HTTPS_PORT || 5174)
  const tls = createTlsServer({ cert: readFileSync(certFile), key: readFileSync(keyFile) }, (secure) => {
    const plain = connect(port, '127.0.0.1')
    const drop = () => { secure.destroy(); plain.destroy() }
    secure.on('error', drop)
    plain.on('error', drop)
    secure.pipe(plain).pipe(secure)
  })
  // A client that never finishes its handshake is its own problem, not the demo's.
  tls.on('tlsClientError', (_error, socket) => socket.destroy())
  tls.listen(httpsPort, '0.0.0.0', () => console.log(`  ➜  HTTPS:   port ${httpsPort}`))
}
