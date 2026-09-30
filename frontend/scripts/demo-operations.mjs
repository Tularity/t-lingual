// Demo only: the monitoring the Go server does (internal/operations), done
// by the demo server so the demo's monitoring page shows the real services.
// It reads the recognition and translation services named by DEMO_ASR_URL
// and DEMO_TRANSLATOR_URL and the GPU through nvidia-smi, keeps the same
// history, and answers in the same shape as GET /api/v1/admin/operations.
// Only counts and states are read: no audio, text or client details.
import { execFile } from 'node:child_process'

const INTERVAL = 5_000
const HISTORY = 720
const DIAGNOSTICS_EVERY = 30_000
const LIMIT = 64 << 10

const asrURL = trimmed(process.env.DEMO_ASR_URL)
const translatorURL = trimmed(process.env.DEMO_TRANSLATOR_URL)

function trimmed(value) { return value ? value.replace(/\/+$/, '') : '' }

// The fields each report keeps, as the Go types declare them; anything else
// the services add is dropped rather than passed through.
const LOAD = { observed_at_ms: 1, ready: 1, can_accept_new_session: 1, admission_reason: 1, health: 1, asr_backend: 1,
  slots: { active: 1, free: 1, max: 1, rejected_total: 1 },
  queue: { sampled_sessions: 1, complete: 1, limit_ms: 1, pending_ms_p50: 1, pending_ms_p95: 1, pending_ms_max: 1, sessions_above_half_limit: 1, sessions_at_limit: 1 },
  pressure: { state: 1, signals: 1 },
  engine: { chunk_ms: 1, tick_ms_p50: 1, tick_ms_p95: 1, tick_ms_max: 1, tick_ms_avg: 1, batch_size_max: 1, active_slots: 1, fatal_errors_total: 1, vram_allocated_mb: 1 },
  worker: { alive: 1, last_tick_age_ms: 1, stalled: 1, tick_errors_total: 1 },
  event_loop: { lag_ms_p95: 1, saturated: 1 }, input_dropped_ms_total: 1, input_drop_age_ms: 1 }
const DIAGNOSTICS = { ws_ingest: { msg_per_sec: 1, mbytes: 1, cpu_ms_per_sec: 1 },
  engine: { decode_streams_total: 1, language_switch_total: 1, reset_stream_total: 1, force_barrier_total: 1, c_api_errors: 1 },
  diar: { enabled: 1, active_slots: 1, max_speakers: 1, step_ms_p50: 1, step_ms_p95: 1, budget_ms: 1 },
  embedding: { enabled: 1, model: 1, active_slots: 1, embeddings_total: 1 },
  vram: { live: { allocated_mb: 1, reserved_mb: 1, max_allocated_mb: 1, driver_used_mb: 1, driver_total_mb: 1 }, by_stage: [{ stage: 1, driver_used_mb: 1 }] },
  sessions: { max_slots: 1, active: 1, total_tracked: 1 } }
const STATUS = { status: 1, can_accept_now: 1, retry_after_seconds: 1, model: 1,
  capacity: { active: 1, active_limit: 1, queued: 1, queue_limit: 1, admitted: 1, admitted_limit: 1, available_admission: 1 },
  dependencies: { engine_ready: 1, detector_ready: 1 },
  engine_metrics: { available: 1, running: 1, waiting: 1, kv_cache_usage_ratio: 1 } }

function pick(value, shape) {
  if (Array.isArray(shape)) return Array.isArray(value) ? value.map((item) => pick(item, shape[0])) : null
  if (shape === 1) return value === undefined ? null : value
  if (!value || typeof value !== 'object') return null
  return Object.fromEntries(Object.entries(shape).map(([key, inner]) => [key, pick(value[key], inner)]))
}

async function getJSON(url, shape, accepted = [200]) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3_000), headers: { Accept: 'application/json' } })
  if (!accepted.includes(response.status)) throw new Error(`HTTP ${response.status}`)
  const text = await response.text()
  if (text.length > LIMIT) throw new Error('report exceeded the byte limit')
  return pick(JSON.parse(text), shape)
}

async function reading(configured, at, read) {
  if (!configured) return { configured: false, reachable: false, at, value: null }
  try { return { configured: true, reachable: true, at, value: await read() } }
  catch (error) { return { configured: true, reachable: false, error: String(error?.message ?? error).slice(0, 160), at, value: null } }
}

const GPU_FIELDS = ['index', 'name', 'driver_version', 'memory.total', 'memory.used', 'utilization.gpu', 'utilization.memory',
  'temperature.gpu', 'power.draw', 'power.limit', 'fan.speed', 'clocks.sm', 'clocks.mem', 'pstate']
let gpuCommand = 'nvidia-smi'

function sampleGPUs() {
  return new Promise((resolve, reject) => {
    execFile(gpuCommand, [`--query-gpu=${GPU_FIELDS.join(',')}`, '--format=csv,noheader,nounits'], { timeout: 4_000, maxBuffer: LIMIT }, (error, stdout) => {
      if (error) { if (error.code === 'ENOENT') gpuCommand = ''; reject(error); return }
      const number = (text) => { const value = Number.parseFloat(text); return Number.isFinite(value) ? value : null }
      resolve(stdout.trim().split('\n').filter(Boolean).map((line) => {
        const cells = line.split(',').map((cell) => cell.trim())
        if (cells.length !== GPU_FIELDS.length) throw new Error('unexpected GPU report')
        return { index: Number.parseInt(cells[0], 10), name: cells[1], driver: cells[2], memoryTotalMb: number(cells[3]), memoryUsedMb: number(cells[4]),
          utilization: number(cells[5]), memoryUtilization: number(cells[6]), temperatureC: number(cells[7]), powerDrawW: number(cells[8]),
          powerLimitW: number(cells[9]), fanSpeed: number(cells[10]), smClockMhz: number(cells[11]), memoryClockMhz: number(cells[12]), pstate: cells[13] }
      }))
    })
  })
}

