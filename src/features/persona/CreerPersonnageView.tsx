/* Create a character, studio layout: trait choices in accordions on the left, the four
   proposed faces then the creation on the right (see server/createurPersonnage.js).
   LOCAL FORK PATCH: a second mode starts from 1 to 12 imported photos (creerDepuisImages). */
import { useEffect, useMemo, useRef, useState } from 'react'
import { t, tServeur } from '../../i18n'
import { useAppStore } from '../../store/useAppStore'
import { useEdition } from '../../lib/proprietaire'
import { OutilPage, useSuiviOutil } from '../../v2/OutilPage'
import { dureeMin } from './Entrainement'

const CHOIX: { cle: 'origine' | 'cheveux' | 'yeux' | 'style' | 'signes'; titre: string; options: string[]; multiple?: boolean }[] = [
  { cle: 'origine', titre: 'Origine du personnage', options: ['Portuguese', 'Japanese', 'Nigerian', 'Brazilian', 'Swedish', 'Indian', 'Moroccan', 'Korean', 'Mexican', 'Irish', 'Lebanese', 'Vietnamese'] },
  { cle: 'cheveux', titre: 'Cheveux', options: ['long straight black', 'short dark curly', 'shoulder-length auburn wavy', 'platinum blonde bob', 'long brown braids', 'buzz cut', 'messy copper bun'] },
  { cle: 'yeux', titre: 'Yeux', options: ['brown', 'hazel', 'green', 'blue', 'grey', 'dark brown'] },
  { cle: 'style', titre: 'Style', options: ['minimalist linen workwear', 'streetwear', 'bohemian', 'sporty athleisure', 'elegant evening', 'business casual', 'vintage 70s'] },
  { cle: 'signes', titre: 'Signes distinctifs', multiple: true, options: ['freckles', 'dimples', 'round glasses', 'small nose ring', 'beauty mark', 'gap-toothed smile', 'fine line tattoo on the forearm'] },
]
type Traits = { genre: string; age: number; origine: string; cheveux: string; yeux: string; style: string; signes: string }

/* State that survives a page change: the last batch of faces, the choice,
   the name and the creation in progress. The faces also go to the tool History. */
const CLE = 'creatoros.creerPersonnage'
type Photo = { nom: string; apercu: string }
const PHOTOS_MAX = 12
type Memo = { jobs?: string[]; choisi?: string | null; nom?: string; suiviId?: string | null; mode?: 'texte' | 'photos'; photos?: Photo[]; profil?: number }
const lireMemo = (): Memo => { try { return JSON.parse(localStorage.getItem(CLE) ?? '{}') } catch { return {} } }

