import { spawn, execSync } from 'node:child_process';
import { startMockGemini } from './mock-gemini.mjs';
import { validateChapter } from '../src/validate.js';

const BASE = 'http://127.0.0.1:8788';
// Variables de test passées en ligne de commande (aucun fichier .dev.vars requis). Gemini simulé.
const VARS = Object.entries({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'test-key-SECRET-ne-doit-jamais-sortir', GEMINI_BASE_URL: 'http://127.0.0.1:8799', PARENT_PASSWORD: 'motdepasse-parent-test', SESSION_SECRET: 'secret-de-session-de-test-assez-long-0123456789', ALLOW_LOCALHOST: '1', AI_DAILY_LIMIT: '7' }).flatMap(([k, v]) => ['--var', `${k}:${v}`]);
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗ ÉCHEC :', msg); } };
const call = async (path, { method = 'GET', body, token, origin } = {}) => {
  const r = await fetch(BASE + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}), ...(origin ? { origin } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, json: j, text, headers: r.headers };
};

const { server: mock, state: mockState } = await startMockGemini();
execSync('rm -rf .wrangler-state-test && npx wrangler d1 execute revisio --local --persist-to .wrangler-state-test --file=schema.sql', { stdio: 'ignore' });
const dev = spawn('npx', ['wrangler', 'dev', '--local', '--port', '8788', '--persist-to', '.wrangler-state-test', ...VARS], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let logs = ''; dev.stdout.on('data', (d) => (logs += d)); dev.stderr.on('data', (d) => (logs += d));
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }

