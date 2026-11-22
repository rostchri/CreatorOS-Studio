/* Create a character from scratch: traits (adult, 21+) produce 4 portraits; the chosen one
   becomes the profile photo of a new character, then the studio renders a reference sheet
   and 12 varied images on FLUX.2 Klein (face held by the profile photo) and, if requested,
   trains its Klein LoRA on them. Owner only.
   LOCAL FORK PATCH: a second entry, creerDepuisImages, starts from 1 to 12 imported photos instead
   of the four generated portraits (see planDepuisImages for what each count triggers). */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { CONFIG } from './config.js'
import * as store from './db.js'
import { enqueue, enqueueEntrainement } from './jobs.js'
import { MOTEURS_ENTRAINEMENT } from './entrainement.js'
import { activer, creer as creerPersona, enregistrer as enregistrerPersona, marquerFictif, persona as personaActif, SANS_PERSONNAGE } from './persona.js'
import { t0Hit } from './t0.js'
// LOCAL FORK PATCH: the generator's portrait prompt and its text-only check (see fictif.js)
import { PORTRAIT_GENERATEUR, portraitSurTexteSeul } from './fictif.js'

const nettoie = (v, n = 80) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, n)

function lireTraits(t = {}) {
  const age = Math.round(Number(t.age))
  if (!Number.isFinite(age) || age < 21 || age > 80) throw new Error('âge : un adulte de 21 à 80 ans')
  const genre = ['woman', 'man'].includes(t.genre) ? t.genre : 'person'
  const x = { age, genre, origine: nettoie(t.origine, 40), cheveux: nettoie(t.cheveux, 50), yeux: nettoie(t.yeux, 30), style: nettoie(t.style, 80), signes: nettoie(t.signes, 120) }
  if (t0Hit(Object.values(x).join(' '))) throw new Error('un trait contient un terme bloqué')
  return x
}
const description = x => [`a ${x.age}-year-old adult ${x.genre}`, x.origine, x.cheveux && `${x.cheveux} hair`, x.yeux && `${x.yeux} eyes`, x.signes].filter(Boolean).join(', ')

export function propositions(traits) {
  const x = lireTraits(traits)
  const texte = `${PORTRAIT_GENERATEUR}${description(x)}, wearing ${x.style || 'simple casual clothes'}, neutral light grey background, soft even light, sharp focus on the face, natural skin texture, looking at the camera`
  return Array.from({ length: 4 }, () => enqueue({ mode: 'photo', register: 'sfw', personaId: SANS_PERSONNAGE, purpose: 'creative', photoEngine: 'krea',
    composedPositive: texte, userPrompt: texte, composedNegative: '', width: 1024, height: 1024 }).id)
}

const SCENES = [
  'full body standing in a city street, casual outfit, daylight', 'close-up portrait, smiling, golden hour light', 'sitting at a café table, warm window light',
  'profile view outdoors, overcast light', 'three-quarter view, studio light, plain backdrop', 'walking on a beach at sunset, full body',
  'laughing indoors, warm lamp light', 'looking over the shoulder in a park', 'black and white portrait, dramatic side light',
  'wearing a coat in the rain at night, neon reflections', 'working at a desk with a laptop, soft daylight', 'full body in sportswear in a park, morning light',
]
/* In-progress creations are persisted to disk so a service restart neither loses their
   progress nor prevents training from starting once the images are done. */
const FICHIER_SUIVIS = path.join(CONFIG.dataDir, 'creations-personnages.json')
const suivis = new Map()
try {
  for (const c of JSON.parse(fs.readFileSync(FICHIER_SUIVIS, 'utf8')))
    if (c?.id && Date.now() - (c.debut ?? 0) < 7 * 86400_000) suivis.set(c.id, c)
} catch { /* no saved tracking */ }
const garder = () => { try { fs.writeFileSync(FICHIER_SUIVIS, JSON.stringify([...suivis.values()])) } catch (e) { console.warn(`[création] suivi non enregistré : ${e.message || e}`) } }

/* Engines to train: the checked list, or the legacy boolean (Klein only). */
// LOCAL FORK PATCH: every engine entrainement.js knows (was klein|krea only, FLUX 3 dropped silently);
// whether it is ready on this machine is checked by enqueueEntrainement
const moteursChoisis = (moteurs, entrainer) => Array.isArray(moteurs) ? moteurs.map(String).filter(m => Object.hasOwn(MOTEURS_ENTRAINEMENT, m)).filter((m, i, l) => l.indexOf(m) === i) : entrainer ? ['klein'] : []
const nomValide = nom => {
  const n = nettoie(nom, 40)
  if (n.length < 2 || t0Hit(n)) throw new Error('donne un nom au personnage')
  return n
}

