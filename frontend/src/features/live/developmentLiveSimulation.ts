import type { Dispatch, SetStateAction } from 'react'
import { api } from '../../api/client'
import type { InterpretationSession, Segment } from '../../api/contracts'
import { mergeTranscript } from './transcriptState'
import type { MockApi } from '../../api/mock'

type DemoLiveApi = Pick<MockApi, 'startDevelopmentLive' | 'saveDevelopmentSegment' | 'nextDevelopmentSequence' | 'developmentPosition'>

interface DevelopmentLiveSimulationOptions {
  sessionId: string
  setPartial: Dispatch<SetStateAction<string>>
  setSegments: Dispatch<SetStateAction<Segment[]>>
  showPartial?: boolean
  demoApi?: DemoLiveApi
}

const speech: Array<Record<string, string>> = [
  { en: 'Welcome, everyone. We will begin the meeting now.', 'zh-Hans': '欢迎大家。我们现在开始会议。', fr: 'Bienvenue à tous. Nous allons commencer la réunion.', es: 'Bienvenidos a todos. Vamos a comenzar la reunión.', de: 'Willkommen zusammen. Wir beginnen jetzt die Besprechung.', ja: '皆さん、ようこそ。これから会議を始めます。', ko: '여러분, 환영합니다. 이제 회의를 시작하겠습니다.' },
  { en: 'The first item is our rollout schedule for the coming quarter.', 'zh-Hans': '第一项议题是下个季度的发布计划。', fr: 'Le premier point concerne le calendrier de lancement du prochain trimestre.', es: 'El primer punto es nuestro calendario de lanzamiento para el próximo trimestre.', de: 'Der erste Punkt ist unser Zeitplan für das nächste Quartal.', ja: '最初の議題は来四半期の導入スケジュールです。', ko: '첫 번째 안건은 다음 분기 출시 일정입니다.' },
  { en: 'Please stop me at any point if something needs clarification.', 'zh-Hans': '如果有任何内容需要澄清，请随时打断我。', fr: 'N’hésitez pas à m’interrompre si vous souhaitez une précision.', es: 'Interrúmpanme en cualquier momento si necesitan una aclaración.', de: 'Bitte unterbrechen Sie mich jederzeit, wenn etwas unklar ist.', ja: '確認したいことがあれば、いつでもお声がけください。', ko: '설명이 필요한 부분이 있으면 언제든 말씀해 주세요.' },
  { en: 'We have shared the latest prototype with the teams in Sydney and Shanghai.', 'zh-Hans': '我们已经和悉尼及上海的团队分享了最新的原型。', fr: 'Nous avons partagé le dernier prototype avec les équipes de Sydney et de Shanghai.', es: 'Compartimos el prototipo más reciente con los equipos de Sídney y Shanghái.', de: 'Wir haben den neuesten Prototyp mit den Teams in Sydney und Shanghai geteilt.', ja: '最新のプロトタイプをシドニーと上海のチームに共有しました。', ko: '최신 시제품을 시드니와 상하이 팀에 공유했습니다.' },
  { en: 'The feedback has been especially useful for the mobile experience.', 'zh-Hans': '目前收到的反馈对移动端体验尤其有帮助。', fr: 'Les retours ont été particulièrement utiles pour l’expérience mobile.', es: 'Los comentarios han sido especialmente útiles para la experiencia móvil.', de: 'Das Feedback war besonders hilfreich für die mobile Nutzung.', ja: '寄せられた意見はモバイル体験の改善に特に役立っています。', ko: '피드백은 모바일 사용 경험을 개선하는 데 특히 도움이 되었습니다.' },
  { en: 'Next week, we will review the remaining questions together.', 'zh-Hans': '下周我们会一起讨论剩下的问题。', fr: 'La semaine prochaine, nous examinerons ensemble les questions restantes.', es: 'La próxima semana revisaremos juntos las preguntas pendientes.', de: 'Nächste Woche besprechen wir gemeinsam die offenen Fragen.', ja: '来週、残りの質問を一緒に確認します。', ko: '다음 주에 남은 질문을 함께 검토하겠습니다.' },
  { en: 'Thank you for your time. I will send a short summary after the meeting.', 'zh-Hans': '感谢大家抽出时间。会后我会发送一份简短的总结。', fr: 'Merci pour votre temps. J’enverrai un bref résumé après la réunion.', es: 'Gracias por su tiempo. Enviaré un breve resumen después de la reunión.', de: 'Vielen Dank für Ihre Zeit. Ich schicke nach der Besprechung eine kurze Zusammenfassung.', ja: 'お時間をいただきありがとうございます。会議後に簡単な要約を送ります。', ko: '시간 내주셔서 감사합니다. 회의 후 간단한 요약을 보내겠습니다.' },
]

function localizedSpeech(session: InterpretationSession, index: number) {
  const phrase = speech[index % speech.length]!
  const candidates = session.recognitionLanguages?.length ? session.recognitionLanguages : [session.sourceLanguage === 'auto' ? 'en' : session.sourceLanguage]
  const sourceLanguage = candidates[index % candidates.length] ?? 'en'
  const sourceText = phrase[sourceLanguage] ?? phrase.en!
  const translation = phrase[session.targetLanguage] ?? ''
  return { sourceText, translation, sourceLanguage }
}

