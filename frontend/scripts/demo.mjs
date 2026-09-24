// Explicit opt-in. Production builds always remove the mock implementation.
import { createServer } from 'vite'
process.env.VITE_USE_MOCK_API = 'true'
const server = await createServer({ mode: 'development', server: { host: '0.0.0.0', port: Number(process.env.PORT || 5173), strictPort: true } })
await server.listen()
server.printUrls()