/* Shared by both entries: crop the profile photo, create the character, queue the reference sheet
   and the scenes on Klein, track the creation. `refs` are ComfyUI input names given to every render
   after the profile photo; `extras` are absolute paths added to the training set once the scenes
   are done. The photo is cropped to a temporary file first, so an unreadable image leaves no
   half-created character behind. LOCAL FORK PATCH: with `verifier` (and an engine to train), the
   training waits for the owner to pick its images (entrainerSelection) instead of starting alone.
   `ancrageY` is where the square sits vertically (0 = top, 0.5 = centre). */
function lancerCreation({ nom, x, src, ancrageY = 0.5, fictif, credit, description: desc, scenes, refs = [], extras = [], aEntrainer, verifier = false }) {
  const tmp = path.join(CONFIG.dataDir, `.avatar-${Date.now().toString(36)}-${process.pid}.jpg`)
  try { execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vf', `crop=min(iw\\,ih):min(iw\\,ih):(iw-ow)/2:(ih-oh)*${ancrageY},scale=512:512`, '-frames:v', '1', '-q:v', '3', tmp]) }
  catch { fs.rmSync(tmp, { force: true }); throw new Error('photo illisible : choisis une autre image') }
  // the studio's active character is unchanged: the new one is picked from the menu
  const avant = personaActif().id
  const p = creerPersona({ name: nom })
  if (avant) activer(avant)
  enregistrerPersona({ preamble: x ? description(x) : '', description: desc, credit }, p.id)
  const dossier = path.join(CONFIG.mediaDir, '.persona', p.id.replace(/[^a-z0-9_]/g, ''))
  fs.mkdirSync(dossier, { recursive: true })
  // LOCAL FORK PATCH: a deleted character's photo with the same id would win over avatar.jpg (png first)
  for (const e of ['.png', '.webp']) fs.rmSync(path.join(dossier, `avatar${e}`), { force: true })
  try { fs.renameSync(tmp, path.join(dossier, 'avatar.jpg')) } catch { fs.copyFileSync(tmp, path.join(dossier, 'avatar.jpg')); fs.rmSync(tmp, { force: true }) }
  // LOCAL FORK PATCH: the character is fictitious only if its portrait comes from a text-only render
  if (fictif) marquerFictif(p.id, true)
  const tenue = x?.style || 'casual clothes'
  // other photos of the same person are identity only: not pose, clothes or background
  const consigne = refs.length ? ' The other reference images show the same person: use them for identity only, not for pose, clothes or background.' : ''
  const enfile = (o) => enqueue({ mode: 'photo', register: 'sfw', personaId: p.id, purpose: 'creative', photoEngine: 'klein', composedNegative: '', ...(refs.length ? { references: refs } : {}), ...o }).id
  const planche = enfile({ width: 1344, height: 768,
    composedPositive: `Character reference sheet of the same person: front view, three-quarter view, profile and back view, full body, same outfit (${tenue}), plain light grey background, even studio light${consigne}`,
    userPrompt: 'planche de référence' })
  const images = scenes.map(sc => enfile({ width: 832, height: 1216, composedPositive: `${sc}, photorealistic${consigne}`, userPrompt: sc }))
  const id = `perso-${Date.now().toString(36)}`
  suivis.set(id, { id, personaId: p.id, nom, planche, images, extras, entrainer: aEntrainer.length > 0, moteurs: aEntrainer, verifier: verifier === true && aEntrainer.length > 0, entrainements: [], debut: Date.now(), declencheur: `${nom.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10)}x` })
  garder()
  return etatCreation(id)
}

export function creerPersonnage({ assetId, nom, traits, entrainer, moteurs, verifier }) {
  const aEntrainer = moteursChoisis(moteurs, entrainer)
  const x = lireTraits(traits)
  const n = nomValide(nom)
  const a = store.getAsset(String(assetId ?? ''))
  if (!a || a.media_type !== 'photo') throw new Error('choisis l’un des portraits proposés')
  const src = path.join(CONFIG.mediaDir, path.basename(a.filename ?? a.uri))
  return lancerCreation({ nom: n, x, src, fictif: portraitSurTexteSeul(a), scenes: SCENES, aEntrainer, verifier,
    description: `${n} : ${description(x)}, ${x.style}`,
    credit: { auteur: 'CreatorOS Studio', url: '', licence: 'personnage fictif créé dans le studio, libre' } })
}

/* ---- LOCAL FORK PATCH: a character from imported photos ---- */
export const IMAGES_MAX = 12
export const REFERENCES_MAX = 5 // the profile photo takes the first of Klein's 6 reference places
export const ENTRAINEMENT_MAX = 30
/* Six scenes are enough to top up a set that already holds six or more real photos: pose and light. */
const SCENES_APPOINT = [0, 1, 4, 5, 8, 9].map(i => SCENES[i])
const IMAGE = /\.(png|jpe?g|webp)$/i

/** What `n` imported photos trigger (pure). 1: sheet + 12 scenes held by the profile photo alone.
 *  2-5: the same scenes, the other photos also given as references. 6 and more: only 6 scenes, the
 *  uploads go straight into the training set (from 2 photos on). */
export function planDepuisImages(n) {
  if (!Number.isInteger(n) || n < 1 || n > IMAGES_MAX) throw new Error(`importe de 1 à ${IMAGES_MAX} photos`)
  const scenes = n >= 6 ? SCENES_APPOINT : SCENES
  const uploads = n >= 2 ? n : 0
  return { scenes, references: Math.min(n - 1, REFERENCES_MAX), uploadsEntrainement: uploads, entrainement: Math.min(ENTRAINEMENT_MAX, scenes.length + uploads) }
}

/* One entry of `images`: an upload name (ComfyUI input folder, same rules as jobs.js: bare name,
   no leading dot, an image that exists) or the id of a library photo. */
function resoudreImage(entree) {
  const e = typeof entree === 'string' ? entree.trim() : ''
  if (!e || e.length > 160 || e.includes('\0')) throw new Error('photo invalide')
  if (IMAGE.test(e)) {
    if (/[\\/]/.test(e) || e.startsWith('.') || path.basename(e) !== e) throw new Error(`nom de photo invalide : ${nettoie(e, 40)}`)
    const chemin = path.join(CONFIG.comfyInput, e)
    let ok = false
    try { ok = fs.statSync(chemin).isFile() } catch { /* missing */ }
    if (!ok || !store.estInputStudio(e)) throw new Error(`photo introuvable : ${nettoie(e, 40)}`)
    return { cle: e, nom: e, chemin }
  }
  const a = store.getAsset(e)
  if (!a || a.media_type !== 'photo') throw new Error(`photo introuvable : ${nettoie(e, 40)}`)
  const chemin = path.join(CONFIG.mediaDir, path.basename(a.filename ?? a.uri))
  if (!IMAGE.test(chemin) || !fs.existsSync(chemin)) throw new Error(`photo introuvable : ${nettoie(e, 40)}`)
  // a library photo reaches the renders as a copy in the input folder
  return { cle: `asset:${a.id}`, nom: `CDI_${String(a.id).replace(/[^\w-]/g, '_').slice(0, 60)}${path.extname(chemin).toLowerCase()}`, chemin, copie: true }
}

/** Creates a character from 1 to 12 imported photos. `images`: upload names or library photo ids;
 *  `profil`: index into `images` or the entry itself (default: the first). `adulte` must be true:
 *  the person is an adult and agreed. `traits` is optional (age 21-80 required if given). Such a
 *  character is never marked fictitious: SFW only, adult mode stays locked (see fictif.js). */
export function creerDepuisImages({ images, profil, nom, traits, adulte, entrainer, moteurs, verifier }) {
  if (adulte !== true) throw new Error('confirme que la personne est majeure et a donné son accord')
  const aEntrainer = moteursChoisis(moteurs, entrainer)
  const n = nomValide(nom)
  if (!Array.isArray(images) || !images.length) throw new Error(`importe de 1 à ${IMAGES_MAX} photos`)
  if (images.length > IMAGES_MAX) throw new Error(`importe de 1 à ${IMAGES_MAX} photos`)
  const lues = images.map(resoudreImage)
  let i = profil === undefined || profil === null || profil === '' ? 0 : Number.isInteger(profil) ? profil : images.indexOf(profil)
  if (i < 0 || i >= lues.length) throw new Error('choisis la photo de profil parmi les photos importées')
  // the same photo twice counts once, the profile photo wins its place
  const uniques = []
  for (const l of [lues[i], ...lues.filter((_, k) => k !== i)]) if (!uniques.some(u => u.cle === l.cle || u.chemin === l.chemin)) uniques.push(l)
  const x = traits && typeof traits === 'object' && Object.keys(traits).length ? lireTraits(traits) : null
  const plan = planDepuisImages(uniques.length)
  const [pro, ...autres] = uniques
  const refs = autres.slice(0, plan.references)
  for (const r of refs) if (r.copie) { fs.copyFileSync(r.chemin, path.join(CONFIG.comfyInput, r.nom)); store.noterInput(r.nom, 'upload') }
  const etat = lancerCreation({ nom: n, x, src: pro.chemin, ancrageY: 0.15, fictif: false, scenes: plan.scenes, aEntrainer, verifier,
    refs: refs.map(r => r.nom), extras: plan.uploadsEntrainement ? uniques.map(u => u.chemin) : [],
    description: `${n} : personnage créé à partir de photos importées${x ? `, ${description(x)}` : ''}`,
    credit: { auteur: 'CreatorOS Studio', url: '', licence: 'personnage créé à partir de photos importées (personne majeure, accord confirmé par le propriétaire)' } })
  // the originals stay selectable for later trainings, even from a single photo
  noterImportees(etat?.personaId, uniques.map(u => u.chemin))
  return etat
}

/* ---- LOCAL FORK PATCH: the owner picks the training images (kanban tf-mwqowv3x-fqxc) ---- */
const EN_COURS = ['queued', 'rendering']
const scenesTerminees = c => c.images.every(j => { const s = store.getJob(j)?.status; return s && !EN_COURS.includes(s) })
const entrainementEnCours = c => (c.entrainements ?? []).some(e => EN_COURS.includes(store.getJob(e.job)?.status))
/* An imported photo as a training candidate: an upload lives in the ComfyUI input folder, a library photo in media. */
const candidatImporte = f => {
  const nom = path.basename(f)
  const url = path.resolve(path.dirname(f)) === path.resolve(CONFIG.comfyInput) ? `/api/uploads/${encodeURIComponent(nom)}` : `/media/${encodeURIComponent(nom)}`
  return { cle: `fichier:${nom}`, url, chemin: f, source: 'photo' }
}
/** Images a creation can train on: the generated scenes (library assets), then the imported photos
 *  (extras). `cle` is what entrainerSelection takes back, `url` what the browser shows, `chemin`
 *  stays on the server. An imported upload lives in the ComfyUI input folder, a library photo in media. */
function candidats(c) {
  const generes = c.images.flatMap(j => store.assetsOfJob(j).filter(a => !String(a.id).endsWith('-full')).map(a => {
    const nom = path.basename(a.filename ?? a.uri)
    return { cle: `asset:${a.id}`, url: `/media/${nom}`, chemin: path.join(CONFIG.mediaDir, nom), source: 'scene' }
  }))
  const importes = (c.extras ?? []).filter(f => fs.existsSync(f)).map(candidatImporte)
  const vus = new Set()
  return [...generes, ...importes].filter(x => fs.existsSync(x.chemin) && !vus.has(x.chemin) && vus.add(x.chemin))
}

/* Per character, the names of the photos it was created from: uploads in the ComfyUI input folder,
   not library assets. Kept apart from the creation tracking above, which forgets a creation after
   7 days — the character page's training must still offer them later. */
const FICHIER_IMPORTEES = path.join(CONFIG.dataDir, 'photos-importees.json')
const lireImportees = () => { try { return JSON.parse(fs.readFileSync(FICHIER_IMPORTEES, 'utf8')) ?? {} } catch { return {} } }
const nomSur = n => typeof n === 'string' && n && !n.includes('/') && !n.includes('\\') && !n.startsWith('.')
function noterImportees(personaId, fichiers) {
  // library photos are already offered as assets: only uploads are recorded
  const noms = fichiers.filter(f => path.resolve(path.dirname(f)) === path.resolve(CONFIG.comfyInput)).map(f => path.basename(f)).filter(nomSur)
  if (!personaId || !noms.length) return
  const r = lireImportees()
  const avant = Array.isArray(r[personaId]) ? r[personaId] : []
  const tous = [...new Set([...avant, ...noms])]
  if (tous.length === avant.length) return
  r[personaId] = tous
  try { fs.writeFileSync(FICHIER_IMPORTEES, JSON.stringify(r)) } catch (e) { console.warn(`[création] photos importées non enregistrées : ${e.message || e}`) }
}

/** The photos this character was created from, for the character page's training
 *  (POST /api/personas/:id/entrainer). `cle` is what that route takes back in `fichiers`; only keys
 *  from this list resolve, so no other upload is reachable through it. */
export function photosImportees(personaId) {
  // creations made before this record existed (still tracked: less than 7 days old)
  for (const c of suivis.values()) if (c.personaId === personaId) noterImportees(personaId, c.extras ?? [])
  const noms = lireImportees()[personaId]
  return (Array.isArray(noms) ? noms : []).filter(nomSur).map(n => path.join(CONFIG.comfyInput, n)).filter(f => fs.existsSync(f)).map(candidatImporte)
}

export function etatCreation(id) {
  const c = suivis.get(id)
  if (!c) return null
  const fait = c.images.filter(j => store.getJob(j)?.status === 'done').length
  const entrainements = (c.entrainements ?? (c.entrainement ? [{ moteur: 'klein', job: c.entrainement }] : [])).map(e => ({ ...e, statut: store.getJob(e.job)?.status ?? null }))
  const entrainementEtat = (() => { const l = (c.entrainements ?? []).map(e => store.getJob(e.job)?.status); return !l.length ? null : l.every(x => x === 'done') ? 'done' : l.some(x => x === 'rendering') ? 'rendering' : l.some(x => x === 'queued') ? 'queued' : l.at(-1) ?? null })()
  /* The pick is offered once the scenes are finished and no training runs: while the creation
     waits for it (verifier), and again after a training that did not finish (to train anew). */
  const choix = scenesTerminees(c) && !entrainementEnCours(c) && ((c.verifier && !c.entrainements?.length) || (entrainements.length > 0 && entrainementEtat !== 'done'))
  return { id, personaId: c.personaId, nom: c.nom, planche: store.getJob(c.planche)?.status ?? null, images: `${fait}/${c.images.length}`, entrainements, entrainementEtat,
    verifier: !!c.verifier, moteurs: c.moteurs ?? [], declencheur: c.declencheur,
    ...(choix ? { candidats: candidats(c).map(({ cle, url, source }) => ({ cle, url, source })), entrainementMax: ENTRAINEMENT_MAX } : {}) }
}

/** Starts the creation's training on the images the owner kept (`garder`: candidate keys from
 *  etatCreation, 8 to 30) and the checked engines (default: the ones chosen at creation, else Klein).
 *  Also the way to train anew after a failed or cancelled training. */
export function entrainerSelection(id, { garder: selection, moteurs } = {}) {
  const c = suivis.get(id)
  if (!c) throw new Error('création inconnue')
  if (!scenesTerminees(c)) throw new Error('les images du personnage ne sont pas encore prêtes')
  if (entrainementEnCours(c)) throw new Error('un entraînement de ce personnage est déjà en cours')
  const parCle = new Map(candidats(c).map(x => [x.cle, x.chemin]))
  const fichiers = [...new Set((Array.isArray(selection) ? selection : []).map(k => parCle.get(String(k))).filter(Boolean))]
  if (fichiers.length < 8) throw new Error('choisis au moins 8 images du personnage')
  if (fichiers.length > ENTRAINEMENT_MAX) throw new Error(`choisis au plus ${ENTRAINEMENT_MAX} images`)
  const choisis = moteursChoisis(moteurs, false)
  const liste = choisis.length ? choisis : c.moteurs?.length ? c.moteurs : ['klein']
  c.entrainements = liste.map(moteur => ({ moteur, job: enqueueEntrainement({ personaId: c.personaId, images: fichiers, declencheur: c.declencheur, pas: 1200, moteur }).id }))
  c.entrainer = true
  c.verifier = false
  c.moteurs = liste
  garder()
  return etatCreation(id)
}

setInterval(() => {
  for (const c of suivis.values()) {
    if (!c.entrainer || c.verifier || c.entrainement || c.entrainements?.length) continue
    const etats = c.images.map(j => store.getJob(j)?.status)
    if (etats.some(s => s !== 'done' && s !== 'blocked')) continue
    const generes = c.images.flatMap(j => store.assetsOfJob(j).filter(a => !String(a.id).endsWith('-full')).map(a => path.join(CONFIG.mediaDir, path.basename(a.filename))))
    // LOCAL FORK PATCH: imported photos join the generated images (creerDepuisImages)
    const fichiers = [...generes, ...(c.extras ?? []).filter(f => fs.existsSync(f))].slice(0, ENTRAINEMENT_MAX)
    try { c.entrainements = (c.moteurs?.length ? c.moteurs : ['klein']).map(moteur => ({ moteur, job: enqueueEntrainement({ personaId: c.personaId, images: fichiers, declencheur: c.declencheur, pas: 1200, moteur }).id })) }
    catch (e) { c.entrainer = false; console.warn(`[création ${c.id}] entraînement : ${e.message || e}`) }
    garder()
  }
}, 5000).unref()
