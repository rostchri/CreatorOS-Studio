/* LOCAL FORK PATCH (see CONFIG.adultePersonnagesFictifs): provenance of fictitious faces.
   A character is fictitious when nothing in its chain comes from a photo: the character creator's
   text-only portrait becomes its profile photo, the studio renders it from text with that photo as
   the only image, and its LoRAs are trained on such renders. Each LoRA is attested once, when its
   training ends, in <data>/loras-fictives.json together with its sha256: a LoRA brought in from
   elsewhere is never attested, and a replaced file no longer matches. Any doubt answers no. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { CONFIG } from './config.js'
import * as store from './db.js'
import { persona, SANS_PERSONNAGE } from './persona.js'

/** Start of the character creator's portrait prompt (its template states an adult of 21 to 80). */
export const PORTRAIT_GENERATEUR = 'Photorealistic head-and-shoulders studio portrait of '

const FICHIER = path.join(CONFIG.dataDir, 'loras-fictives.json')
const vide = v => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
const MEDIA = /\.(png|jpe?g|webp|gif|bmp|tiff?|mp4|mov|webm|mkv|avi)$/i
const POIDS = /\.(safetensors|pt|pth|ckpt|bin|gguf)$/i

/** Finished job and its payload, or null (missing job, not done, unreadable payload). */
function jobTermine(jobId) {
  const j = jobId ? store.getJob(jobId) : null
  if (!j || j.status !== 'done') return null
  try {
    const pl = JSON.parse(j.payload ?? 'null')
    return pl && typeof pl === 'object' ? { j, pl } : null
  } catch { return null }
}

/** True only if the asset is a finished photo of a job that started from text alone: no character,
 *  no source/end image, no reference, no keyframe, no LoRA. Such a face comes from no real person. */
export function portraitSurTexteSeul(a) {
  const x = jobTermine(a?.job_id)
  if (!x) return false
  const { pl } = x
  /* only the generator's own portraits: its prompt template states an adult of 21 to 80 */
  const p = String(pl.composedPositive ?? '')
  if (!p.startsWith(PORTRAIT_GENERATEUR) || !/^a \d{2}-year-old adult /.test(p.slice(PORTRAIT_GENERATEUR.length))) return false
  return pl.mode === 'photo' && pl.op !== 'edit' && pl.personaId === SANS_PERSONNAGE
    && vide(pl.sourceImage) && vide(pl.endImage) && vide(pl.references) && vide(pl.keyframes)
    && vide(pl.loras) && vide(pl.videoLoras) && pl.refVisage !== true
}

