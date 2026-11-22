/* Unit tests of the WAN AMD profile (profilWan.js): the recipe twin selection,
   the ceilings forced on a graph, and the contents of the served twin file.
   `estAmd()` is INJECTED (a real GPU probe would make the test machine
   dependent). Run: npm test */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG } from './config.js'
import { INFO_WAN_AMD, RECETTES_PROFILEES, WAN_AMD, WAN_DUREE_AMD, capVideoAuxNormes,
  estRecetteProfilable, profilWanDemande, profilWanParDefaut, recetteMachine, recetteWanPour, twinRocm } from './profilWan.js'

const ORIGINE = 'PROD_video_wan.json'
const JUMEAU = 'PROD_video_wan-rocm.json'
const lire = f => JSON.parse(fs.readFileSync(path.join(CONFIG.workflowsDir, f), 'utf8'))
const chargeurs = g => Object.values(g).filter(n => /UNETLoader|UnetLoaderGGUF$/.test(n.class_type))
const noeud = (g, cls) => Object.values(g).find(n => n.class_type === cls)

/* ---------- the twin exists, and is the twin we measured ---------- */

test('le jumeau AMD charge les GGUF Q5_K_S et les normes mesurées', () => {
  const g = lire(JUMEAU)
  const ch = chargeurs(g)
  assert.equal(ch.length, 2, 'deux chargeurs de poids, un par étage de bruit')
  assert.deepEqual(ch.map(n => n.class_type).sort(), ['UnetLoaderGGUF', 'UnetLoaderGGUF'],
    'ComfyUI-GGUF remplace UNETLoader (fp8 scaled est émulé sous ROCm)')
  assert.deepEqual(ch.map(n => n.inputs.unet_name).sort(), [
    'wan2.2/quantstack/Wan2.2-I2V-A14B-HighNoise-Q5_K_S.gguf',
    'wan2.2/quantstack/Wan2.2-I2V-A14B-LowNoise-Q5_K_S.gguf',
  ])
  for (const n of ch) assert.ok(!('weight_dtype' in n.inputs), 'UnetLoaderGGUF ne connaît pas weight_dtype')
  const i2v = noeud(g, 'WanImageToVideo')
  // Portrait, comme la recette d'origine: 704x1248 x 121 images y avait tué le job.
  assert.equal(Math.max(i2v.inputs.width, i2v.inputs.height), WAN_AMD.coteMax)
  assert.equal(i2v.inputs.width, 480, 'le jumeau garde le portrait de la recette')
  assert.equal(i2v.inputs.height, 832)
  assert.equal(i2v.inputs.length, WAN_AMD.imagesMax, '81 images = la durée mesurée')
  assert.equal(noeud(g, 'CreateVideo').inputs.fps, WAN_AMD.fps, 'cadence native du modèle')
})

test('le jumeau ne change que les poids, la durée et les dimensions', () => {
  const a = lire(ORIGINE), b = lire(JUMEAU)
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), 'mêmes nœuds')
  /* Only these inputs may differ — everything else (lightx2v LoRAs, euler/simple
     sampling, shift 5, the VAE and the text encoder) is the original recipe. */
  const CHARGEURS = ['110', '111']
  const AUTORISES = { '98': ['width', 'height', 'length'], '94': ['fps'] }
  for (const [id, n] of Object.entries(a)) {
    const m = b[id]
    if (CHARGEURS.includes(id)) {
      assert.equal(m.class_type, 'UnetLoaderGGUF', `#${id} : UNETLoader → UnetLoaderGGUF`)
      assert.deepEqual(Object.keys(m.inputs), ['unet_name'], `#${id} : le chargeur GGUF n’a que son fichier`)
      continue
    }
    if (AUTORISES[id]) {
      for (const cle of Object.keys(n.inputs))
        if (!AUTORISES[id].includes(cle)) assert.deepEqual(m.inputs[cle], n.inputs[cle], `#${id}.${cle} doit être identique`)
      continue
    }
    assert.deepEqual(m, n, `nœud ${id} (${n.class_type}) doit être identique`)
  }
})

