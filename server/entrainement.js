/* Character training: a LoRA learned from 8 to 30 library images with ai-toolkit (ostris, MIT),
   for FLUX.2 Klein 9B or Krea 2. Owner only. The GPU goes to training: ComfyUI frees its memory
   first, the queue waits for the job to finish. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { CONFIG } from './config.js'
import { estAmd, estApple } from './carteGraphique.js'

/* One ai-toolkit per engine: FLUX 3 needs a recent version (flux3 arch), installed separately so
   the one training Klein and Krea is untouched. */
export const dossierAiToolkit = (moteur) => moteur === 'flux3'
  ? (process.env.CREATOROS_AI_TOOLKIT_FLUX3 || path.join(os.homedir(), 'ai-toolkit-flux3'))
  : (process.env.CREATOROS_AI_TOOLKIT || path.join(os.homedir(), 'ai-toolkit'))
export const aiToolkitPret = (moteur) => fs.existsSync(path.join(dossierAiToolkit(moteur), 'run.py'))
/* Local model folders, no hub access (CREATOROS_ENTRAINEMENT_MODELES): klein-9b/ (DiT + ae),
   krea2/raw.safetensors, flux3-klein-base/ (config, DiT, ae), qwen3-vl-4b-instruct/ and qwen-image/vae/.
   Without the variable, the hub ids (upstream behaviour). */
const MODELES_LOCAUX = process.env.CREATOROS_ENTRAINEMENT_MODELES || null
/* Apple Silicon (Metal/MPS): ai-toolkit runs on the mps device. bitsandbytes has no MPS kernel for
   its 8-bit optimizers (optimizer_update_8bit_blockwise), so plain AdamW: for a rank-32 LoRA the
   optimizer state is small either way. Ops missing on MPS fall back to the CPU. Text embeddings
   are cached up front and the text encoder unloaded: unified memory is shared with everything
   else, and re-encoding every step (Qwen3-8B for Klein) made the steps swap-bound. The DiT trains
   in bf16: on MPS ai-toolkit maps qfloat8 to convrot8, whose training path fake-quantizes and
   keeps a dequantized copy of every weight for the backward pass (Klein: 79 GB and 57 s/step
   quantized, 55 GB and 23 s/step in bf16 on a 64 GB M5 Pro). The text encoder stays quantized
   (inference only). Each engine carries its own measured Apple timings (`mac`); without them the
   engine is not offered on a Mac. CREATOROS_ENTRAINEMENT_FACTEUR scales every estimate. */
const SUR_MAC = estApple()
/* AMD / ROCm (gfx1100 and every RDNA card without native FP8/FP4). ai-toolkit runs on cuda:0 all
   the same — torch maps the HIP device there — but with a recipe of its own, measured on a 24 GB
   RX 7900 XTX (kanban tf-mwqgezhm-uo8c, attempt 8: 20/20 steps, 2.2-2.4 s/step, peak 15.3 GiB,
   LoRA written):
   - uint4 instead of qfloat8. qfloat8 runs forward but its backward falls back through
     optimum-quanto's qfallback to a plain matmul, which dies on HIPBLAS
     (`HIPBLAS_STATUS_ALLOC_FAILED when calling hipblasCreate`). Not trainable on this card.
   - low_vram: true streams one transformer block at a time onto the card while quantizing, instead
     of moving the whole fp state dict; that is what keeps the peak at 15 GiB.
   - plain AdamW: bitsandbytes' 8-bit kernels are not what this stack is measured with.
   - disable_sampling: true — in-training sampling deadlocks on ROCm.
   - layer_offloading: false — it SIGSEGVs on the first training step on Linux/HIP.
   - NO cache_text_embeddings, unlike the Mac: caching the captions first puts the bf16 Qwen3
     encoder on the card next to the quantized transformer, and that is where it OOMed here
     (23.26 of 23.98 GiB). Without the key the encoder still costs memory, but less of it.
   Also not carried over: use_uint4_cache (it writes next to the model, and the training view of
   the models is read-only here), so every run quantizes again — 12 s measured for both models.
   - MIOpen off (torch.backends.cudnn.enabled = False, set by LANCEUR_AMD before run.py). The VAE
     encode that fills the latent cache goes through MIOpen convolutions, and on gfx1100 those are
     not deterministic: the same image encodes to different latents on every call, sometimes NaN or
     garbage (kanban tf-mwqowqjq-bnxr: one cached latent at absmax 126464 instead of ~5, the LoRA
     went NaN on step 2 and the run died at 51/1200). With MIOpen off torch uses its own convolution
     kernels: 6 images x 4 encodes came out identical and finite. The transformer has no
     convolutions, so training itself is unaffected. */