/** Mirrors provider cadence: revisable ASR snapshots, delayed speaker labels,
 * translation snapshots, and a new utterance while the prior translation drains. */
export function scheduleDevelopmentLiveSimulation({ sessionId, setPartial, setSegments, showPartial = true, demoApi = api as MockApi }: DevelopmentLiveSimulationOptions) {
  const session = demoApi.startDevelopmentLive(sessionId)
  const firstSequence = demoApi.nextDevelopmentSequence(sessionId)
  const timers = Object.assign([] as number[], { flush: () => {
    flushing = true
    for (const finish of pending.values()) finish()
    setPartial('')
  } })
  let flushing = false
  const pending = new Map<string, () => void>()
  const later = (delay: number, callback: () => void) => {
    if (flushing) return
    const timer = window.setTimeout(() => {
      const index = timers.indexOf(timer)
      if (index >= 0) timers.splice(index, 1)
      if (!flushing) callback()
    }, delay)
    timers.push(timer)
  }
  const publish = (segment: Segment) => {
    setSegments(current => mergeTranscript(current, [segment]))
    if (segment.final) demoApi.saveDevelopmentSegment(segment)
  }
  const begin = (sequence: number) => {
    const { sourceText, translation, sourceLanguage } = localizedSpeech(session, sequence - 1)
    const startMs = demoApi.developmentPosition(sessionId)
    const speakerId = session.diarization ? `speaker_${Math.floor((sequence - 1) / 2) % 3 + 1}` : undefined
    const id = `seg_dev_${crypto.randomUUID()}`
    const sourceKey = `${id}:source`, draftKey = `${id}:draft`, finalKey = `${id}:final`
    let draft: Segment = {
      id, sessionId, sequence, sourceText: '', translation: '',
      translationTargetLanguage: session.targetLanguage, translationStatus: 'not_requested', final: false, startMs, endMs: startMs,
      createdAt: new Date().toISOString(), detectedLanguage: sourceLanguage,
      sourceRevision: 0, translationRevision: 0,
    }
    const characters = Array.from(sourceText)
    const translated = Array.from(translation)
    const draftLength = Math.ceil(translated.length * .72)
    let draftStarted = false
    let draftComplete = !translation
    let finalStarted = false

    const finishFinalTranslation = () => {
      if (!pending.delete(finalKey)) return
      draft = { ...draft, translation, translationStatus: 'succeeded', translationPhase: 'final', translationRevision: 200 }
      publish(draft)
    }
    const startFinalTranslation = () => {
      if (finalStarted || !draft.final || !draftComplete || !translation) return
      finalStarted = true
      pending.set(finalKey, finishFinalTranslation)
      draft = { ...draft, translationPhase: 'final', translationStatus: 'pending', translationRevision: 100 }
      publish(draft)
      for (let step = 1; step <= 20; step++) later(step * 120, () => {
        if (!pending.has(finalKey)) return
        draft = { ...draft, translation: translated.slice(0, draftLength + Math.ceil((translated.length - draftLength) * step / 20)).join(''), translationRevision: 100 + step }
        publish(draft)
        if (step === 20) finishFinalTranslation()
      })
    }
    const finishDraftTranslation = () => {
      if (!pending.delete(draftKey)) return
      draftComplete = true
      startFinalTranslation()
    }
    const startDraftTranslation = () => {
      if (draftStarted || !translation) return
      draftStarted = true
      pending.set(draftKey, finishDraftTranslation)
      // One draft translation update belongs to the very first ASR partial.
      draft = { ...draft, translation: translated.slice(0, Math.max(1, Math.ceil(draftLength / 16))).join(''),
        translationStatus: 'pending', translationPhase: 'draft', translationRevision: 1 }
      for (let step = 2; step <= 16; step++) later((step - 1) * 200, () => {
        if (!pending.has(draftKey)) return
        draft = { ...draft, translation: translated.slice(0, Math.ceil(draftLength * step / 16)).join(''), translationRevision: step }
        if (showPartial || draft.final) publish(draft)
        if (step === 16) finishDraftTranslation()
      })
    }
    const finishSource = () => {
      if (!pending.delete(sourceKey)) return
      // A stop before the first partial still drains a draft before the final request.
      if (translation && !draftStarted) startDraftTranslation()
      draft = { ...draft, sourceText, final: true, sourceRevision: 100, endMs: startMs + 2800, speakerId,
        translationStatus: translation ? 'pending' : 'not_requested' }
      publish(draft); setPartial('')
      startFinalTranslation()
    }
    pending.set(sourceKey, finishSource)
    for (let step = 1; step <= 13; step++) later(step * 200, () => {
      if (!pending.has(sourceKey)) return
      let text = characters.slice(0, Math.ceil(characters.length * step / 14)).join('')
      // A recognizer can revise an earlier word; the next snapshot replaces it.
      if (sourceLanguage === 'en' && step === 10 && text.includes('begin')) text = text.replace('begin', 'start')
      draft = { ...draft, sourceText: text, sourceRevision: step }
      if (step === 1) startDraftTranslation()
      if (showPartial) { setPartial(text); publish(draft) }
    })
    // Diarization often arrives later than the first recognized words.
    if (speakerId) later(1700, () => { draft = { ...draft, speakerId }; if (showPartial || draft.final) publish(draft) })
    later(2800, finishSource)
    later(4200, () => begin(sequence + 1))
  }
  begin(firstSequence)
  return timers
}
