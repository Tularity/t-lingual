/* Demo only: made-up but steady usage for the prepared workspace, so the
 * usage pages have something to draw. The same person and day always give
 * the same numbers. Imported by the mock alone, so it never reaches a
 * production build. */
import type { AccountStanding, UsageDay, UsageReport, UsageSlice, User } from './contracts'

function hash(text: string) {
  let value = 2166136261
  for (let index = 0; index < text.length; index++) value = Math.imul(value ^ text.charCodeAt(index), 16777619)
  return value >>> 0
}

/** A small seeded generator: the same seed, the same sequence. */
function random(seed: string) {
  let state = hash(seed) || 1
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const LANGUAGES: Array<[string, number]> = [['en', 0.52], ['zh-Hans', 0.3], ['ja', 0.08], ['fr', 0.05], ['de', 0.03], ['es', 0.02]]
const TARGETS: Array<[string, number]> = [['zh-Hans', 0.46], ['en', 0.34], ['ja', 0.1], ['fr', 0.06], ['ko', 0.04]]

interface Person { id: string; intensity: number }

function personOf(user: Pick<User, 'id'>): Person {
  return { id: user.id, intensity: 0.25 + random(`intensity:${user.id}`)() * 1.1 }
}

/** One person's recorded seconds on one local date. */
function daySeconds(person: Person, date: string) {
  const next = random(`${person.id}:${date}`)
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay()
  const busy = weekday === 0 || weekday === 6 ? 0.18 : 0.72
  if (next() > busy) return 0
  return Math.round((600 + next() * 5400) * person.intensity)
}

function localDates(days: number, offsetMinutes: number) {
  const today = new Date(Date.now() + offsetMinutes * 60_000)
  const dates: string[] = []
  for (let index = days - 1; index >= 0; index--) dates.push(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - index)).toISOString().slice(0, 10))
  return dates
}

function split(total: number, shares: Array<[string, number]>, count: (share: number) => number): UsageSlice[] {
  return shares.map(([key, share]) => ({ key, value: Math.round(total * share), count: count(share) })).filter((slice) => slice.value > 0)
}

export interface DemoUsageInput {
  users: Array<Pick<User, 'id' | 'displayName' | 'username' | 'avatarVersion' | 'status'>>
  everyone: boolean
  days: number
  offset: number
  sessions: Array<{ id: string; title: string; ownerName?: string; createdAt: string }>
  workspaces: Array<{ id: string; name: string }>
}