const SUR_AMD = estAmd()
const LANCEUR_AMD = "import runpy, sys, torch; torch.backends.cudnn.enabled = False; sys.argv = ['run.py', *sys.argv[1:]]; runpy.run_path('run.py', run_name='__main__')"
/* ai-toolkit replaces a non-finite loss by zero and keeps going: once the LoRA weights are NaN
   every following step is "loss is nan", the run burns its whole budget and ends on an unrelated
   error (or writes a NaN LoRA). That many NaN steps in a row, with no finite loss in between,
   stops it with a clear message instead. A stray NaN step (ai-toolkit's own guard) stays harmless. */
const NAN_SUITE_MAX = 10
/* Resolution buckets and LoRA rank, overridable so a host can cap what its card can hold (on
   24 GB: CREATOROS_ENTRAINEMENT_RESOLUTION=512,768) without a fork. Defaults are upstream. */
const RESOLUTION = (process.env.CREATOROS_ENTRAINEMENT_RESOLUTION || '512, 768, 1024')
  .split(/[, ]+/).map(x => Number(x)).filter(Number.isFinite)
const RANG = Number(process.env.CREATOROS_ENTRAINEMENT_RANK) > 0 ? Number(process.env.CREATOROS_ENTRAINEMENT_RANK) : 32
/* AMD configurations measured end to end (Klein), keyed rank@sorted buckets. Anything else has
   no measurement on AMD, so no number is invented for it — the estimate stays null and the UI
   says so. All four fit the 24 GB card once expandable_segments is off (it silently corrupts
   live tensors on gfx1100, pytorch#204212). */
const MESURES_AMD = {
  '16@512': { secParPas: 2.4, preparationS: 45 },
  // Klein on gfx1100, 100 steps each, 17 images, PYTORCH_HIP_ALLOC_CONF unset: peak 15.9 / 15.5 / 19.2 GiB
  '32@512,768': { secParPas: 3.3, preparationS: 45 },
  '32@768': { secParPas: 4.0, preparationS: 45 },
  '32@512,768,1024': { secParPas: 4.5, preparationS: 45 },
}
const MESURE_AMD = SUR_AMD ? MESURES_AMD[`${RANG}@${[...RESOLUTION].sort((a, b) => a - b).join(',')}`] ?? null : null
const FACTEUR_DUREE = Number(process.env.CREATOROS_ENTRAINEMENT_FACTEUR) || 1
const local = (...p) => path.join(MODELES_LOCAUX, ...p)
const present = f => fs.existsSync(f) ? f : null
/* Raw Krea 2 weights (training does not use the turbo version): CREATOROS_KREA2_RAW,
   otherwise ComfyUI's model folders (extra_model_paths.yaml included). */
function poidsKrea2() {
  if (process.env.CREATOROS_KREA2_RAW) return process.env.CREATOROS_KREA2_RAW
  if (MODELES_LOCAUX) return present(local('krea2', 'raw.safetensors'))
  const bases = [path.join(CONFIG.comfyDir, 'models')]
  try {
    for (const m of fs.readFileSync(path.join(CONFIG.comfyDir, 'extra_model_paths.yaml'), 'utf8').matchAll(/^\s*base_path:\s*(\S+)/gm)) bases.push(m[1].replace(/^~/, os.homedir()))
  } catch { /* no extra paths */ }
  return bases.map(b => path.join(b, 'diffusion_models', '_krea2', 'krea2_raw_bf16.safetensors')).find(f => fs.existsSync(f)) ?? null
}

