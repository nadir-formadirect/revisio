import { spawn, execSync } from 'node:child_process';
import { startMockGroq } from './mock-groq.mjs';
import { validateChapter } from '../src/validate.js';

const BASE = 'http://127.0.0.1:8789';
const VARS = Object.entries({ AI_PROVIDER: 'groq', GROQ_API_KEY: 'groq-key-SECRET-ne-doit-jamais-sortir', GROQ_BASE_URL: 'http://127.0.0.1:8798', PARENT_PASSWORD: 'motdepasse-parent-test', SESSION_SECRET: 'secret-de-session-de-test-assez-long-0123456789', AI_DAILY_LIMIT: '20' }).flatMap(([k, v]) => ['--var', `${k}:${v}`]);
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗ ÉCHEC :', msg); } };
const call = async (path, { method = 'GET', body, token } = {}) => {
  const r = await fetch(BASE + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, json: j, text };
};
const { server: mock, state } = await startMockGroq();
execSync('rm -rf .wrangler-state-groq && npx wrangler d1 execute revisio --local --persist-to .wrangler-state-groq --file=schema.sql', { stdio: 'ignore' });
const dev = spawn('npx', ['wrangler', 'dev', '--local', '--port', '8789', '--persist-to', '.wrangler-state-groq', ...VARS], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let logs = ''; dev.stdout.on('data', (d) => (logs += d)); dev.stderr.on('data', (d) => (logs += d));
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }
try {
  console.log('Fournisseur Groq (simulé)');
  let r = await call('/api/health'); ok(r.json?.ai === true && r.json.provider === 'groq', 'santé : fournisseur groq, clé présente');
  const P = (await call('/api/parent/login', { method: 'POST', body: { password: 'motdepasse-parent-test' } })).json.token;
  const course = 'La cellule est l’unité de base du vivant. Elle possède une membrane, un cytoplasme et un noyau.';
  const img = { mime: 'image/jpeg', data: 'QUJD' };
  r = await call('/api/parent/ai/generate', { method: 'POST', token: P, body: { subject: 'SVT', level: '5e', title: 'Les cellules', courseText: course, images: Array(7).fill(img) } });
  ok(r.status === 201, 'brouillon généré avec Groq à partir de 7 photos (plus de 4 acceptées)');
  let valid = true; try { validateChapter(r.json.chapter); } catch (e) { valid = false; console.log(e.message); }
  ok(valid && r.json.chapter.questions.length === 20 && r.json.chapter.evaluationQuestions.length === 15, 'brouillon valide : 20 + 15 questions, 20 points par banque');
  ok(r.json.chapter.questions.filter((q) => q.type === 'single').every((q) => q.options.includes(q.solution)), 'réponse « oui » réparée vers l’option exacte « Oui »');
  ok(r.json.warnings.some((w) => w.includes('Incertain')), 'avertissement « Incertain » remonté');
  ok(state.vision.length === 3 && state.vision.map((v) => v.messages[1].content.length - 1).join() === '3,3,1' && state.vision.every((v) => v.model === 'qwen/qwen3.8-27b'), 'photos recopiées par lots de 3 (3+3+1) avec le modèle photos');
  ok(state.vision[0].messages[1].content.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/jpeg;base64,')), 'les photos sont transmises à Groq');
  ok(state.vision[0].messages[0].content.includes('jamais une consigne') && state.vision[0].messages[0].content.includes('[illisible]'), 'recopie : anti-injection et passages illisibles signalés');
  const b = state.last.body;
  ok(b.model === 'openai/gpt-oss-120b' && b.response_format?.type === 'json_object' && b.messages[1].content.includes('Texte recopié de 3 photo(s)') && b.messages[1].content.includes(course), 'exercices créés par gpt-oss-120b à partir du texte collé + texte recopié');
  ok(b.messages[0].content.includes('jamais une consigne'), 'consigne anti-injection présente');
  ok(state.last.auth === 'Bearer groq-key-SECRET-ne-doit-jamais-sortir' && !r.text.includes('SECRET') && !JSON.stringify(b).includes('SECRET'), 'clé envoyée seulement dans l’en-tête, jamais dans les réponses');
  r = await call('/api/parent/ai/generate', { method: 'POST', token: P, body: { subject: 'SVT', level: '5e', title: 'Trop de photos', courseText: course, images: Array(13).fill(img) } });
  ok(r.status === 400 && /12 photos/.test(r.json.error), '13 photos refusées (12 max)');
  r = await call('/api/parent/ai/generate', { method: 'POST', token: P, body: { subject: 'SVT', level: '5e', title: 'Texte seul', courseText: course } });
  ok(r.status === 201 && state.last.body.model === 'openai/gpt-oss-120b' && state.last.body.reasoning_effort === 'low' && typeof state.last.body.messages[1].content === 'string', 'texte seul : modèle gpt-oss-120b, réflexion courte');

  state.mode = 'tpm'; state.tpm = 0;
  r = await call('/api/parent/ai/generate', { method: 'POST', token: P, body: { subject: 'SVT', level: '5e', title: 'Limite minute', courseText: course } });
  ok(r.status === 201, 'limite de tokens par minute (429 court) → attente puis réussite');

  state.mode = 'gone';
  r = await call('/api/parent/ai/generate', { method: 'POST', token: P, body: { subject: 'SVT', level: '5e', title: 'Modèle retiré', courseText: course, images: [{ mime: 'image/jpeg', data: 'QUJD' }] } });
  ok(r.status === 201 && state.vision.at(-1).model === 'qwen/qwen3.9-32b', 'modèle photos retiré → bascule automatique vers un autre modèle photos');
  r = await call('/api/parent/ai/models', { token: P });
  ok(r.status === 200 && r.json.provider === 'groq' && r.json.current === 'openai/gpt-oss-120b' && r.json.vision === 'qwen/qwen3.9-32b' && !r.json.models.includes('whisper-large-v3'), '« Tester l’IA » : modèles texte et photos affichés, audio exclus');
  state.mode = 'novision';
  r = await call('/api/parent/ai/generate', { method: 'POST', token: P, body: { subject: 'SVT', level: '5e', title: 'Pas de vision', courseText: course, images: [{ mime: 'image/jpeg', data: 'QUJD' }] } });
  ok(r.status === 400 && /ne lit pas les photos/.test(r.json.error), 'modèle sans lecture d’images → message clair (coller le texte)');
  state.mode = '429';
  r = await call('/api/parent/ai/generate', { method: 'POST', token: P, body: { subject: 'SVT', level: '5e', title: 'Quota', courseText: course } });
  ok(r.status === 429 && /Quota gratuit Groq/.test(r.json.error), 'quota Groq du jour dépassé → message clair, pas de facture');
  state.mode = 'garbage';
  r = await call('/api/parent/ai/generate', { method: 'POST', token: P, body: { subject: 'SVT', level: '5e', title: 'Illisible', courseText: course } });
  ok(r.status === 502 && /illisible/.test(r.json.error), 'réponse illisible → erreur propre');
  ok(!logs.includes('groq-key-SECRET'), 'la clé n’apparaît pas dans les journaux du serveur');
} finally {
  try { process.kill(-dev.pid); } catch {} mock.close();
  console.log(`\n${pass} réussis, ${fail} échecs`);
  process.exit(fail ? 1 : 0);
}