function lire() {
  try {
    const r = JSON.parse(fs.readFileSync(FICHIER, 'utf8'))
    return r && typeof r === 'object' && !Array.isArray(r) ? r : {}
  } catch { return {} }
}
function ecrire(r) {
  const tmp = `${FICHIER}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(r, null, 1))
  fs.renameSync(tmp, FICHIER)
}

/** Path of a LoRA name: top level or the instance's own subfolder, as comfy.loraInfo accepts. */
function cheminLora(name) {
  if (typeof name !== 'string' || !name || name.includes('\\')) return null
  const parts = name.split('/')
  if (parts.length > 2 || parts.some(p => !p || p === '.' || p === '..')) return null
  if (parts.length === 2 && (!CONFIG.lorasPropres || parts[0] !== CONFIG.lorasPropres)) return null
  const full = path.join(CONFIG.lorasDir, name)
  return full.startsWith(CONFIG.lorasDir + path.sep) ? full : null
}

export async function sha256(f) {
  const h = crypto.createHash('sha256')
  for await (const b of fs.createReadStream(f)) h.update(b)
  return h.digest('hex')
}

/** Profile photo the renders of a character load (same order as jobs.visageDuPersonnage). */
export function avatarDe(id) {
  const d = path.join(CONFIG.mediaDir, '.persona', String(id ?? '').replace(/[^a-z0-9_]/g, ''))
  return ['.png', '.jpg', '.webp'].map(e => path.join(d, `avatar${e}`)).find(f => fs.existsSync(f)) ?? null
}

/** True if `name` is attested fictitious for this character and the file still holds the attested bytes. */
export async function loraFictive(name, personaId) {
  const e = lire()[name], full = cheminLora(name)
  if (!e || !full || !personaId || personaId === SANS_PERSONNAGE || e.personaId !== personaId) return false
  let st
  try { st = fs.statSync(full) } catch { return false }
  if (!st.isFile() || st.size !== e.size) return false
  if (st.mtimeMs === e.mtimeMs) return true
  // file touched (copy, move into the model inventory): the same bytes, or nothing
  if (await sha256(full) !== e.sha256) return false
  const r = lire()
  if (r[name]?.sha256 === e.sha256) { r[name].mtimeMs = st.mtimeMs; ecrire(r) }
  return true
}

/** True if every identity LoRA of the character is attested fictitious for it (none at all = true). */
export async function lorasDuPersonnageFictives(p) {
  for (const l of [...(p?.loras ?? []), ...(p?.lorasKlein ?? []), ...(p?.lorasFlux3 ?? []), ...(p?.videoLoras ?? [])])
    if (!await loraFictive(l?.name, p.id)) return false
  return true
}

/** Why the image file is NOT a fictitious render of the character, or null if it is: a finished
 *  text-to-image render (op generate) of this character or of no character, with no source or end
 *  image, reference, keyframe or motion clip, whose graph as actually run (provenance) loads no
 *  image but the character's own profile photo, rendered after that photo was set, and no LoRA but
 *  one attested for the same character. */
export async function nonFictive(fichier, personaId) {
  const ref = store.assetParFichier(path.basename(String(fichier ?? '')))
  const a = ref && store.getAsset(ref.id)
  if (!a || a.media_type !== 'photo') return 'pas une photo de la bibliothèque'
  const x = jobTermine(a.job_id)
  if (!x) return 'rendu inachevé ou illisible'
  const { j, pl } = x
  if (pl.personaId !== personaId && pl.personaId !== SANS_PERSONNAGE) return `rendu d'un autre personnage (${pl.personaId})`
  if (pl.mode !== 'photo' || pl.op !== 'generate' || !vide(pl.parentAssetId)) return `rendu dérivé (${pl.op ?? '?'})`
  if (![pl.sourceImage, pl.endImage, pl.references, pl.keyframes, pl.motionRef].every(vide) || pl.refVisage === true) return 'image en entrée'
  for (const l of [...(pl.loras ?? []), ...(pl.videoLoras ?? [])])
    if (!await loraFictive(l?.name, personaId)) return `LoRA ${l?.name}`
  let g
  try { g = JSON.parse(store.getProvenance(a.id)?.workflow_json ?? 'null') } catch { g = null }
  if (!g || typeof g !== 'object') return 'graphe exécuté absent'
  const avatar = pl.personaId === personaId ? avatarDe(personaId) : null
  const photoProfil = avatar && `PAV_${String(personaId).replace(/[^a-z0-9_]/g, '')}${path.extname(avatar)}`
  for (const n of Object.values(g)) {
    for (const [k, v] of Object.entries(n?.inputs ?? {})) {
      if (typeof v !== 'string') continue
      if (POIDS.test(v) && (/lora/i.test(k) || /lora/i.test(String(n.class_type)))) {
        if (!await loraFictive(v, personaId)) return `LoRA ${v} dans le graphe`
      } else if (MEDIA.test(v)) {
        if (!photoProfil || v !== photoProfil) return `image ${v} dans le graphe`
        if (!(Number(j.created_at) >= fs.statSync(avatar).mtimeMs)) return 'rendu antérieur à la photo de profil actuelle'
      }
    }
  }
  return null
}

/** Attests a trained LoRA when the character is fictitious and EVERY training image is a fictitious
 *  render of it (see nonFictive). Returns why it was not attested, or null once recorded. */
export async function attesterLora(name, personaId, jobId, images) {
  const full = cheminLora(name)
  if (!full || !fs.existsSync(full)) return 'fichier LoRA introuvable'
  if (persona(personaId)?.fictif !== true) return 'personnage non fictif'
  if (!Array.isArray(images) || !images.length) return 'aucune image d’entraînement'
  for (const f of images) {
    const refus = await nonFictive(f, personaId)
    if (refus) return `${path.basename(String(f))} : ${refus}`
  }
  const empreinte = await sha256(full), st = fs.statSync(full)
  const r = lire()
  r[name] = { personaId, sha256: empreinte, size: st.size, mtimeMs: st.mtimeMs, job: jobId, at: Date.now() }
  ecrire(r)
  return null
}

/** Attestation entries (for the maintenance script). */
export const attestations = () => lire()