/** Engines the studio can train a LoRA for, with the measured duration per step (RTX 5090; `mac`:
    M5 Pro 64 GB, 5 images, buckets 512/768/1024, warm model cache; `amd`: only where an AMD run was
    actually measured — see MESURE_AMD — and `surAmd`: whether a training through this engine ever
    finished on a Radeon card). */
export const MOTEURS_ENTRAINEMENT = {
  // local: the Qwen3-8B text encoder stays a hub id (fixed in ai-toolkit), served from the HF cache
  klein: { nom: 'FLUX.2 Klein', secParPas: 1.5, preparationS: 180, mac: { secParPas: 23, preparationS: 300 }, surAmd: true,
    /* Measured on gfx1100 / 24 GB (see MESURES_AMD): only those bucket/rank combinations carry a
       number — setting CREATOROS_ENTRAINEMENT_RANK or _RESOLUTION to anything else drops it
       rather than extrapolating. */
    amd: MESURE_AMD, modele: () => {
    const chemin = MODELES_LOCAUX ? present(local('klein-9b', 'flux-2-klein-base-9b.safetensors')) && local('klein-9b') : 'black-forest-labs/FLUX.2-klein-base-9B'
    return chemin ? { arch: 'flux2_klein_9b', chemin } : null
  } },
  krea: { nom: 'Krea 2', secParPas: 2.7, preparationS: 240, mac: { secParPas: 22, preparationS: 600 },
    /* no `surAmd` and no `amd` on purpose: never trained on a Radeon (Krea 2 brings its own
       Qwen3-VL encoder and raw weights, so the Klein recipe is not transferable evidence).
       Ticket tf-mwqgezhm-uo8c, step S6, is what would change this. */
    modele: () => {
    const f = poidsKrea2()
    if (!f) return null
    if (!MODELES_LOCAUX) return { arch: 'krea2', chemin: f }
    const te = present(local('qwen3-vl-4b-instruct')), vae = present(local('qwen-image', 'vae')) && local('qwen-image')
    return te && vae ? { arch: 'krea2', chemin: f, kwargs: { text_encoder_path: te, vae_path: vae } } : null
  } },
  /* FLUX 3 Image Klein: trained on Klein Base (FLUX Kommunity license accepted on Hugging Face), applied
     to the studio's distilled model. 5.6B parameters: fits in bf16 without quantization. */
  flux3: { nom: 'FLUX 3 Klein', secParPas: 2, preparationS: 300, mac: { secParPas: 11.2, preparationS: 420 }, modele: () => {
    if (!MODELES_LOCAUX) return { arch: 'flux3', chemin: 'black-forest-labs/flux-3-image-klein-base', sansQuantif: true }
    const chemin = present(local('flux3-klein-base', 'model.safetensors')) && local('flux3-klein-base'), te = present(local('qwen3-vl-4b-instruct'))
    return chemin && te ? { arch: 'flux3', chemin, sansQuantif: true, kwargs: { text_encoder_path: te } } : null
  } },
}
/* Trainability on this machine, following the Mac's rule that an engine without a number is not
   offered — with one difference, because on AMD the recipe belongs to the card and not to the
   engine: here `surAmd` records whether a training through this engine ever finished on a Radeon,
   and the `amd` timings only ever carry a measured number. So an engine that runs on AMD but was
   not measured (the fork default: rank 32 on three buckets) is still offered and says "unknown",
   instead of the Mac's "base model missing" — which would be a lie about the model, and would make
   the host's resolution cap switch the engine off entirely. */
const pretSurCarte = m => SUR_MAC ? !!m.mac : SUR_AMD ? m.surAmd === true : true
export const moteurEntrainementPret = m => !!MOTEURS_ENTRAINEMENT[m] && pretSurCarte(MOTEURS_ENTRAINEMENT[m]) && aiToolkitPret(m) && !!MOTEURS_ENTRAINEMENT[m].modele()
/** Timings of an engine on this machine (Apple values on a Mac, the measured AMD run on Radeon),
    scaled by FACTEUR_DUREE. Null when the machine has no measurement for that engine — a duration
    is never invented; the UI then says it is unknown. */
