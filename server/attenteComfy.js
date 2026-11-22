/* ============================================================
   Waiting for a ComfyUI prompt that survives unresponsive periods.

   ComfyUI runs its HTTP server on the same event loop as the GPU work: during a
   long step (VAE encode of a Wan clip, a ~1000 s sampling step) it may not answer
   for MINUTES ("fetch failed", timeouts). That is not a job failure: the prompt
   keeps running. Polling therefore backs off and carries on, and gives up only on
   PROOF:

     (a) the history entry exists                    -> returned (the caller reads its
                                                        status: success or execution error)
     (b) ComfyUI answers again, the prompt is in neither the queue nor the history
         (confirmed twice)                           -> lost (restart, watchdog kill)
     (c) no sign of life at all for `panneMaxMs`     -> given up (HTTP down AND silent
         WebSocket)

   Everything external is injected (HTTP reader, clock, sleep, WebSocket heartbeat)
   so the logic is unit-testable with simulated time (attenteComfy.test.js).
   ============================================================ */
import { erreurPromptPerdu, erreurComfyInjoignable } from './erreurs.js'

/** Polling every second while ComfyUI answers (as before). */
export const SONDE_NORMALE_MS = 1000
/** Backoff while ComfyUI does not answer: 15 s, 30 s, 60 s, 60 s... */
export const PANNE_PAS_MIN_MS = 15_000
export const PANNE_PAS_MAX_MS = 60_000
/** Pause between the two observations that must both miss the prompt before it counts as lost. */
export const CONFIRMATION_MS = 3000

/** Wait failure with a plain-language message. `code`: 'perdu' | 'injoignable' | 'delai'.
 *  Its message never contains "fetch failed" & co: the job runner must not mistake it
 *  for a connection error and resubmit. */
export class ErreurAttente extends Error {
  constructor(code, message) { super(message); this.name = 'ErreurAttente'; this.code = code }
}

/**
 * Waits for the end of a prompt.
 * @param {string} promptId
 * @param {object} deps
 * @param {(chemin: string) => Promise<any>} deps.lire        GET JSON from ComfyUI; throws when unreachable
 * @param {(ms: number) => Promise<void>} deps.sleep
 * @param {() => number} deps.maintenant                      clock (ms)
 * @param {(promptId: string) => (number|null)} [deps.signeDeVie]  last WebSocket event of the prompt (ms) or null
 * @param {(phase: 'queued'|'rendering') => void} [deps.onPhase]
 * @param {number} deps.timeoutMs      inactivity timeout of a prompt that vanished WITHOUT an outage being seen
 * @param {number} deps.panneMaxMs     upper bound of total silence (no HTTP answer, no WebSocket event)
 * @param {{warn: Function, log: Function}} [deps.journal]
 * @returns {Promise<object>} history entry of the prompt
 */
export async function attendrePrompt(promptId, {
  lire, sleep, maintenant, signeDeVie = () => null, onPhase, timeoutMs, panneMaxMs, journal = console,
}) {
  const t0 = maintenant()
  let phase = null
  let dernierContact = t0          // last time ComfyUI answered over HTTP
  let panneDepuis = null           // start of the current outage
  let aVuPanne = false             // an outage happened during this wait: absence becomes proof of loss
  let absences = 0
  let pas = PANNE_PAS_MIN_MS

  for (;;) {
    let hist, file
    try {
      hist = await lire(`/history/${promptId}`)
      if (!hist?.[promptId]) file = await lire('/queue')
    } catch (e) {
      const t = maintenant()
      if (panneDepuis === null) {
        panneDepuis = t; aVuPanne = true
        journal.warn(`[comfy] injoignable pendant le rendu ${promptId} (${String(e?.message || e).slice(0, 160)}) — le prompt continue, sondage espacé`)
      }
      const vivant = Math.max(dernierContact, signeDeVie(promptId) ?? 0)
      if (t - vivant > panneMaxMs) {
        journal.warn(`[comfy] prompt ${promptId} : aucun signe de vie depuis ${Math.round((t - vivant) / 1000)} s — abandon`)
        throw new ErreurAttente('injoignable', erreurComfyInjoignable(t - vivant))
      }
      await sleep(pas)
      pas = Math.min(pas * 2, PANNE_PAS_MAX_MS)
      continue
    }
    dernierContact = maintenant()
    if (panneDepuis !== null) {
      journal.log(`[comfy] de nouveau joignable après ${Math.round((dernierContact - panneDepuis) / 1000)} s — rendu ${promptId} suivi`)
      panneDepuis = null; pas = PANNE_PAS_MIN_MS
    }

    if (hist[promptId]) return hist[promptId]   // finished: success OR execution error, the caller decides

    const running = (file.queue_running || []).some(e => e[1] === promptId)
    const pending = (file.queue_pending || []).some(e => e[1] === promptId)
    const next = running ? 'rendering' : 'queued'
    if (next !== phase) { phase = next; onPhase?.(next) }

    if (running || pending) {
      absences = 0
    } else if (aVuPanne) {
      /* ComfyUI answers, the prompt is in neither list: after an outage that is a
         restart (watchdog kill, crash), its memory is gone. Two observations apart
         rule out the instant between "left the queue" and "entered the history". */
      if (++absences >= 2) {
        journal.warn(`[comfy] prompt ${promptId} introuvable après une coupure (file et historique vides) — ComfyUI a redémarré`)
        throw new ErreurAttente('perdu', erreurPromptPerdu())
      }
      await sleep(CONFIRMATION_MS)
      continue
    } else if (maintenant() - Math.max(t0, signeDeVie(promptId) ?? 0) > timeoutMs) {
      /* Without an observed outage, the timeout applies to a prompt that VANISHED
         without history (not to a long render, which is running or pending). */
      throw new ErreurAttente('delai', `délai dépassé (${Math.round(timeoutMs / 1000)} s) sans résultat`)
    }
    await sleep(SONDE_NORMALE_MS)
  }
}

/**
 * May the job runner submit the job AGAIN after a connection error?
 * Never while the old prompt still exists (running, pending, in history): that would
 * render twice. Allowed when there never was a prompt, or when the old one is provably gone.
 * @param {string|null|undefined} promptId  prompt already submitted for this job, if any
 * @param {(promptId: string) => Promise<string|null>} promptKnown  'history'|'running'|'pending'|null
 * @returns {Promise<{ok: boolean, etat?: string}>}
 */
export async function relancePermise(promptId, promptKnown) {
  if (!promptId) return { ok: true }
  let etat = null
  try { etat = await promptKnown(promptId) } catch { return { ok: false, etat: 'indetermine' } }   // cannot prove it is gone
  return etat ? { ok: false, etat } : { ok: true }
}