const state = {
  sampledAt: new Date(0).toISOString(),
  asr: { configured: Boolean(asrURL), reachable: false, at: new Date(0).toISOString(), value: null },
  diagnostics: { configured: Boolean(asrURL), reachable: false, at: new Date(0).toISOString(), value: null },
  translator: { configured: Boolean(translatorURL), reachable: false, at: new Date(0).toISOString(), value: null },
  gpu: { configured: true, reachable: false, at: new Date(0).toISOString(), value: null },
  history: [],
}

async function sample() {
  const now = new Date()
  const at = now.toISOString()
  const diagnosticsDue = now - new Date(state.diagnostics.at) >= DIAGNOSTICS_EVERY
  const [load, diagnostics, status, gpu] = await Promise.all([
    reading(Boolean(asrURL), at, () => getJSON(`${asrURL}/v1/load`, LOAD, [200, 503])),
    diagnosticsDue ? reading(Boolean(asrURL), at, () => getJSON(`${asrURL}/v1/diag`, DIAGNOSTICS)) : null,
    reading(Boolean(translatorURL), at, () => getJSON(`${translatorURL}/v1/status`, STATUS)),
    gpuCommand ? reading(true, at, sampleGPUs) : null,
  ])
  Object.assign(state, { sampledAt: at, asr: load, translator: status })
  if (diagnostics) state.diagnostics = diagnostics
  if (gpu) state.gpu = gpu
  else if (!gpuCommand) state.gpu = { configured: false, reachable: false, at, value: null }
  const point = { t: at, asrUp: false, asrActive: null, asrMax: null, asrPendingP95: null, asrTickP95: null, asrLagP95: null, asrElevated: false,
    trUp: false, trActive: null, trQueued: null, trRunning: null, trWaiting: null, trKv: null,
    gpuUtil: null, gpuMemUsedMb: null, gpuMemTotalMb: null, gpuTempC: null, gpuPowerW: null, recordings: 0, watchers: 0 }
  const value = load.value
  if (value) {
    Object.assign(point, { asrUp: Boolean(value.ready), asrElevated: value.pressure?.state === 'elevated' })
    if (value.slots) Object.assign(point, { asrActive: value.slots.active, asrMax: value.slots.max })
    if (value.queue?.complete) point.asrPendingP95 = value.queue.pending_ms_p95
    if (value.engine) point.asrTickP95 = value.engine.tick_ms_p95
    if (value.event_loop) point.asrLagP95 = value.event_loop.lag_ms_p95
  }
  if (status.value) {
    const { status: name, capacity, engine_metrics: engine } = status.value
    Object.assign(point, { trUp: name === 'ready' || name === 'busy', trActive: capacity?.active ?? null, trQueued: capacity?.queued ?? null,
      trRunning: engine?.running ?? null, trWaiting: engine?.waiting ?? null, trKv: engine?.kv_cache_usage_ratio ?? null })
  }
  const device = gpu?.value?.[0]
  if (device) Object.assign(point, { gpuUtil: device.utilization, gpuMemUsedMb: device.memoryUsedMb, gpuMemTotalMb: device.memoryTotalMb, gpuTempC: device.temperatureC, gpuPowerW: device.powerDrawW })
  state.history.push(point)
  if (state.history.length > HISTORY) state.history.shift()
}

/** Whether recognition could take a recording now, as the Go server decides. */
function recognitionAvailable() {
  if (!asrURL) return false
  const { value, at } = state.asr
  const fresh = Date.now() - new Date(at) <= 3 * INTERVAL
  if (!fresh) return true // Not sampled yet: the server would ask directly; the demo lets it through.
  return Boolean(value?.ready && value?.can_accept_new_session)
}

function report() {
  return {
    snapshot: { sampledAt: state.sampledAt, intervalSeconds: INTERVAL / 1000, asr: state.asr, diagnostics: state.diagnostics,
      translator: state.translator, gpu: state.gpu, activity: { recordings: 0, watchers: 0, rooms: 0 }, history: state.history },
    backlog: { gapsPending: 0, gapsFilling: 0, gapsFailed: 0, translationsRetrying: 0 },
  }
}

export function demoOperations() {
  let timer
  return {
    name: 't-lingual-demo-operations',
    configureServer(server) {
      const run = () => { sample().catch((error) => server.config.logger.warn(`demo monitoring: ${error.message}`)) }
      run()
      timer = setInterval(run, INTERVAL)
      server.httpServer?.once('close', () => clearInterval(timer))
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split('?')[0]
        if (request.method !== 'GET' || (path !== '/__demo/operations' && path !== '/__demo/recognition')) { next(); return }
        response.setHeader('Content-Type', 'application/json')
        response.setHeader('Cache-Control', 'no-store')
        response.end(JSON.stringify(path === '/__demo/operations' ? report() : { available: recognitionAvailable() }))
      })
    },
  }
}