export const tempsEntrainement = moteur => {
  const m = MOTEURS_ENTRAINEMENT[moteur] ?? MOTEURS_ENTRAINEMENT.klein
  if (SUR_AMD) return m.amd ? { secParPas: m.amd.secParPas * FACTEUR_DUREE, preparationS: m.amd.preparationS * FACTEUR_DUREE } : { secParPas: null, preparationS: null }
  const t = (SUR_MAC && m.mac) ? m.mac : m
  return { secParPas: t.secParPas * FACTEUR_DUREE, preparationS: t.preparationS * FACTEUR_DUREE }
}
export const dureeEstimeeMs = (moteur, pas) => { const t = tempsEntrainement(moteur); return t.secParPas == null ? null : Math.round((pas * t.secParPas + t.preparationS) * 1000) }

const pythonAiToolkit = (moteur) => [path.join(dossierAiToolkit(moteur), 'venv', 'bin', 'python'), path.join(dossierAiToolkit(moteur), '.venv', 'bin', 'python')].find(f => fs.existsSync(f)) ?? 'python3'

/** Prepares the image set and config; returns the yaml path. */
export function preparerEntrainement({ id, images, declencheur, pas, moteur = 'klein', legendes = null }) {
  const modele = MOTEURS_ENTRAINEMENT[moteur]?.modele()
  if (!modele) throw new Error(`entraînement ${moteur} indisponible sur ce studio`)
  const racine = path.join(CONFIG.dataDir, 'entrainements', id)
  const ds = path.join(racine, 'images')
  fs.mkdirSync(ds, { recursive: true })
  images.forEach((f, i) => {
    const ext = path.extname(f) || '.png'
    fs.copyFileSync(f, path.join(ds, `${String(i).padStart(3, '0')}${ext}`))
    // detailed caption if provided (the model then separates the face from framing, outfit and light)
    const l = Array.isArray(legendes) && typeof legendes[i] === 'string' && legendes[i].trim() ? legendes[i].trim().slice(0, 600) : null
    fs.writeFileSync(path.join(ds, `${String(i).padStart(3, '0')}.txt`), l ? (l.toLowerCase().includes(declencheur) ? l : `${declencheur}, ${l}`) : `${declencheur}, photo of ${declencheur}`)
  })
  /* One line per platform, so the CUDA and Mac output stays exactly what it was: only the AMD card
     changes the optimizer, adds the sampling guard and replaces the quantization recipe. */
  const OPTIMISEUR = SUR_MAC || SUR_AMD ? 'adamw' : 'adamw8bit'
  const SANS_QUANTIF = modele.sansQuantif || SUR_MAC
  const LIGNES_POIDS = SUR_AMD
    /* uint4 on both sides (gfx1100 has no FP8/FP4), low_vram for the blockwise quantization stream,
       layer_offloading explicitely off — see the note on SUR_AMD above. An unquantized transformer
       (flux3) only gets the encoder's qtype, as on the Mac; low_vram stays on, it offloads loading
       as well as quantizing. */
    ? `${SANS_QUANTIF ? 'qtype_te: uint4' : 'qtype: uint4\n        qtype_te: uint4'}\n        low_vram: true\n        layer_offloading: false`
    : SANS_QUANTIF ? 'qtype_te: qfloat8' : 'qtype: qfloat8'
  const LIGNES_TRAIN = `${SUR_AMD ? '        disable_sampling: true\n' : ''}${SUR_MAC ? '        cache_text_embeddings: true\n' : ''}`
  const yaml = `job: extension
config:
  name: "${id}"
  process:
    - type: 'sd_trainer'
      training_folder: "${path.join(racine, 'sortie')}"
      device: ${SUR_MAC ? 'mps' : 'cuda:0'}
      trigger_word: "${declencheur}"
      network: { type: "lora", linear: ${RANG}, linear_alpha: ${RANG} }
      save: { dtype: float16, save_every: ${pas}, max_step_saves_to_keep: 1, push_to_hub: false }
      datasets:
        - folder_path: "${ds}"
          caption_ext: "txt"
          caption_dropout_rate: 0.05
          cache_latents_to_disk: true
          resolution: [ ${RESOLUTION.join(', ')} ]
      train:
        batch_size: 1
        steps: ${pas}
        gradient_accumulation_steps: 1
        train_unet: true
        train_text_encoder: false
        gradient_checkpointing: true
        noise_scheduler: "flowmatch"
        timestep_type: weighted
        optimizer: "${OPTIMISEUR}"
${LIGNES_TRAIN}        lr: 1e-4
        dtype: bf16
      model:
        arch: ${modele.arch}
        name_or_path: "${modele.chemin}"
        quantize: ${SANS_QUANTIF ? 'false' : 'true'}
        quantize_te: true
        ${LIGNES_POIDS}
${modele.kwargs ? `        model_kwargs:\n${Object.entries(modele.kwargs).map(([k, v]) => `          ${k}: "${v}"`).join('\n')}\n` : ''}`
  const f = path.join(racine, 'config.yaml')
  fs.writeFileSync(f, yaml)
  return { config: f, sortie: path.join(racine, 'sortie', id), moteur }
}