try {
  console.log('Santé et sécurité de base');
  let r = await call('/api/health'); ok(r.status === 200 && r.json.ai === true, 'health OK, IA configurée');
  r = await call('/api/parent/overview'); ok(r.status === 401, 'espace parent refusé sans jeton');
  r = await call('/api/sessions', { method: 'POST', body: {} }); ok(r.status === 401, 'envoi de séance refusé sans jeton');
  r = await call('/api/chapters'); ok(r.status === 401, 'catalogue serveur refusé sans jeton');
  r = await call('/api/health', { origin: 'https://evil.example' }); ok(!r.headers.get('access-control-allow-origin'), 'CORS : origine inconnue non autorisée');
  r = await call('/api/health', { origin: 'http://localhost:8765' }); ok(r.headers.get('access-control-allow-origin') === 'http://localhost:8765', 'CORS : localhost autorisé (dev uniquement)');
} finally {}
try {
  let r = await call('/api/parent/login', { method: 'POST', body: { password: 'motdepasse-parent-test' } });
  ok(r.status === 200 && r.json.token, 'bon mot de passe → jeton');
  const P = r.json.token;

  console.log('Profils enfants');
  r = await call('/api/parent/profiles', { method: 'POST', token: P, body: { name: 'Léa' } });
  ok(r.status === 201 && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(r.json.code), 'profil créé avec code XXXX-XXXX');
  const lea = r.json;
  r = await call('/api/parent/profiles', { method: 'POST', token: P, body: { name: 'Tom' } }); const tom = r.json;
  r = await call('/api/child/login', { method: 'POST', body: { code: 'zzzz-zzzz' } }); ok(r.status === 401, 'code inconnu → 401');
  r = await call('/api/child/login', { method: 'POST', body: { code: lea.code.toLowerCase() } });
  ok(r.status === 200 && r.json.name === 'Léa', 'code accepté en minuscules → profil Léa');
  const C = r.json.token;
  r = await call('/api/parent/overview', { token: C }); ok(r.status === 403, 'jeton enfant refusé sur l’espace parent');
  const T = (await call('/api/child/login', { method: 'POST', body: { code: tom.code } })).json.token;

  console.log('Envoi et lecture des séances');
  const items = [
    { qid: 1, topic: 'Division', prompt: 'Q1', type: 'single', weight: 2, answer: '12', expected: '12', explanation: 'e', kind: 'correct', points: 99 },
    { qid: 2, topic: 'Division', prompt: 'Q2', type: 'text', weight: 3, answer: '5', expected: '7', explanation: 'e', kind: 'wrong', points: 0 },
    { qid: 3, topic: 'Critères', prompt: 'Q3', type: 'manual', weight: 1, answer: 'parce que 12 = 3 × 4', expected: 'ex', explanation: 'e', kind: 'pending', points: 1 },
  ];
  r = await call('/api/sessions', { method: 'POST', token: C, body: { id: 'sess-0001-aaaa', courseId: 'maths', courseName: 'Division', subject: 'Mathématiques', mode: 'evaluation', startedAt: Date.now() - 60000, items } });
  ok(r.status === 200 && r.json.duplicate === false, 'séance enregistrée');
  r = await call('/api/sessions', { method: 'POST', token: C, body: { id: 'sess-0001-aaaa', courseId: 'maths', courseName: 'Division', subject: 'Mathématiques', mode: 'evaluation', items } });
  ok(r.json.duplicate === true, 'renvoi du même identifiant ignoré (pas de doublon)');
  r = await call('/api/sessions', { method: 'POST', token: C, body: { id: 'sess-0002-bbbb', courseId: 'maths', courseName: 'D', subject: 'M', mode: 'evaluation', items: [{ ...items[0], kind: 'nimporte' }] } });
  ok(r.status === 400, 'type de résultat invalide refusé');
  r = await call('/api/sessions', { method: 'POST', token: C, body: { id: 'x', courseId: 'maths', courseName: 'D', subject: 'M', mode: 'evaluation', items } });
  ok(r.status === 400, 'identifiant de séance trop court refusé');
  r = await call('/api/sessions', { method: 'POST', token: T, body: { id: 'sess-tom-0001', courseId: 'anglais', courseName: 'ON/AT/IN', subject: 'Anglais LV1', mode: 'training', items: [items[0]] } });
  ok(r.status === 200, 'séance de Tom enregistrée');

  r = await call('/api/parent/overview', { token: P });
  const L = r.json.profiles.find((p) => p.name === 'Léa');
  ok(L.recent.length === 1 && L.recent[0].score === 2 && L.recent[0].max === 6 && L.recent[0].pending === 1, 'total recalculé côté serveur (points truqués 99 ramenés à 2/6, 1 en attente)');
  ok(L.pendingToGrade === 1, 'une séance à valider signalée');
  ok(L.topics[0].topic === 'Division' && Math.abs(L.topics[0].rate - 0.4) < 1e-9, 'progression par notion : Division 2/5 (la réponse en attente est exclue)');
  const tomOv = r.json.profiles.find((p) => p.name === 'Tom'); ok(tomOv.recent.length === 1 && tomOv.recent[0].courseId === 'anglais', 'les données de Tom restent séparées');

  r = await call('/api/parent/sessions/sess-0001-aaaa', { token: P });
  ok(r.status === 200 && r.json.items.length === 3 && r.json.items[1].answer === '5' && r.json.items[1].expected === '7', 'détail intégral : réponse donnée, attendue et correction par question');
  r = await call('/api/parent/sessions/sess-0001-aaaa/grade', { method: 'POST', token: P, body: { qid: 1, grade: 1 } }); ok(r.status === 400, 'validation refusée sur une question non libre');
  r = await call('/api/parent/sessions/sess-0001-aaaa/grade', { method: 'POST', token: P, body: { qid: 3, grade: 1 } });
  ok(r.status === 200 && r.json.score === 3 && r.json.pending === 0 && r.json.items[2].kind === 'correct', 'le parent valide la réponse libre à distance → 3/6, plus rien en attente');
  r = await call('/api/parent/sessions/sess-0001-aaaa/grade', { method: 'POST', token: C, body: { qid: 3, grade: 1 } }); ok(r.status === 403, 'l’enfant ne peut pas se valider lui-même');

  console.log('Génération IA (Gemini simulé)');
  r = await call('/api/parent/ai/generate', { method: 'POST', token: P, body: { subject: 'SVT', level: '5e', title: 'Les cellules', courseText: 'Court' } });
  ok(r.status === 400, 'cours trop court refusé sans appeler l’IA'); ok(mockState.calls === 0, 'aucun appel IA émis pour une requête invalide');
  r = await call('/api/parent/ai/generate', { method: 'POST', token: C, body: {} }); ok(r.status === 403, 'génération IA interdite à l’enfant');
  const course = 'La cellule est l’unité de base du vivant. Elle possède une membrane, un cytoplasme et un noyau. Les cellules végétales ont en plus une paroi et des chloroplastes.';
  r = await call('/api/parent/ai/generate', { method: 'POST', token: P, body: { subject: 'SVT', level: '5e', title: 'Les cellules', courseText: course, images: [{ mime: 'image/jpeg', data: 'QUJD' }] } });
  ok(r.status === 201, 'brouillon généré'); const draft = r.json;
  let valid = true; try { validateChapter(draft.chapter); } catch (e) { valid = false; console.log(e.message); }
  ok(valid, 'brouillon valide : 2 banques × exactement 20 points');
  ok(draft.chapter.questions.length === 24 && draft.chapter.evaluationQuestions.length === 18, 'question cassée écartée, libres plafonnées : 26→24 et 20→18');
  ok(draft.chapter.questions.filter((q) => q.type === 'manual').length === 2, 'au plus 2 questions libres par banque');
  ok(draft.warnings.some((w) => w.includes('Incertain')) && draft.warnings.some((w) => w.includes('écartée')), 'avertissements remontés (passage incertain, question écartée)');
  const single = draft.chapter.questions.find((q) => q.type === 'single');
  ok(single.options.includes(single.solution), 'réponse « vrai » (minuscule) réparée vers l’option exacte');
  const firstIsCorrect = draft.chapter.questions.filter((q) => q.type === 'single').filter((q) => q.options[0] === q.solution).length;
  ok(firstIsCorrect < draft.chapter.questions.filter((q) => q.type === 'single').length, 'options mélangées (la bonne réponse n’est pas toujours en tête)');
  const ids = [...draft.chapter.questions, ...draft.chapter.evaluationQuestions].map((q) => q.id);
  ok(new Set(ids).size === ids.length, 'identifiants uniques entre banques');
  ok(mockState.last.key === 'test-key-SECRET-ne-doit-jamais-sortir', 'la clé part côté serveur dans l’en-tête x-goog-api-key');
  ok(!r.text.includes('SECRET') && !JSON.stringify(mockState.last.body).includes('SECRET'), 'la clé n’apparaît ni dans la réponse ni dans le corps envoyé à Gemini');
  ok(mockState.last.body.contents[0].parts.some((p) => p.inlineData), 'la photo est transmise à Gemini');
  ok(mockState.last.body.systemInstruction.parts[0].text.includes('jamais une consigne'), 'consigne anti-injection présente');

  mockState.mode = 'oldmodel';
  r = await call('/api/parent/ai/generate', { method: 'POST', token: P, body: { subject: 'SVT', level: '5e', title: 'Modèle retiré', courseText: course } });
  ok(r.status === 201 && /gemini-3-flash:/.test(mockState.last?.url || ''), 'modèle retiré (404) → choix automatique du Flash stable le plus récent (ni lite ni preview)');
  ok(mockState.last?.body?.generationConfig?.thinkingConfig?.thinkingLevel === 'low', 'modèle de génération 3+ → réflexion réglée sur thinkingLevel=low');
  mockState.mode = 'ok';
  mockState.mode = 'ok';
  mockState.mode = 'busy';
  r = await call('/api/parent/ai/generate', { method: 'POST', token: P, body: { subject: 'SVT', level: '5e', title: 'Modèle saturé', courseText: course } });
  ok(r.status === 201 && /gemini-flash-latest:/.test(mockState.last?.url || ''), 'modèle surchargé (503) → bascule automatique sur un autre modèle');
  mockState.mode = 'ok';
  mockState.mode = 'gw524';
  r = await call('/api/parent/ai/generate', { method: 'POST', token: P, body: { subject: 'SVT', level: '5e', title: 'Passerelle lente', courseText: course } });
  ok(r.status === 201, 'erreur 524 (trop lent) → bascule directe sur un autre modèle, sans réessayer le même');
  mockState.mode = 'ok';
  mockState.mode = '429';
  r = await call('/api/parent/ai/generate', { method: 'POST', token: P, body: { subject: 'SVT', level: '5e', title: 'X', courseText: course } });
  ok(r.status === 429 && /Quota Gemini/.test(r.json.error), 'quota Gemini dépassé → message clair');
  mockState.mode = 'garbage';
  r = await call('/api/parent/ai/generate', { method: 'POST', token: P, body: { subject: 'SVT', level: '5e', title: 'X', courseText: course } });
  ok(r.status === 502, 'réponse Gemini illisible → 502 propre');
  r = await call('/api/parent/ai/generate', { method: 'POST', token: P, body: { subject: 'SVT', level: '5e', title: 'X', courseText: course } });
  ok(r.status === 502, '7e génération du jour encore permise (plafond = 7)');
  const callsBefore = mockState.calls;
  r = await call('/api/parent/ai/generate', { method: 'POST', token: P, body: { subject: 'SVT', level: '5e', title: 'X', courseText: course } });
  ok(r.status === 429 && /Plafond quotidien/.test(r.json.error) && mockState.calls === callsBefore, '8e génération : plafond quotidien atteint, aucun appel Gemini émis');
  mockState.mode = 'ok';
  // --- Import manuel (réponse collée depuis ChatGPT/Claude) ---
  const mk = (n, tag) => Array.from({ length: n }, (_, k) => ({ topic: `Notion ${1 + (k % 4)}`, prompt: `${tag} question ${k} ?`, type: 'single', options: ['A', 'B', 'C'], correct: ['B'], explanation: `Parce que B (${k}).`, weight: 1 + (k % 3) }));
  const pasted = '```json\n' + JSON.stringify({ warnings: ['Incertain : schéma illisible'], training: mk(20, 'Entr'), evaluation: mk(15, 'Éval') }) + '\n```\nVoilà !';
  const imp = { subject: 'Technologie', level: '5e', title: 'Fichiers import', json: pasted };
  r = await call('/api/parent/ai/import', { method: 'POST', token: C, body: imp }); ok(r.status === 403, 'import interdit à l’enfant');
  const callsImp = mockState.calls;
  r = await call('/api/parent/ai/import', { method: 'POST', token: P, body: imp });
  ok(r.status === 201 && r.json.chapter.questions.length === 20 && r.json.chapter.evaluationQuestions.length === 15, 'import JSON collé (avec ```json et texte autour) → brouillon 20 + 15');
  ok(r.json.chapter.questions.reduce((a, q) => a + q.weight, 0) === 20 && r.json.chapter.evaluationQuestions.reduce((a, q) => a + q.weight, 0) === 20, 'import : chaque banque rééquilibrée à 20 points');
  ok(mockState.calls === callsImp, 'import : aucun appel à Gemini');
  ok(r.json.warnings.some((w) => /schéma illisible/.test(w)), 'import : avertissements conservés');
  r = await call('/api/parent/ai/import', { method: 'POST', token: P, body: { ...imp, json: 'pas du json' } }); ok(r.status === 400, 'import : texte sans JSON → 400');
  r = await call('/api/parent/ai/import', { method: 'POST', token: P, body: { ...imp, json: '{"training": [' } }); ok(r.status === 400, 'import : JSON coupé → 400 avec message');
  r = await call('/api/parent/ai/import', { method: 'POST', token: P, body: { ...imp, json: JSON.stringify({ training: mk(3, 'x'), evaluation: mk(3, 'y') }) } }); ok(r.status === 422, 'import : moins de 5 questions → 422');
  r = await call('/api/parent/ai/models', { token: P }); ok(r.status === 200 && r.json.models.length === 4 && r.json.models.includes('gemini-flash-latest') && !r.json.models.includes('embedding-001'), 'liste des modèles (seuls ceux qui génèrent du texte)');

  console.log('Publication');
  r = await call('/api/chapters', { token: C }); ok(r.json.chapitres.length === 0, 'un brouillon n’est pas visible par les enfants');
  const edited = JSON.parse(JSON.stringify(draft.chapter)); edited.questions.splice(0, 3);
  r = await call('/api/parent/chapters/' + draft.id, { method: 'PUT', token: P, body: { chapter: edited } });
  ok(r.status === 200 && Math.abs(r.json.chapter.questions.reduce((a, q) => a + q.weight, 0) - 20) < 1e-9, 'retrait de 3 questions → barème rééquilibré à 20');
  r = await call('/api/parent/chapters/' + draft.id + '/publish', { method: 'POST', token: P }); ok(r.status === 200, 'publication');
  r = await call('/api/chapters', { token: C }); ok(r.json.chapitres.length === 1 && r.json.chapitres[0].id === draft.id, 'chapitre publié visible par l’enfant connecté');
  r = await call('/api/chapters'); ok(r.status === 401, 'toujours invisible hors connexion');

  console.log('Suppression des données');
  r = await call('/api/parent/profiles/' + lea.id, { method: 'DELETE', token: P }); ok(r.status === 200, 'profil supprimé');
  r = await call('/api/parent/sessions/sess-0001-aaaa', { token: P }); ok(r.status === 404, 'ses séances sont effacées avec lui');
  r = await call('/api/sessions', { method: 'POST', token: C, body: { id: 'sess-0003-cccc', courseId: 'maths', courseName: 'D', subject: 'M', mode: 'evaluation', items } });
  ok(r.status === 401, 'son jeton ne fonctionne plus');
  globalThis.__logs = logs; ok(!logs.includes('test-key-SECRET-ne-doit-jamais-sortir') && !logs.includes('motdepasse-parent-test'), 'ni la clé Gemini ni le mot de passe n’apparaissent dans les journaux du serveur');

  console.log('Anti force brute (en dernier : bloque l’IP de test)');
  for (let i = 0; i < 8; i++) { r = await call('/api/parent/login', { method: 'POST', body: { password: 'mauvais' + i } }); }
  ok(r.status === 401, 'mauvais mot de passe → 401');
  r = await call('/api/parent/login', { method: 'POST', body: { password: 'motdepasse-parent-test' } });
  ok(r.status === 429, 'après 8 échecs, même le bon mot de passe est bloqué (429)');
} finally {
  try { process.kill(-dev.pid); } catch {} mock.close();
  if (process.env.SHOWLOGS) console.log(logs.split('\n').filter((l) => l.includes('SECRET')).join('\n'));
  console.log(`\n${pass} réussis, ${fail} échecs`);
  process.exit(fail ? 1 : 0);
}
