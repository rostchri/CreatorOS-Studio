/* Unit tests of the ComfyUI wait (attenteComfy.js) against a mocked ComfyUI, in
   SIMULATED time: `sleep` advances a fake clock, so a 10 min outage costs nothing.
   Run: npm test */
import test from 'node:test'
import assert from 'node:assert/strict'
import { attendrePrompt, relancePermise, ErreurAttente, PANNE_PAS_MIN_MS, PANNE_PAS_MAX_MS } from './attenteComfy.js'
import { erreurExecution } from './erreurs.js'

const ID = '45926ec7-0000-4000-8000-000000000001'
const MIN = 60_000

/** Mock ComfyUI + simulated clock. `etat(t)` says what ComfyUI is doing at time t (ms since start):
 *  'muet' (HTTP does not answer), 'rendu' (running), 'fini' / 'erreur' (history), 'vide' (restarted, empty),
 *  'attente' (pending). Counts POST /prompt: the wait must never submit anything. */
function monde(etat, { signe = null } = {}) {
  const m = {
    t: 0, appels: [], posts: 0, phases: [], pauses: [], journal: [],
    historiqueFini: { status: { completed: true, status_str: 'success', messages: [] }, outputs: {} },
    historiqueErreur: { status: { completed: false, status_str: 'error', messages: [['execution_error', { node_id: '27', node_type: 'VAEEncode', exception_message: 'boom' }]] }, outputs: {} },
  }
  m.deps = {
    maintenant: () => m.t,
    sleep: async ms => { m.pauses.push(ms); m.t += ms },
    onPhase: p => m.phases.push(p),
    signeDeVie: signe ? () => signe(m.t) : undefined,
    journal: { warn: s => m.journal.push(s), log: s => m.journal.push(s) },
    lire: async chemin => {
      m.appels.push([m.t, chemin])
      const e = etat(m.t)
      if (e === 'muet') throw new TypeError('fetch failed')
      if (chemin.startsWith('/history/')) {
        if (e === 'fini') return { [ID]: m.historiqueFini }
        if (e === 'erreur') return { [ID]: m.historiqueErreur }
        return {}
      }
      return {
        queue_running: e === 'rendu' ? [[0, ID, {}]] : [],
        queue_pending: e === 'attente' ? [[1, ID, {}]] : [],
      }
    },
  }
  return m
}
const attendre = (m, opts = {}) => attendrePrompt(ID, { timeoutMs: 120 * MIN, panneMaxMs: 4 * 60 * MIN, ...m.deps, ...opts })

test('HTTP muet 10 min pendant le rendu : le job reste en cours puis se termine', async () => {
  const m = monde(t => (t < 5_000 ? 'rendu' : t < 5_000 + 10 * MIN ? 'muet' : t < 5_000 + 11 * MIN ? 'rendu' : 'fini'))
  const h = await attendre(m)
  assert.equal(h, m.historiqueFini)
  assert.ok(m.t >= 10 * MIN, 'le temps simulé couvre la coupure')
  assert.deepEqual(m.phases, ['rendering'], 'jamais de retry / échec, seulement la phase rendu')
  assert.equal(m.posts, 0)
  // backoff : 15 s, 30 s, 60 s, 60 s ...
  const pannes = m.pauses.filter(p => p >= PANNE_PAS_MIN_MS)
  assert.deepEqual(pannes.slice(0, 4), [15_000, 30_000, 60_000, 60_000])
  assert.ok(pannes.every(p => p <= PANNE_PAS_MAX_MS))
  assert.ok(m.journal.some(l => /injoignable/.test(l)) && m.journal.some(l => /de nouveau joignable/.test(l)))
})

test('coupure fin de rendu : le prompt est déjà dans l’historique au retour de ComfyUI', async () => {
  const m = monde(t => (t < 2 * MIN ? 'muet' : 'fini'))
  assert.equal(await attendre(m), m.historiqueFini)
})

test('prompt disparu après coupure (ComfyUI redémarré) : erreur claire, pas "fetch failed"', async () => {
  const m = monde(t => (t < 3 * MIN ? 'rendu' : t < 8 * MIN ? 'muet' : 'vide'))
  await assert.rejects(attendre(m), e => {
    assert.ok(e instanceof ErreurAttente)
    assert.equal(e.code, 'perdu')
    assert.match(e.message, /ComfyUI a été redémarré .* prompt est perdu/)
    assert.doesNotMatch(e.message, /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up/i)
    return true
  })
  assert.equal(m.posts, 0)
})

