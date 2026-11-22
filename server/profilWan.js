/* ============================================================
   WAN profile: the AMD recipe twin, and the measured ceilings.

   DEUX mécanismes, un seul endroit :

   1. Le JUMEAU de recette (`<name>-rocm.json`). Une recette peut avoir un
      jumeau ROCm, adapté à ce qui manque sous ROCm (SageAttention,
      torch.compile, poids int8-convrot sans remplacement `sansCuda`), à une
      carte de 24 Go — et ici aux poids mesurés. `allege.js` échange déjà les
      poids des UNETLoader/CLIPLoader ; le jumeau prend le reste en charge.

      Deux familles de jumeaux, à ne pas confondre :
      - ceux des recettes swap / mix corrigent un poids qui ne CHARGE PAS sous
        ROCm : la machine les impose (recetteMachine), sinon la recette est
        morte ;
      - celui de WAN i2v est un PROFIL de rendu, pas une correction : c'est le
        job qui le choisit (see `wanProfil` in server/jobs.js), parce que
        l'opérateur garde la main. RECETTES_PROFILEES liste les recettes
        concernées ; loadWorkflow() ne leur applique jamais la règle implicite.

   2. capVideoAuxNormes() — un jumeau fixe les POIDS, mais la console continue
      d'envoyer ses propres dimensions, durée et cadence. Le profil AMD les
      RAMÈNE à ce qui a été mesuré, sans jamais les monter.

   MESURES (amdgpu-01, RX 7900 XTX 24 Go, 22.11 — ticket Kanban
   tf-mwrsdckx-mi9q, job WAN image→vidéo, 4+4 pas lightx2v, même graine) :

     704×1248 · 121 images · fp8_scaled → VAE-encode seul ≈27 min, puis
                                          ≈1000 s/pas → tué par le watchdog
     480×832  ·  81 images · 16 fps     → encode 12 s, ≈50-53 s/pas,
                                          ≈15-19 min tout compris (chargement
                                          à froid des modèles inclus)

      Quantisation, à cette taille : Q5_K_S 1005 s, fp8_scaled 758 s (sa partie
      high était encore chaude en RAM), Q8_0 1171 s — même temps de calcul
      (≈50-53 s/pas) ; l'écart vient du seul chargement à froid. Q5_K_S est
      retenu : ≈9 Go par partie au lieu de 14, il côtoie les LoRAs et
      l'encodeur de texte dans 24 Go et divise par deux le chargement à froid,
      à qualité égale (frame 40 côte à côte).

   Le plafond AMD est donc 480×832 (grand côté 832, le jumeau garde le
   portrait de la recette d'origine), 81 images, 16 fps. Une demande plus
   grosse est RÉDUITE, jamais refusée : au-delà de 832 px de grand côté,
   l'encode VAE seul dépasse la demi-heure.

   Env : CREATOROS_WAN_PROFIL = `amd` (le défaut sur ROCm, le jumeau) ou
   `original` (les poids et les réglages de la recette, comme sous NVIDIA). La
   console vidéo offre le même choix plan par plan ; sans lui, cette variable
   décide. La principale raison d'être de ce fichier est que ces chiffres
   vivent à un seul endroit, pas dans deux formulaires.
   ============================================================ */
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG } from './config.js'
import { estAmd } from './carteGraphique.js'

/** Grand côté, nombre d'images et cadence mesurés sur AMD (voir l'en-tête). */
export const WAN_AMD = { coteMax: 832, imagesMax: 81, fps: 16 }

/** Clip le plus long que ces plafonds autorisent : 81 images à 16 fps durent
 *  5,06 s, donc 5 s est la durée DEMANDÉE maximale dont le compte d'images (77,
 *  blocs de 4 + 1) reste sous 81. Réduire la demande plutôt que le graphe garde
 *  l'estimation, le graphe et le fichier livré d'accord. */
export const WAN_DUREE_AMD = 5

/** Recettes dont le jumeau ROCm est un PROFIL (choix du job) et non une
 *  correction imposée par la machine. */
export const RECETTES_PROFILEES = ['PROD_video_wan.json', 'PROD_video_wan_ctx.json']
export const estRecetteProfilable = file => RECETTES_PROFILEES.includes(String(file ?? '').split('/').pop())

/** 'amd' or 'original' : le défaut de la machine, avant tout choix utilisateur.
 *  `amd` et `env` sont injectables pour les tests ; le serveur les appelle nus. */
export function profilWanParDefaut({ amd = estAmd(), env = process.env } = {}) {
  const force = String(env.CREATOROS_WAN_PROFIL || '').trim().toLowerCase()
  if (force === 'original' || force === 'amd') return force
  return amd ? 'amd' : 'original'
}

/** Profil d'un job : son propre choix d'abord (la console peut toujours inverser
 *  le défaut, sur AMD comme ailleurs), puis celui de la machine. */
export function profilWanDemande(demande, parDefaut = profilWanParDefaut()) {
  return demande === 'original' || demande === 'amd' ? demande : parDefaut
}

/** Nom du jumeau d'une recette (`PROD_video_wan-rocm.json` pour
 *  `PROD_video_wan.json`). */
export const twinRocm = file => String(file).slice(0, -'.json'.length) + '-rocm.json'

/** Jumeau d'une recette quand il existe sur disque, sinon la recette elle-même :
 *  le garde d'appel unique, pour qu'un jumeau absent retombe sur l'original au
 *  lieu d'un ENOENT au chargement. */
