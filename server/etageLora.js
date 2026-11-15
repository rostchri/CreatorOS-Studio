/* LOCAL FORK PATCH: which Wan 2.2 noise stage a LoRA belongs to.

   Wan 2.2 A14B runs two models (high noise: first steps, low noise: the rest);
   most LoRAs ship as a high/low pair. The stage is only written in the NAMES,
   and in many spellings: "_high_noise", "HighNoise", "BounceHighWan2_2",
   "-HIGH-v1", "e128 (Low Noise)", a "HIGH/" folder, a CivitAI version "2.2 Lightning I2V H".

   Names are cut into words (separators, camelCase, letter/digit runs are kept),
   so "slow", "thigh" or "highlights" never match. Strong words (high, low,
   highnoise, lownoise, with an optional version suffix) are read first in the
   file name, then in the extra texts (CivitAI version name), then in the parent
   folders from the nearest one. A text that names BOTH stages tells nothing.
   A lone "H"/"L" counts only as a last resort. */

const FORT = /^(high|low)(noise)?(v?\d+)?$/

function mots(texte) {
  return String(texte ?? '')
    .replace(/\.safetensors$/i, '')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z\d]+/)
    .filter(Boolean)
    .map(m => m.toLowerCase())
}

/** 'high' | 'low' | null for ONE text, from its strong words or, if `faible`, its lone letters. */
function etageTexte(texte, faible = false) {
  const m = mots(texte)
  const trouves = new Set()
  for (let i = 0; i < m.length; i++) {
    const f = FORT.exec(m[i])
    // "high noise" written in two words is the same as "highnoise"
    if (f) trouves.add(f[1])
    else if (faible && (m[i] === 'h' || m[i] === 'l')) trouves.add(m[i] === 'h' ? 'high' : 'low')
  }
  return trouves.size === 1 ? [...trouves][0] : null
}

/** Stage of a LoRA from its path relative to the loras folder, plus optional
 *  extra texts (CivitAI version name...). */
export function etageLora(nom, extras = []) {
  const parties = String(nom ?? '').split('/').filter(Boolean)
  const fichier = parties.pop() ?? ''
  const dossiers = parties.reverse()
  const textes = [fichier, ...extras.filter(Boolean), ...dossiers]
  for (const t of textes) { const e = etageTexte(t); if (e) return e }
  for (const t of [fichier, ...extras.filter(Boolean)]) { const e = etageTexte(t, true); if (e) return e }
  return null
}

/** The name without its stage words: two halves of one pair end up equal. */
export function cleSansEtage(nom) {
  const fichier = String(nom ?? '').split('/').pop() ?? ''
  return mots(fichier).filter(m => !FORT.test(m) && m !== 'h' && m !== 'l' && m !== 'noise').join(' ')
}
