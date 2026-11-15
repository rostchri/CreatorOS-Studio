/* LOCAL FORK PATCH: maintenance of fictitious characters (see server/fictif.js). Run with the
   studio's environment (same CREATOROS_* variables, same data directory). Changes nothing
   without --appliquer.

     node scripts/fictif.mjs etat
         each character: "fictitious" flag, profile photo, LoRAs and their attestation
     node scripts/fictif.mjs prouver <character> <asset> [--appliquer]
         sets the flag back when the profile photo is, byte for byte, the character creator's crop
         of that asset and the asset is a text-only portrait (e.g. a character created before the
         flag existed)
     node scripts/fictif.mjs rattraper [--appliquer]
         attests the LoRAs of fictitious characters from the training job that produced them,
         with the same checks as at the end of a training */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { CONFIG } from '../server/config.js'
import * as store from '../server/db.js'
import { marquerFictif, personas } from '../server/persona.js'
import { attesterLora, attestations, avatarDe, loraFictive, nonFictive, portraitSurTexteSeul, sha256 } from '../server/fictif.js'

const [cmd, ...args] = process.argv.slice(2)
const appliquer = args.includes('--appliquer')
const pos = args.filter(a => !a.startsWith('--'))
const lorasDe = p => [...p.loras, ...p.lorasKlein, ...(p.lorasFlux3 ?? []), ...p.videoLoras].map(l => l.name)

if (cmd === 'etat') {
  const att = attestations()
  for (const p of personas().list) {
    const av = avatarDe(p.id)
    console.log(`${p.id} · fictif=${p.fictif === true} · photo=${av ? path.basename(av) : 'aucune'}`)
    for (const n of lorasDe(p)) console.log(`   ${n} · ${await loraFictive(n, p.id) ? 'attestée' : att[n] ? 'attestation caduque' : 'non attestée'}`)
  }
} else if (cmd === 'prouver') {
  const [id, assetId] = pos
  const p = personas().list.find(x => x.id === id)
  const a = store.getAsset(String(assetId ?? ''))
  if (!p || !a) throw new Error('usage : prouver <personnage> <asset>')
  if (!portraitSurTexteSeul(a)) throw new Error(`${assetId} n'est pas un portrait rendu sur texte seul`)
  const av = avatarDe(id)
  if (!av || path.extname(av) !== '.jpg') throw new Error(`${id} : la photo de profil n'est pas celle du créateur (avatar.jpg)`)
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fictif-')), 'avatar.jpg')
  // the character creator's crop, unchanged (createurPersonnage.creerPersonnage)
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(CONFIG.mediaDir, path.basename(a.filename ?? a.uri)), '-vf', 'crop=min(iw\\,ih):min(iw\\,ih),scale=512:512', '-q:v', '3', tmp])
  const [h1, h2] = [await sha256(tmp), await sha256(av)]
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true })
  if (h1 !== h2) throw new Error(`${id} : la photo de profil n'est pas le recadrage de ${assetId}`)
  console.log(`${id} : photo de profil = recadrage du portrait sur texte seul ${assetId} (sha256 ${h1.slice(0, 16)}…)`)
  if (appliquer) { marquerFictif(id, true); console.log(`${id} : marqué fictif`) }
  else console.log('(simulation : --appliquer pour marquer le personnage fictif)')
} else if (cmd === 'rattraper') {
  for (const p of personas().list.filter(x => x.fictif === true)) {
    for (const n of lorasDe(p)) {
      if (await loraFictive(n, p.id)) { console.log(`${p.id} · ${n} · déjà attestée`); continue }
      const m = /^(.+)_(klein|krea|flux3)_([a-z0-9]+)\.safetensors$/.exec(path.basename(n))
      const j = m && store.getJob(`train-${m[3]}`)
      let pl = null
      try { pl = JSON.parse(j?.payload ?? 'null') } catch { /* unreadable */ }
      const origine = j && pl && j.status === 'done' && j.persona_id === p.id && !pl.entrainementEssai
        && (pl.entrainementMoteur ?? 'klein') === m[2] && m[1] === String(p.id).replace(/[^a-z0-9_]/g, '')
      if (!origine) { console.log(`${p.id} · ${n} · non attestable : pas d'entraînement terminé de ce personnage à son origine`); continue }
      let refus = null
      for (const f of pl.entrainementImages ?? []) if ((refus = await nonFictive(f, p.id))) { refus = `${path.basename(f)} : ${refus}`; break }
      if (!refus && !(pl.entrainementImages ?? []).length) refus = 'aucune image d’entraînement'
      if (refus) { console.log(`${p.id} · ${n} · refusée (${j.id}) : ${refus}`); continue }
      if (!appliquer) { console.log(`${p.id} · ${n} · attestable (${j.id}, ${pl.entrainementImages.length} images)`); continue }
      const r = await attesterLora(n, p.id, j.id, pl.entrainementImages)
      console.log(`${p.id} · ${n} · ${r ? `refusée : ${r}` : `attestée (${j.id})`}`)
    }
  }
  if (!appliquer) console.log('(simulation : --appliquer pour enregistrer les attestations)')
} else {
  console.log('usage : node scripts/fictif.mjs etat | prouver <personnage> <asset> [--appliquer] | rattraper [--appliquer]')
  process.exitCode = 1
}