export function twinSiPresent(file) {
  if (typeof file !== 'string' || !file.endsWith('.json') || file.endsWith('-rocm.json')) return file
  const rocm = twinRocm(file)
  return fs.existsSync(path.join(CONFIG.workflowsDir, rocm)) ? rocm : file
}

/** Recette à charger sur CETTE machine pour une recette NON profilée : le
 *  jumeau ROCm s'il existe. Les recettes profilées (WAN) passent par le job.
 *  `amd` est injectable pour les tests ; le serveur l'appelle nu. */
export function recetteMachine(file, { amd = estAmd() } = {}) {
  return amd && !estRecetteProfilable(file) ? twinSiPresent(file) : file
}

/** Recette WAN d'un JOB : le jumeau seulement quand le profil du job le demande.
 *  L'appelant passe son moteur résolu (le moteur par défaut est WAN, mais il
 *  n'est pas toujours écrit dans la demande). `recetteMachine` seul échangerait
 *  aussi les jumeaux des autres recettes (swap, mix) : ceux-là corrigent un
 *  poids qui ne charge pas sous ROCm, ce ne sont pas un profil de rendu. */
export function recetteWanPour(fichier, { videoEngine, wanProfil } = {}) {
  if (videoEngine !== 'wan' || wanProfil !== 'amd' || !estRecetteProfilable(fichier)) return fichier
  return twinSiPresent(fichier)
}

/** Arrondit un côté à un multiple de 16 (le bloc latent du VAE), en baissant,
 *  plancher 256 px comme partout dans le serveur. */
const cote16 = v => Math.max(256, Math.floor(v / 16) * 16)

/** Les modèles vidéo travaillent par blocs de 4 images + 1 : le plus grand bloc
 *  qui tienne sous `n`. */
const images4n1 = n => Math.max(5, Math.floor((Math.round(n) - 1) / 4) * 4 + 1)

/** Ramène un graphe vidéo (API format) x aux normes AMD : grand côté ≤ 832
 *  (orientation conservée), images ≤ 81, cadence = 16. Appelé APRÈS
 *  l'injection du job, qui peut retoucher les dimensions (un format 9:16 ramené
 *  à la surface du jumeau donne 480×848 : 16 px au-dessus du plafond mesuré).
 *  Ne remonte jamais ce que le graphe porte déjà. Renvoie les notes de ce qui a
 *  été réduit, et le compte d'images et la cadence RÉELLEMENT générés.
 *  Sans nœud vidéo (recette photo), c'est un no-op. */
export function capVideoAuxNormes(wf, normes = WAN_AMD) {
  const notes = []
  const out = { fps: null, frames: null }
  if (!wf || typeof wf !== 'object') return { notes, ...out }
  for (const [id, n] of Object.entries(wf)) {
    const cls = n?.class_type ?? ''
    const ins = n?.inputs
    if (!ins) continue
    if (/ImageToVideo/.test(cls) && typeof ins.width === 'number' && typeof ins.height === 'number') {
      const cote = Math.max(ins.width, ins.height)
      if (cote > normes.coteMax) {
        const k = normes.coteMax / cote
        const [w, h] = [cote16(ins.width * k), cote16(ins.height * k)]
        notes.push(`#${id} ${cls} = ${w}×${h} (ramené à ${normes.coteMax} px de grand côté, profil WAN AMD)`
          + ` — demandé ${ins.width}×${ins.height}`)
        ins.width = w; ins.height = h
      }
      if (typeof ins.length === 'number' && ins.length > normes.imagesMax) {
        notes.push(`#${id} ${cls}.length = ${images4n1(normes.imagesMax)} images (ramené à ${normes.imagesMax}, profil WAN AMD)`
          + ` — demandé ${ins.length}`)
        ins.length = images4n1(normes.imagesMax)
      }
    }
    if (cls === 'CreateVideo' && typeof ins.fps === 'number' && ins.fps > normes.fps) {
      notes.push(`#${id} CreateVideo.fps = ${normes.fps} (cadence native du modèle, profil WAN AMD)`
        + ` — demandé ${ins.fps}`)
      ins.fps = normes.fps
    }
  }
  const i2v = Object.values(wf).find(n => /ImageToVideo/.test(n?.class_type ?? '')
    && typeof n?.inputs?.length === 'number')
  if (i2v) out.frames = i2v.inputs.length
  const cv = Object.values(wf).find(n => n?.class_type === 'CreateVideo'
    && typeof n?.inputs?.fps === 'number')
  if (cv) out.fps = cv.inputs.fps
  return { notes, ...out }
}

/** Résumé lisible de ce que fait le profil AMD, pour la console et l'API (la
 *  bascule d'affichage du formulaire le montre). */
export const INFO_WAN_AMD = {
  coteMax: WAN_AMD.coteMax, imagesMax: WAN_AMD.imagesMax, fps: WAN_AMD.fps,
  dureeMax: WAN_DUREE_AMD, minutes: 17,
  /* The twin's own literals (its orientation is the original recipe's). */
  dimensions: '480×832',
  unet: ['wan2.2/quantstack/Wan2.2-I2V-A14B-HighNoise-Q5_K_S.gguf',
    'wan2.2/quantstack/Wan2.2-I2V-A14B-LowNoise-Q5_K_S.gguf'],
}
