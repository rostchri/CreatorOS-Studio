/* LOCAL FORK PATCH: LoRAs offered for a video engine, filtered by its BASE MODEL.

   The generic pickers list the top level of the loras folder only. Base-model
   LoRAs (Wan 2.2 I2V/T2V A14B...) live deeper, in "<base model>/<category>/<model>/",
   and a Wan 2.2 LoRA is usually a PAIR (high noise + low noise) that must be
   chosen together. This module:
     - asks ComfyUI-Lora-Manager (CONFIG.loraManagerUrl) for the LoRAs of the
       engine's base model, with their CivitAI model id, version name and trained
       words; without it (unset, unreachable) it walks "<lorasDir>/<base model>/";
     - drops the speed-up LoRAs the recipes already carry (lightx2v / Lightning);
     - groups the two halves of a pair (same CivitAI model, opposite stages, see
       etageLora.js) into ONE entry. empilerLoras then puts each half on its stage.
   Only names relative to lorasDir leave this module: ComfyUI resolves them as is.
   Nothing reads LoRA contents (the folder is a FUSE mount of the model store). */
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG } from './config.js'
import { cleSansEtage, etageLora } from './etageLora.js'

/** Video engine -> Lora-Manager base model (= folder name under lorasDir). */
export const BASES_VIDEO = {
  wan: 'Wan Video 2.2 I2V-A14B',
  wan_t2v: 'Wan Video 2.2 T2V-A14B',
}

// Built into the recipes (lightx2v 4 steps): a second copy would apply it twice.
const CUITE = /lightning|lightx2v|distill/i
const TTL_MS = 60_000
const cache = new Map()

const segmentSur = s => s && s !== '.' && s !== '..' && !s.includes('\\')

/** { moteur, base, source: 'loramanager' | 'dossier' | 'aucune', erreur?, groupes } */
export async function lorasVideo(moteur, { frais = false } = {}) {
  const base = BASES_VIDEO[moteur]
  if (!base) return { moteur, base: null, source: 'aucune', groupes: [] }
  const hit = cache.get(moteur)
  if (!frais && hit && Date.now() - hit.t < TTL_MS) return hit.val
  let fichiers = null, source = 'dossier', erreur
  if (CONFIG.loraManagerUrl) {
    try { fichiers = await depuisManager(base); source = 'loramanager' }
    catch (e) { erreur = `Lora-Manager injoignable (${String(e?.message || e).slice(0, 160)}) — liste lue dans le dossier` }
  }
  if (!fichiers) fichiers = depuisDossier(base)
  const val = {
    moteur, base, source, ...(erreur ? { erreur } : {}),
    groupes: grouper(fichiers.filter(f => !CUITE.test(f.name) && !CUITE.test(f.version ?? ''))),
  }
  cache.set(moteur, { t: Date.now(), val })
  return val
}