test('prompt introuvable : confirmé par deux observations (pas de faux positif à la fin du rendu)', async () => {
  // après la coupure : 1ère observation vide, puis le prompt entre dans l’historique
  let vues = 0
  const m = monde(t => (t < MIN ? 'muet' : (vues++ < 2 ? 'vide' : 'fini')))
  // history+queue = 2 appels par tour : 1er tour (vues 0,1) vide, 2e tour fini
  assert.equal(await attendre(m), m.historiqueFini)
})

test('historique en erreur après coupure : l’entrée est rendue, l’erreur d’exécution est dite en clair', async () => {
  const m = monde(t => (t < 4 * MIN ? 'muet' : 'erreur'))
  const h = await attendre(m)
  assert.equal(h, m.historiqueErreur)
  assert.match(erreurExecution(h.status), /nœud 27 \(VAEEncode\) : boom/)
})

test('plafond : aucun signe de vie pendant panneMaxMs -> erreur injoignable', async () => {
  const m = monde(() => 'muet')
  await assert.rejects(attendre(m, { panneMaxMs: 30 * MIN }), e => {
    assert.ok(e instanceof ErreurAttente)
    assert.equal(e.code, 'injoignable')
    assert.match(e.message, /aucun signe de vie/)
    assert.match(e.message, /CREATOROS_COMFY_PANNE_MAX_MS/)
    assert.doesNotMatch(e.message, /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up/i)
    return true
  })
  assert.ok(m.t > 30 * MIN && m.t < 33 * MIN, `abandon juste après la limite (t=${m.t})`)
})

test('plafond par défaut : 4 h', async () => {
  const m = monde(() => 'muet')
  await assert.rejects(attendre(m, { panneMaxMs: 4 * 60 * MIN }), /signe de vie depuis 24\d min/)
})

test('événements WebSocket = battement de cœur : remettent le plafond à zéro', async () => {
  // HTTP muet 3 h, mais événements WS toutes les 10 min ; plafond 1 h -> pas d’abandon
  const m = monde(t => (t < 180 * MIN ? 'muet' : 'fini'), { signe: t => Math.floor(t / (10 * MIN)) * 10 * MIN })
  assert.equal(await attendre(m, { panneMaxMs: 60 * MIN }), m.historiqueFini)
  // sans battement de cœur, le même scénario est abandonné
  const m2 = monde(t => (t < 180 * MIN ? 'muet' : 'fini'))
  await assert.rejects(attendre(m2, { panneMaxMs: 60 * MIN }), e => e.code === 'injoignable')
})

test('prompt en file ComfyUI : phase queued puis rendering, ni abandon ni perte', async () => {
  const m = monde(t => (t < 10_000 ? 'attente' : t < 20_000 ? 'rendu' : 'fini'))
  assert.equal(await attendre(m), m.historiqueFini)
  assert.deepEqual(m.phases, ['queued', 'rendering'])
})

test('sans coupure observée : prompt évaporé -> délai d’inactivité (comportement inchangé)', async () => {
  const m = monde(() => 'vide')
  await assert.rejects(attendre(m, { timeoutMs: 10 * MIN }), e => e.code === 'delai' && /délai dépassé \(600 s\)/.test(e.message))
})

test('sans coupure : un rendu très long ne déclenche jamais le délai', async () => {
  const m = monde(t => (t < 300 * MIN ? 'rendu' : 'fini'))
  assert.equal(await attendre(m, { timeoutMs: 10 * MIN }), m.historiqueFini)
})

/* ---------- no double submission ---------- */

test('relancePermise : jamais tant que l’ancien prompt existe (history / running / pending)', async () => {
  for (const etat of ['history', 'running', 'pending']) {
    let posts = 0
    const soumettre = () => { posts++ }                     // stands for POST /prompt
    const r = await relancePermise(ID, async () => etat)
    if (r.ok) soumettre()                                    // the runner only submits when allowed
    assert.equal(r.ok, false, etat)
    assert.equal(r.etat, etat)
    assert.equal(posts, 0)
  }
})

test('relancePermise : permise quand le prompt est prouvé disparu, ou qu’il n’y en a jamais eu', async () => {
  assert.deepEqual(await relancePermise(ID, async () => null), { ok: true })
  assert.deepEqual(await relancePermise(null, async () => { throw new Error('ne doit pas être appelé') }), { ok: true })
})

test('relancePermise : état indéterminable (ComfyUI muet) -> pas de relance', async () => {
  const r = await relancePermise(ID, async () => { throw new TypeError('fetch failed') })
  assert.equal(r.ok, false)
})

test('une attente abandonnée n’est jamais prise pour une erreur de connexion (pas de resubmit)', async () => {
  const m = monde(t => (t < MIN ? 'rendu' : t < 2 * MIN ? 'muet' : 'vide'))
  const re = /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up/i
  await assert.rejects(attendre(m), e => e instanceof ErreurAttente && !re.test(String(e.message)))
})