export function CreerPersonnageView() {
  const edition = useEdition()
  const s = useAppStore()
  const [traits, setTraits] = useState<Traits>({ genre: 'woman', age: 28, origine: '', cheveux: '', yeux: '', style: '', signes: '' })
  const [ouvert, setOuvert] = useState<string>('origine')
  const memo = useMemo(lireMemo, [])
  const historique = useSuiviOutil('personnage')
  const [jobs, setJobs] = useState<string[]>(memo.jobs ?? [])
  const [choisi, setChoisi] = useState<string | null>(memo.choisi ?? null)
  const [nom, setNom] = useState(memo.nom ?? '')
  const [mode, setMode] = useState<'texte' | 'photos'>(memo.mode === 'photos' ? 'photos' : 'texte')
  const [photos, setPhotos] = useState<Photo[]>(Array.isArray(memo.photos) ? memo.photos.filter(p => p && typeof p.nom === 'string').slice(0, PHOTOS_MAX) : [])
  const [profil, setProfil] = useState(Number.isInteger(memo.profil) ? Number(memo.profil) : 0)
  const [adulte, setAdulte] = useState(false)
  const [avecTraits, setAvecTraits] = useState(false)
  const [envoi, setEnvoi] = useState<string | null>(null)
  const fichiers = useRef<HTMLInputElement>(null)
  const [moteursDispo, setMoteursDispo] = useState<{ id: string; nom: string; pret: boolean; secParPas: number; preparationS: number }[]>([])
  const [moteurs, setMoteurs] = useState<Set<string>>(new Set(['klein']))
  useEffect(() => { void fetch('/api/entrainement').then(r => r.json()).then(d => setMoteursDispo(d.moteurs ?? [])).catch(() => {}) }, [])
  const [suivi, setSuivi] = useState<{ id: string; planche: string | null; images: string; entrainementEtat: string | null; entrainements?: { moteur: string; statut: string | null }[] } | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [occupe, setOccupe] = useState(false)
  useEffect(() => {
    try { localStorage.setItem(CLE, JSON.stringify({ jobs, choisi, nom, suiviId: suivi?.id ?? null, mode, photos, profil } satisfies Memo)) } catch { /* storage unavailable */ }
  }, [jobs, choisi, nom, suivi, mode, photos, profil])
  // a creation started before leaving the page resumes its tracking (the server forgets it on restart)
  useEffect(() => {
    if (!memo.suiviId) return
    void fetch(`/api/personnages/creer/${encodeURIComponent(memo.suiviId)}`).then(r => (r.ok ? r.json() : null)).then(d => { if (d) setSuivi(d) }).catch(() => {})
  }, [memo])
  const portraits = useMemo(() => s.assets.filter(a => a.jobId && jobs.includes(a.jobId) && a.mediaType === 'photo'), [s.assets, jobs])
  useEffect(() => {
    if (!suivi || suivi.entrainementEtat === 'done') return
    const h = setInterval(() => void fetch(`/api/personnages/creer/${suivi.id}`).then(async r => {
      if (r.ok) { setSuivi(await r.json()); return }
      if (r.status === 404) { setSuivi(null); setMsg(t('Le suivi de cette création est perdu : ses images sont dans la Bibliothèque, et sa LoRA s’entraîne depuis Personnages → Entraînement.')) }
    }).catch(() => {}), 4000)
    return () => clearInterval(h)
  }, [suivi])
  const poster = async (url: string, corps: object) => {
    setMsg(null)
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps) })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) { setMsg(tServeur(d.error) ?? `HTTP ${r.status}`); return null }
    return d
  }
  const choisir = (cle: keyof Traits, v: string, multiple?: boolean) => setTraits(x => {
    if (!multiple) return { ...x, [cle]: x[cle] === v ? '' : v }
    const l = String(x[cle]).split(', ').filter(Boolean)
    return { ...x, [cle]: (l.includes(v) ? l.filter(y => y !== v) : [...l, v]).join(', ') }
  })
  const proposer = async () => { setOccupe(true); const d = await poster('/api/personnages/propositions', { traits }); setOccupe(false); if (d) { setJobs(d.jobs); setChoisi(null); setSuivi(null); historique.ajouter(d.jobs); for (const j of d.jobs) void s.adoptServerJob(j) } }
  const creer = async () => { const d = await poster('/api/personnages/creer', { assetId: choisi, nom, traits, moteurs: [...moteurs].filter(m => moteursDispo.some(x => x.id === m && x.pret)) }); if (d) { setSuivi(d); await s.refreshPersona() } }
  const creerDepuisPhotos = async () => {
    const d = await poster('/api/personnages/creer-depuis-images', { images: photos.map(p => p.nom), profil, nom, adulte, traits: avecTraits ? traits : undefined, moteurs: [...moteurs].filter(m => moteursDispo.some(x => x.id === m && x.pret)) })
    if (d) { setSuivi(d); await s.refreshPersona() }
  }
  // one upload after the other (a photo is up to 48 MiB); a new batch after a finished creation starts afresh
  const deposer = async (liste: FileList | null) => {
    const fichiersChoisis = [...(liste ?? [])].filter(f => f.type.startsWith('image/'))
    if (!fichiersChoisis.length) return
    setMsg(null)
    let base = photos
    if (suivi) { setSuivi(null); base = []; setProfil(0) }
    for (const [i, f] of fichiersChoisis.entries()) {
      if (base.length >= PHOTOS_MAX) { setMsg(t('{n} photos au plus', { n: PHOTOS_MAX })); break }
      setEnvoi(t('envoi {i}/{n}…', { i: i + 1, n: fichiersChoisis.length }))
      const r = await fetch(`/api/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'Content-Type': f.type }, body: f }).catch(() => null)
      const d = await r?.json().catch(() => ({}))
      if (!r || !r.ok) { setMsg(r ? (tServeur(d?.error) ?? `HTTP ${r.status}`) : t('envoi impossible')); break }
      base = [...base, { nom: d.filename, apercu: `/api/uploads/${encodeURIComponent(d.filename)}` }]
      setPhotos(base)
    }
    setEnvoi(null)
    if (fichiers.current) fichiers.current.value = ''
  }
  const retirer = (i: number) => {
    setPhotos(l => l.filter((_, k) => k !== i))
    setProfil(p => (i < p ? p - 1 : i === p ? 0 : p))
  }
  if (!edition) return <div className="outil-vide" style={{ flex: 1 }}>{t('Créer un personnage est réservé au propriétaire du studio.')}</div>
  const choixMoteurs = moteursDispo.map(m => (
    <label key={m.id} className="flex gap-1.5 items-center" style={{ cursor: m.pret ? 'pointer' : 'not-allowed', opacity: m.pret ? 1 : 0.45 }}>
      <input type="checkbox" disabled={!m.pret} checked={m.pret && moteurs.has(m.id)} onChange={e => setMoteurs(c => { const n = new Set(c); if (e.target.checked) n.add(m.id); else n.delete(m.id); return n })} />
      {m.nom} <span className="texte-doux">~{dureeMin(m, 1200)} min</span>
    </label>
  ))
  const lignesSuivi = suivi && <span className="texte-doux">{t('Planche : {p} · images : {i}', { p: suivi.planche ?? '…', i: suivi.images })}{suivi.entrainements?.length ? ` · ${suivi.entrainements.map(e => `LoRA ${e.moteur === 'krea' ? 'Krea 2' : 'Klein'} : ${e.statut ?? '…'}`).join(' · ')}` : suivi.entrainementEtat ? ` · ${t('LoRA : {e}', { e: suivi.entrainementEtat })}` : ''}</span>
  const resultatPhotos = photos.length > 0 ? (
    <div style={{ display: 'grid', gap: 14 }}>
      <b>{t('Choisis la photo de profil')}</b>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10 }}>
        {photos.map((p, i) => (
          <div key={p.nom} style={{ display: 'grid', gap: 4 }}>
            <button onClick={() => setProfil(i)} aria-pressed={profil === i} className={`carte-visage ${profil === i ? 'on' : ''}`}><img src={p.apercu} alt="" /></button>
            <div className="flex gap-1.5 items-center justify-between">
              <small className="texte-doux">{profil === i ? t('profil') : '\u00a0'}</small>
              {!suivi && <button className="pill" onClick={() => retirer(i)}>{t('Retirer')}</button>}
            </div>
          </div>))}
      </div>
      {!suivi && (
        <div className="flex gap-2 items-center flex-wrap">
          <input className="champ" value={nom} onChange={e => setNom(e.target.value)} placeholder={t('nom du personnage')} maxLength={40} />
          <span className="texte-doux">{t('entraîner sa LoRA pour')}</span>
          {choixMoteurs}
          <label className="flex gap-1.5 items-center" style={{ flexBasis: '100%', cursor: 'pointer' }}>
            <input type="checkbox" checked={adulte} onChange={e => setAdulte(e.target.checked)} />
            {t('Je confirme que la personne est majeure et qu’elle a donné son accord.')}
          </label>
          <button className="pill" disabled={nom.trim().length < 2 || !adulte || !!envoi} onClick={() => void creerDepuisPhotos()}>{t('Créer le personnage')}</button>
          <span className="texte-doux" style={{ flexBasis: '100%' }}>{t('SFW — photos importées : le mode adulte reste verrouillé pour ce personnage.')}</span>
        </div>
      )}
      {lignesSuivi}
    </div>
  ) : undefined
  const resultatTexte = jobs.length > 0 ? (
    <div style={{ display: 'grid', gap: 14 }}>
      <b>{t('Choisis un visage')}</b>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
        {jobs.map(j => { const a = portraits.find(x => x.jobId === j); return (
          <button key={j} disabled={!a} onClick={() => a && setChoisi(a.id)} aria-pressed={!!a && choisi === a.id} className={`carte-visage ${a && choisi === a.id ? 'on' : ''}`}>
            {a ? <img src={a.uri} alt="" /> : <span className="texte-faible">{t('en cours…')}</span>}
          </button>) })}
      </div>
      {choisi && !suivi && (
        <div className="flex gap-2 items-center flex-wrap">
          <input className="champ" value={nom} onChange={e => setNom(e.target.value)} placeholder={t('nom du personnage')} maxLength={40} />
          <span className="texte-doux">{t('entraîner sa LoRA pour')}</span>
          {choixMoteurs}
          <button className="pill" disabled={nom.trim().length < 2} onClick={() => void creer()}>{t('Créer le personnage')}</button>
        </div>
      )}
      {lignesSuivi}
    </div>
  ) : undefined
  const resultat = mode === 'photos' ? resultatPhotos : resultatTexte
  // trait choices: the whole left pane in text mode, an optional block in photo mode
  const blocTraits = <>
    <div className="segmente">
      {[['woman', 'femme'], ['man', 'homme'], ['person', 'personne']].map(([v, l]) => <button key={v} className={traits.genre === v ? 'on' : ''} onClick={() => setTraits(x => ({ ...x, genre: v }))}>{t(l)}</button>)}
    </div>
    <label style={{ display: 'grid', gap: 6 }}>
      <span className="etiquette">{t('âge')} · {traits.age}</span>
      <input type="range" min={21} max={80} value={traits.age} onChange={e => setTraits(x => ({ ...x, age: Number(e.target.value) }))} />
    </label>
    {CHOIX.map(c => (
      <div key={c.cle} className="accordeon">
        <button className="accordeon-tete" aria-expanded={ouvert === c.cle} onClick={() => setOuvert(o => (o === c.cle ? '' : c.cle))}>
          <span>{t(c.titre)}</span><small>{traits[c.cle] || t('au choix')}</small><i>{ouvert === c.cle ? '−' : '+'}</i>
        </button>
        {ouvert === c.cle && <div className="accordeon-corps">
          {c.options.map(o => <button key={o} className={`pill ${String(traits[c.cle]).split(', ').includes(o) ? 'on' : ''}`} onClick={() => choisir(c.cle, o, c.multiple)}>{o}</button>)}
          <input className="champ" style={{ flexBasis: '100%' }} value={traits[c.cle]} maxLength={c.cle === 'signes' ? 120 : 60} onChange={e => setTraits(x => ({ ...x, [c.cle]: e.target.value }))} placeholder={t('ou écris-le, en anglais')} />
        </div>}
      </div>
    ))}
  </>
  const photosMode = mode === 'photos'
  return (
    <OutilPage
      howto={{ cle: 'personnage', titre: photosMode ? 'Ton personnage, de tes photos à la LoRA' : 'Ton personnage, du texte à la LoRA',
        texte: photosMode ? 'Tu importes 1 à 12 photos de la même personne : le studio crée sa planche de référence, des images variées et sa LoRA, prêt pour tous les outils.' : 'Tu le décris, tu choisis un visage parmi quatre : le studio crée sa planche de référence, 12 images et sa LoRA, prêt pour tous les outils.',
        label: 'Exemple de création de personnage', repli: '/vitrine/v2-personnage.webp' }} titre={t('Créer un personnage')}
      texte={photosMode ? t('Importe 1 à 12 photos : la photo de profil tient le visage, le studio crée la planche de référence, des images variées et la LoRA.') : t('Décris-le : le studio propose 4 visages, tu choisis, il crée le personnage, sa planche de référence, 12 images et sa LoRA.')}
      resultat={resultat}
      jobs={j => historique.ids.has(j.id)} assets={a => !!a.jobId && historique.ids.has(a.jobId)}
      etapes={photosMode ? [
        { titre: 'Les photos', texte: 'De 1 à 12 photos de la même personne, majeure et consentante ; tu choisis celle qui devient sa photo de profil.' },
        { titre: 'La photo de profil', texte: 'Elle tient le visage ; avec 2 à 5 photos, les autres servent aussi de références, et dès 2 photos elles rejoignent l’entraînement.' },
        { titre: 'Le personnage', texte: 'Planche de référence, 12 images (6 si tu importes 6 photos ou plus) avec FLUX.2 Klein, puis ses LoRA (Klein, Krea 2) si tu veux ; personnage SFW, mode adulte verrouillé.' },
      ] : [
        { titre: 'Les traits', texte: 'Un adulte de 21 à 80 ans : origine, cheveux, yeux, style, signes distinctifs.' },
        { titre: 'Quatre visages', texte: 'Krea 2 propose quatre portraits en studio ; tu choisis et tu le nommes.' },
        { titre: 'Le personnage', texte: 'Planche de référence, 12 images variées avec FLUX.2 Klein, puis ses LoRA (Klein, Krea 2) si tu veux ; tu suis et tu peux annuler l’entraînement dans Personnages.' },
      ]}
      action={<>
        {photosMode
          ? <button className="cta" style={{ padding: '18px 15px', flexDirection: 'row' }} disabled={!!envoi || (!suivi && photos.length >= PHOTOS_MAX)} onClick={() => fichiers.current?.click()}>{envoi ?? t('Ajouter des photos')} <small>{photos.length}/{PHOTOS_MAX}</small></button>
          : <button className="cta" style={{ padding: '18px 15px', flexDirection: 'row' }} disabled={occupe} onClick={() => void proposer()}>{occupe ? '…' : t('4 propositions')} <small>~1 min</small></button>}
        {msg && <span className="texte-erreur">{msg}</span>}
      </>}>
      <div className="segmente">
        {([['texte', 'À partir du texte'], ['photos', 'Depuis des photos']] as const).map(([v, l]) => <button key={v} className={mode === v ? 'on' : ''} onClick={() => { setMode(v); setMsg(null) }}>{t(l)}</button>)}
      </div>
      {photosMode ? <>
        <input ref={fichiers} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={e => void deposer(e.target.files)} />
        <span className="texte-doux" style={{ fontSize: 12.5, lineHeight: 1.45 }}>{t('Photos de la même personne, majeure et consentante : une seule suffit, plusieurs tiennent mieux le visage.')}</span>
        <label className="flex gap-1.5 items-center" style={{ cursor: 'pointer' }}>
          <input type="checkbox" checked={avecTraits} onChange={e => setAvecTraits(e.target.checked)} />
          {t('Préciser des traits (facultatif)')}
        </label>
        {avecTraits && blocTraits}
      </> : blocTraits}
    </OutilPage>
  )
}