async function depuisManager(base) {
  const out = []
  for (let page = 1, pages = 1; page <= pages && page <= 50; page++) {
    const q = new URLSearchParams({ base_model: base, page_size: '100', page: String(page) })
    const r = await fetch(`${CONFIG.loraManagerUrl}/api/lm/loras/list?${q}`, { signal: AbortSignal.timeout(8000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const d = await r.json()
    pages = Number(d.total_pages) || 1
    for (const it of d.items ?? []) {
      if (it.exclude) continue
      // `folder` is relative to the manager's loras root: independent of where it mounts it
      const fichier = path.posix.basename(String(it.file_path ?? ''))
      const parties = [...String(it.folder ?? '').split('/').filter(Boolean), fichier]
      if (!fichier.endsWith('.safetensors') || !parties.every(segmentSur)) continue
      const c = it.civitai ?? {}
      out.push({
        name: parties.join('/'),
        modele: String(c.modelId || it.source_model_id || '') || null,
        titre: it.model_name || null,
        version: c.name || null,
        mots: Array.isArray(c.trainedWords) ? c.trainedWords.filter(m => typeof m === 'string') : [],
      })
    }
  }
  return out
}

/** Fallback: every .safetensors under "<lorasDir>/<base>/" (names only, no stat of the blobs). */
function depuisDossier(base) {
  const out = []
  const marche = (rel, profondeur) => {
    let entrees
    try { entrees = fs.readdirSync(path.join(CONFIG.lorasDir, rel), { withFileTypes: true }) } catch { return }
    for (const e of entrees) {
      if (!segmentSur(e.name)) continue
      const nom = `${rel}/${e.name}`
      if (e.isDirectory()) { if (profondeur < 6) marche(nom, profondeur + 1) }
      else if (e.name.endsWith('.safetensors')) {
        // "<model>@<creator>" folders (Lora-Manager layout): the model is the title
        const dossier = path.posix.basename(rel).replace(/@[^@]*$/, '')
        out.push({ name: nom, modele: null, titre: dossier === base ? null : dossier, version: null, mots: [] })
      }
    }
  }
  marche(base, 0)
  return out
}

/** Trigger of a group: the short trained words joined; a long activation phrase only if there is no word. */
function triggerDe(mots) {
  const uniques = [...new Set(mots.map(m => m.trim()).filter(Boolean))]
  const courts = uniques.filter(m => !/\s/.test(m) && m.length <= 40)
  if (courts.length) return courts.join(', ')
  return uniques.find(m => m.length <= 200) ?? ''
}

const sansEtage = t => t.replace(/(^|[^a-z])(high|low)([ _-]?noise)?(?![a-z])/gi, '$1')
  .replace(/\(\s*\)/g, '').replace(/\s*-\s*(-\s*)+/g, ' - ').replace(/_{2,}/g, '_').replace(/-{2,}/g, '-')
  .replace(/^[\s_\-.]+|[\s_\-.]+$/g, '').replace(/\s{2,}/g, ' ')

function grouper(fichiers) {
  const parModele = new Map()
  for (const f of fichiers) {
    const cle = f.modele ? `m:${f.modele}` : `d:${path.posix.dirname(f.name)}`
    if (!parModele.has(cle)) parModele.set(cle, [])
    parModele.get(cle).push({ ...f, etage: etageLora(f.name, [f.version]) })
  }
  const groupes = []
  for (const [cle, liste] of parModele) {
    const haut = liste.filter(f => f.etage === 'high'), bas = liste.filter(f => f.etage === 'low')
    const paires = [], seulsHaut = []
    const restant = [...bas]
    const prendre = test => { const i = restant.findIndex(test); return i < 0 ? null : restant.splice(i, 1)[0] }
    for (const h of haut) {
      const k = cleSansEtage(h.name), d = path.posix.dirname(h.name)
      const b = prendre(x => cleSansEtage(x.name) === k) ?? (cle.startsWith('m:') ? prendre(x => path.posix.dirname(x.name) === d) : null)
      if (b) paires.push([h, b]); else seulsHaut.push(h)
    }
    // same CivitAI model, one high and one low left: the pair, whatever the names
    if (cle.startsWith('m:') && seulsHaut.length === 1 && restant.length === 1) paires.push([seulsHaut.pop(), restant.pop()])
    for (const membres of [...paires, ...seulsHaut.map(f => [f]), ...restant.map(f => [f]), ...liste.filter(f => !f.etage).map(f => [f])]) {
      const tete = membres[0]
      const fichier = tete.name.split('/').pop().replace(/\.safetensors$/, '')
      groupes.push({
        id: membres.map(m => m.name).join('|'),
        titre: tete.titre || fichier,
        // a pair shows its version without the stage words ("HIGH v1.0" -> "v1.0")
        detail: membres.length === 2 ? sansEtage(tete.version || fichier) : (tete.version || fichier),
        etages: membres.length === 2 ? 'paire' : tete.etage ?? 'deux',
        trigger: triggerDe(membres.flatMap(m => m.mots)),
        membres: membres.map(m => ({ name: m.name, etage: m.etage })),
      })
    }
  }
  return groupes.sort((a, b) => a.titre.localeCompare(b.titre) || a.detail.localeCompare(b.detail))
}