test('RECETTES_PROFILEES ne contient que les recettes WAN i2v', () => {
  assert.deepEqual(RECETTES_PROFILEES, [ORIGINE, 'PROD_video_wan_ctx.json'])
  assert.ok(estRecetteProfilable(ORIGINE))
  assert.ok(!estRecetteProfilable('PROD_swap_scail2.json'))
})

/* ---------- selection: machine default, job choice, env pin ---------- */

test('estAmd() vrai : le profil par défaut est le jumeau, avec Q5 et 81 images', () => {
  assert.equal(profilWanParDefaut({ amd: true, env: {} }), 'amd')
  // The job's recipe is served as its twin, and the twin really is the Q5 graph.
  assert.equal(recetteWanPour(ORIGINE, { videoEngine: 'wan', wanProfil: 'amd' }), JUMEAU)
  const g = lire(recetteWanPour(ORIGINE, { videoEngine: 'wan', wanProfil: 'amd' }))
  assert.deepEqual(chargeurs(g).map(n => n.class_type).sort(), ['UnetLoaderGGUF', 'UnetLoaderGGUF'])
  assert.ok(chargeurs(g).every(n => /Q5_K_S\.gguf$/.test(n.inputs.unet_name)))
  assert.equal(noeud(g, 'WanImageToVideo').inputs.length, 81)
})

test('estAmd() faux : rien n’est changé — ni le profil par défaut, ni la recette', () => {
  assert.equal(profilWanParDefaut({ amd: false, env: {} }), 'original')
  // A CUDA machine must load the shipped recipe, untouched.
  assert.equal(recetteMachine(ORIGINE, { amd: false }), ORIGINE)
  assert.equal(recetteWanPour(ORIGINE, { videoEngine: 'wan', wanProfil: 'original' }), ORIGINE)
  const g = lire(ORIGINE)
  assert.deepEqual(chargeurs(g).map(n => n.inputs.unet_name).sort(), [
    'wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors',
    'wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors',
  ])
  assert.equal(noeud(g, 'WanImageToVideo').inputs.length, 121)
})

test('le job garde la main : « original » sur une carte AMD, « amd » sur une CUDA', () => {
  const defautAmde = profilWanParDefaut({ amd: true, env: {} })
  assert.equal(profilWanDemande('original', defautAmde), 'original', 'choix explicite, jamais bloqué')
  assert.equal(profilWanDemande(undefined, defautAmde), 'amd', 'sans choix : le défaut de la carte')
  assert.equal(profilWanDemande('amd', 'original'), 'amd', 'et l’inverse aussi')
  assert.equal(profilWanDemande('n importe quoi', 'original'), 'original', 'valeur inconnue : le défaut')
  // On CUDA with an explicit `amd` choice, the twin is still the Q5 graph.
  assert.equal(recetteWanPour(ORIGINE, { videoEngine: 'wan', wanProfil: 'amd' }), JUMEAU)
})

test('CREATOROS_WAN_PROFIL épingle le défaut des deux côtés', () => {
  assert.equal(profilWanParDefaut({ amd: true, env: { CREATOROS_WAN_PROFIL: 'original' } }), 'original')
  assert.equal(profilWanParDefaut({ amd: false, env: { CREATOROS_WAN_PROFIL: 'amd' } }), 'amd')
  assert.equal(profilWanParDefaut({ amd: true, env: { CREATOROS_WAN_PROFIL: ' AMD ' } }), 'amd', 'casse et espaces ignorés')
  assert.equal(profilWanParDefaut({ amd: true, env: { CREATOROS_WAN_PROFIL: 'radica' } }), 'amd', 'valeur inconnue : le défaut de la carte')
})