export function demoUsageReport(input: DemoUsageInput): UsageReport {
  const dates = localDates(input.days, input.offset)
  const people = input.users.filter((user) => user.status === 'active').map(personOf)
  const perUser = new Map<string, number>()
  const days: UsageDay[] = dates.map((date) => {
    const day: UsageDay = { date, recordedSeconds: 0, speechSeconds: 0, sessions: 0, segments: 0, sourceCharacters: 0, translations: 0, translationCharacters: 0, translationFailures: 0, shares: 0 }
    const next = random(`day:${date}:${input.everyone}`)
    let active = 0
    for (const person of people) {
      const seconds = daySeconds(person, date)
      if (!seconds) continue
      active++
      perUser.set(person.id, (perUser.get(person.id) ?? 0) + seconds)
      const speech = Math.round(seconds * 0.71)
      const segments = Math.round(speech / 4.6)
      day.recordedSeconds += seconds
      day.speechSeconds += speech
      day.sessions += Math.max(1, Math.round(seconds / 2400))
      day.segments += segments
      day.sourceCharacters += segments * 37
      day.translations += Math.round(segments * 1.35)
      day.translationCharacters += Math.round(segments * 1.35 * 33)
    }
    day.translationFailures = Math.round(day.translations * (next() < 0.12 ? 0.04 : 0.004))
    day.shares = next() < 0.35 ? Math.ceil(next() * 3) : 0
    if (input.everyone) {
      day.activeUsers = active
      day.signIns = active + Math.round(next() * 4)
      day.newUsers = next() < 0.1 ? 1 : 0
      day.guestViews = next() < 0.4 ? Math.round(next() * 9) : 0
    }
    return day
  })
  const total = days.reduce((sum, day) => sum + day.speechSeconds, 0)
  const translations = days.reduce((sum, day) => sum + day.translations, 0)
  const recorded = days.reduce((sum, day) => sum + day.recordedSeconds, 0)
  const hourly = random(`hours:${input.everyone}:${input.users.length}`)
  const hours = Array.from({ length: 7 }, (_, weekday) => Array.from({ length: 24 }, (_, hour) => {
    const working = weekday > 0 && weekday < 6 ? 1 : 0.2
    const shape = hour >= 9 && hour <= 18 ? (hour === 12 ? 0.5 : 1) : hour >= 7 && hour <= 21 ? 0.25 : 0.02
    return Math.round((total / 60) * working * shape * (0.6 + hourly() * 0.8))
  }))
  const weights = input.sessions.map((session) => random(`session:${session.id}`)())
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0) || 1
  const topSessions = input.sessions.map((session, index) => ({
    id: session.id, title: session.title, ownerName: input.everyone ? session.ownerName : undefined,
    recordedSeconds: Math.round((recorded * weights[index]!) / weightTotal * 0.6), segments: Math.round((recorded * weights[index]!) / weightTotal / 7), createdAt: session.createdAt,
  })).sort((a, b) => b.recordedSeconds - a.recordedSeconds).slice(0, 8)
  const workspaceWeights = input.workspaces.map((workspace) => random(`workspace:${workspace.id}`)() + 0.2)
  const workspaceTotal = workspaceWeights.reduce((sum, weight) => sum + weight, 0) || 1
  const report: UsageReport = {
    from: dates[0]!, to: dates[dates.length - 1]!, days,
    languages: split(total, LANGUAGES, (share) => Math.round((total / 4.6) * share)),
    targets: split(translations * 33, TARGETS, (share) => Math.round(translations * share)),
    workspaces: input.everyone ? [] : input.workspaces.map((workspace, index) => ({ key: workspace.id, label: workspace.name, value: Math.round(recorded * workspaceWeights[index]! / workspaceTotal), count: 1 + (index % 3) })),
    hours, topSessions,
    speakers: split(total, [['speaker_1', 0.41], ['speaker_2', 0.33], ['speaker_3', 0.17], ['none', 0.09]], (share) => Math.round((total / 4.6) * share)),
    audioBytes: recorded * 64_000, transcriptBytes: days.reduce((sum, day) => sum + day.sourceCharacters + day.translationCharacters, 0) * 2,
  }
  if (input.everyone) {
    report.users = input.users.map((user) => {
      const seconds = perUser.get(user.id) ?? 0
      const seen = random(`seen:${user.id}`)()
      return { id: user.id, displayName: user.displayName, username: user.username, avatarVersion: user.avatarVersion, recordedSeconds: seconds,
        sessions: Math.round(seconds / 2400), translations: Math.round(seconds / 4.6 * 1.35 * 0.71), storageBytes: Math.round(seconds * 64_000 * 1.4),
        lastSeen: user.status === 'active' ? new Date(Date.now() - seen * 6 * 86_400_000).toISOString() : null }
    }).sort((a, b) => b.recordedSeconds - a.recordedSeconds)
    const failures = days.reduce((sum, day) => sum + day.translationFailures, 0)
    report.translationFailures = [
      { key: 'translator_unavailable', value: 0, count: Math.round(failures * 0.55) },
      { key: 'capacity_exhausted', value: 0, count: Math.round(failures * 0.25) },
      { key: 'source_language_unsupported', value: 0, count: Math.round(failures * 0.2) },
    ].filter((slice) => (slice.count ?? 0) > 0)
    const sessions = days.reduce((sum, day) => sum + day.sessions, 0)
    report.sessionStatuses = [
      { key: 'completed', value: 0, count: Math.round(sessions * 0.78) }, { key: 'archived', value: 0, count: Math.round(sessions * 0.14) },
      { key: 'failed', value: 0, count: Math.round(sessions * 0.03) }, { key: 'created', value: 0, count: Math.round(sessions * 0.05) },
    ]
  }
  return report
}

/** Where one person stands this month, from the same made-up numbers. */
export function demoStanding(user: Pick<User, 'id'>, offset: number, counts: { sessions: number; workspaces: number; activeRecordings: number }): AccountStanding {
  const person = personOf(user)
  const today = new Date(Date.now() + offset * 60_000)
  const monthDays = today.getUTCDate()
  const month = localDates(monthDays, offset).reduce((sum, date) => sum + daySeconds(person, date), 0)
  const all = localDates(120, offset).reduce((sum, date) => sum + daySeconds(person, date), 0)
  return { monthRecordedSeconds: month, storageBytes: Math.round(all * 64_000 * 1.4), lastSeen: new Date().toISOString(), ...counts }
}