/** Runs ai-toolkit; `progres(n, total)` tracks steps. Resolves with the LoRA path. */
const processus = new Map()
/** Stops a running training (its process group); returns true if it was running. */
export function arreterEntrainement(id) {
  const p = processus.get(id)
  if (!p) return false
  try { process.kill(-p.pid, 'SIGTERM') } catch { try { p.kill('SIGTERM') } catch { /* already finished */ } }
  return true
}
export function entrainer({ id, config, sortie, pas, moteur }, progres) {
  return new Promise((ok, ko) => {
    const env = { ...process.env, PYTHONUNBUFFERED: '1', ...(SUR_MAC ? { PYTORCH_ENABLE_MPS_FALLBACK: '1' } : {}) }
    const args = SUR_AMD ? ['-c', LANCEUR_AMD, config] : ['run.py', config]
    const p = spawn(pythonAiToolkit(moteur), args, { cwd: dossierAiToolkit(moteur), env, detached: true })
    if (id) processus.set(id, p)
    // full ai-toolkit output next to the config: a failed run otherwise only reports its exit code
    const journal = fs.createWriteStream(path.join(path.dirname(config), 'ai-toolkit.log'), { flags: 'a' })
    p.on('close', () => journal.end())
    let reste = ''
    let nanSuite = 0, nanArret = false
    const lire = b => {
      journal.write(b)
      const t = reste + b.toString(); const l = t.split(/[\r\n]/); reste = l.pop() ?? ''
      for (const x of l) {
        const m = /(\d+)\/(\d+) \[/.exec(x); if (m && Number(m[2]) === pas) progres(Number(m[1]), pas)
        // a finite, non-zero loss on the progress bar resets the streak (a NaN step shows loss 0)
        const perte = /loss: ([0-9.e+-]+)/.exec(x)
        if (perte && Number(perte[1]) > 0) nanSuite = 0
        if (/loss is nan/i.test(x) && ++nanSuite >= NAN_SUITE_MAX && !nanArret) {
          nanArret = true
          journal.write(`\n[studio] ${NAN_SUITE_MAX} pas de suite en NaN : entraînement arrêté\n`)
          try { process.kill(-p.pid, 'SIGTERM') } catch { try { p.kill('SIGTERM') } catch { /* already finished */ } }
        }
      }
    }
    p.stdout.on('data', lire); p.stderr.on('data', lire)
    p.on('error', ko)
    p.on('close', code => {
      if (id) processus.delete(id)
      if (nanArret) return ko(new Error('entraînement arrêté : la perte est devenue NaN (une image ou son latent est illisible), aucune LoRA produite'))
      if (code !== 0) return ko(new Error(`ai-toolkit s'est arrêté (code ${code})`))
      const f = fs.existsSync(sortie) ? fs.readdirSync(sortie).filter(x => x.endsWith('.safetensors')).sort().pop() : null
      f ? ok(path.join(sortie, f)) : ko(new Error('LoRA non produite'))
    })
  })
}