test('une recette non profilée garde la règle implicite, une profilée non', () => {
  // swap/mix: their twin fixes a weight ROCm cannot load → the machine imposes it.
  assert.equal(recetteMachine('PROD_swap_scail2.json', { amd: true }), 'PROD_swap_scail2-rocm.json')
  // WAN: the profile decides, so loadWorkflow() must never swap it implicitly.
  assert.equal(recetteMachine(ORIGINE, { amd: true }), ORIGINE)
  // A twin that is not on disk is not selected (a partial install renders anyway).
  assert.equal(recetteMachine('PROD_video_ltx_hq.json', { amd: true }), 'PROD_video_ltx_hq.json')
  assert.equal(recetteWanPour('PROD_video_wan_ctx.json', { videoEngine: 'wan', wanProfil: 'amd' }),
    'PROD_video_wan_ctx.json', 'aucun jumeau ctx sur disque : la recette d’origine')
  // Other engines and profiles leave the recipe alone.
  assert.equal(recetteWanPour(ORIGINE, { videoEngine: 'ltx_hq', wanProfil: 'amd' }), ORIGINE)
  assert.equal(recetteWanPour(ORIGINE, {}), ORIGINE)
  assert.equal(twinRocm(ORIGINE), JUMEAU)
})

/* ---------- the ceilings, applied AFTER injection ---------- */

test('le plafond ramène le 9:16 recalculé par l’injection à 480×832', () => {
  /* The recipe's area (480×832 = 0,4 MP) at 9:16 gives 480×848: 16 px over the
     measured long side. This is exactly why the cap runs after injectJob. */
  const g = { '98': { class_type: 'WanImageToVideo', inputs: { width: 480, height: 848, length: 81 } },
    '94': { class_type: 'CreateVideo', inputs: { fps: 16 } } }
  const r = capVideoAuxNormes(g)
  assert.deepEqual([g['98'].inputs.width, g['98'].inputs.height], [464, 832], 'multiple de 16, grand côté à 832')
  assert.equal(g['98'].inputs.length, 81, 'sous le plafond : rien n’est baissé')
  assert.equal(g['94'].inputs.fps, 16)
  assert.equal(r.notes.length, 1)
  assert.equal(r.frames, 81)
})

test('le plafond réduit sans jamais monter, aux blocs de 4+1', () => {
  const g = { '98': { class_type: 'WanImageToVideo', inputs: { width: 720, height: 1280, length: 121 } },
    '94': { class_type: 'CreateVideo', inputs: { fps: 24 } } }
  const r = capVideoAuxNormes(g)
  assert.equal(Math.max(g['98'].inputs.width, g['98'].inputs.height), 832)
  assert.ok(g['98'].inputs.width < g['98'].inputs.height, 'le portrait est conservé')
  assert.equal(g['98'].inputs.length, 81, '121 images ramenées au bloc de 4+1 qui tient sous 81')
  assert.equal(g['94'].inputs.fps, 16)
  assert.equal(r.notes.length, 3, 'dimensions, images et cadence : trois notes de provenance')
  // A smaller request stays smaller: the cap never raises anything.
  const petit = { '98': { class_type: 'WanFirstLastFrameToVideo', inputs: { width: 384, height: 640, length: 33 } },
    '94': { class_type: 'CreateVideo', inputs: { fps: 16 } } }
  assert.deepEqual(capVideoAuxNormes(petit).notes, [])
  assert.deepEqual([petit['98'].inputs.width, petit['98'].inputs.length], [384, 33])
  // Landscape follows the same ceiling (the choice of the shot, not of the profile).
  const paysage = { '98': { class_type: 'WanImageToVideo', inputs: { width: 1280, height: 720, length: 81 } } }
  assert.equal(capVideoAuxNormes(paysage).notes.length, 1)
  assert.equal(Math.max(paysage['98'].inputs.width, paysage['98'].inputs.height), 832)
  assert.ok(paysage['98'].inputs.width > paysage['98'].inputs.height)
  // A photo graph is untouched.
  assert.deepEqual(capVideoAuxNormes({ '40': { class_type: 'KSampler', inputs: { seed: 1 } } }).notes, [])
})

test('la durée maximale du profil est ce que les 81 images supportent', () => {
  assert.equal(WAN_DUREE_AMD, 5)
  // 5 s at the recipe's 24 fps would be 121 images (the measured killer): the
  // profile must therefore also fix the cadence.
  const fps24 = { '98': { class_type: 'WanImageToVideo', inputs: { width: 480, height: 832, length: 121 } } }
  assert.equal(capVideoAuxNormes(fps24).frames, 81)
  assert.equal(INFO_WAN_AMD.dureeMax, WAN_DUREE_AMD)
  assert.equal(INFO_WAN_AMD.coteMax, WAN_AMD.coteMax)
})
