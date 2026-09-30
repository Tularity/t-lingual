/* Demo only. The demo server samples the real recognition and translation
 * services and the GPU they share (scripts/demo-operations.mjs) and serves
 * them at /__demo/operations; where it does not — a plain development
 * server, a test — a made-up picture stands in, marked as such. Imported by
 * the mock alone, so it never reaches a production build. */
import type { OperationsReport, OperationsSample } from './contracts'

export async function demoOperations(): Promise<OperationsReport & { simulated?: boolean }> {
  try {
    const response = await fetch('/__demo/operations', { headers: { Accept: 'application/json' } })
    if (response.ok && response.headers.get('content-type')?.includes('json')) return await response.json() as OperationsReport
  } catch { /* No demo server: the stand-in follows. */ }
  return { ...simulated(), simulated: true }
}

/** Whether the demo's real recognition service could take a recording now. */
export async function demoRecognitionAvailable(): Promise<boolean> {
  try {
    const response = await fetch('/__demo/recognition', { headers: { Accept: 'application/json' } })
    if (response.ok && response.headers.get('content-type')?.includes('json')) return Boolean(((await response.json()) as { available?: boolean }).available)
  } catch { /* No demo server: recording is simulated anyway. */ }
  return true
}

function simulated(): OperationsReport {
  const now = Date.now()
  const history: OperationsSample[] = Array.from({ length: 180 }, (_, index) => {
    const phase = index / 12
    const load = Math.max(0, Math.sin(phase) * 0.5 + 0.5)
    return {
      t: new Date(now - (179 - index) * 5000).toISOString(), asrUp: true, asrActive: Math.round(load * 6), asrMax: 64,
      asrPendingP95: Math.round(load * 180), asrTickP95: 120 + Math.round(load * 60), asrLagP95: 1 + load * 2, asrElevated: false,
      trUp: true, trActive: Math.round(load * 3), trQueued: load > 0.8 ? 1 : 0, trRunning: Math.round(load * 3), trWaiting: 0, trKv: load * 0.3,
      gpuUtil: Math.round(8 + load * 55), gpuMemUsedMb: 24_800 + Math.round(load * 900), gpuMemTotalMb: 32_607, gpuTempC: 48 + Math.round(load * 18), gpuPowerW: 60 + Math.round(load * 210),
      recordings: Math.round(load * 2), watchers: Math.round(load * 5),
    }
  })
  const at = new Date(now).toISOString()
  const last = history[history.length - 1]!
  return {
    snapshot: {
      sampledAt: at, intervalSeconds: 5,
      asr: { configured: true, reachable: true, at, value: {
        observed_at_ms: now, ready: true, can_accept_new_session: true, admission_reason: 'available', health: 'healthy', asr_backend: 'xasr',
        slots: { active: last.asrActive ?? 0, free: 64 - (last.asrActive ?? 0), max: 64, rejected_total: 0 },
        queue: { sampled_sessions: last.asrActive ?? 0, complete: true, limit_ms: 8000, pending_ms_p50: 60, pending_ms_p95: last.asrPendingP95 ?? 0, pending_ms_max: 240, sessions_above_half_limit: 0, sessions_at_limit: 0 },
        pressure: { state: 'normal', signals: [] },
        engine: { chunk_ms: 160, tick_ms_p50: 110, tick_ms_p95: last.asrTickP95 ?? 0, tick_ms_max: 210, tick_ms_avg: 112, batch_size_max: 4, active_slots: last.asrActive ?? 0, fatal_errors_total: 0, vram_allocated_mb: 590 },
        worker: { alive: true, last_tick_age_ms: 24, stalled: false, tick_errors_total: 0 },
        event_loop: { lag_ms_p95: 1, saturated: false }, input_dropped_ms_total: 0, input_drop_age_ms: null,
      } },
      diagnostics: { configured: true, reachable: true, at, value: {
        ws_ingest: { msg_per_sec: 50, mbytes: 12.4, cpu_ms_per_sec: 3.2 },
        engine: { decode_streams_total: 214, language_switch_total: 38, reset_stream_total: 5, force_barrier_total: 61, c_api_errors: 0 },
        diar: { enabled: true, active_slots: 2, max_speakers: 4, step_ms_p50: 180, step_ms_p95: 260, budget_ms: 480 },
        embedding: { enabled: true, model: 'campplus_cn_common', active_slots: 0, embeddings_total: 42 },
        vram: { live: { allocated_mb: 593, reserved_mb: 1028, max_allocated_mb: 918, driver_used_mb: 4086, driver_total_mb: 32607 },
          by_stage: [{ stage: '0_cuda_context', driver_used_mb: 1677 }, { stage: '2_asr_weights', driver_used_mb: 2949 }, { stage: '3_diar', driver_used_mb: 3610 }, { stage: '4_embedding', driver_used_mb: 4086 }] },
        sessions: { max_slots: 64, active: last.asrActive ?? 0, total_tracked: last.asrActive ?? 0 },
      } },
      translator: { configured: true, reachable: true, at, value: {
        status: 'ready', can_accept_now: true, retry_after_seconds: null, model: 'xiaomi-research/MiLMMT-46-4B-v1.0',
        capacity: { active: last.trActive ?? 0, active_limit: 4, queued: last.trQueued ?? 0, queue_limit: 16, admitted: last.trActive ?? 0, admitted_limit: 20, available_admission: 20 - (last.trActive ?? 0) },
        dependencies: { engine_ready: true, detector_ready: true },
        engine_metrics: { available: true, running: last.trRunning, waiting: 0, kv_cache_usage_ratio: last.trKv },
      } },
      gpu: { configured: true, reachable: true, at, value: [{ index: 0, name: 'Simulated GPU', driver: '—', memoryTotalMb: 32607, memoryUsedMb: last.gpuMemUsedMb, utilization: last.gpuUtil,
        memoryUtilization: 12, temperatureC: last.gpuTempC, powerDrawW: last.gpuPowerW, powerLimitW: 575, fanSpeed: 30, smClockMhz: 2400, memoryClockMhz: 14001, pstate: 'P2' }] },
      activity: { recordings: last.recordings, watchers: last.watchers, rooms: last.recordings },
      history,
    },
    backlog: { gapsPending: 0, gapsFilling: 0, gapsFailed: 0, translationsRetrying: 0 },
  }
}
