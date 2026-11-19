// API Révisio (Cloudflare Worker + D1).
// - Enfants : connexion par code personnel, envoi des résultats complets.
// - Parent : mot de passe, consultation à distance, validation des réponses libres, génération IA de chapitres.
// - Secrets uniquement côté serveur : GEMINI_API_KEY, PARENT_PASSWORD, SESSION_SECRET.

import { validateChapter } from './validate.js';
import { AiError, checkGenerateInput, generateDraft, importDraft, listModels, normalizeWeights } from './ai.js';

const enc = new TextEncoder();
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const KINDS = ['correct', 'wrong', 'partial', 'blank', 'pending'];
const MODES = ['training', 'evaluation', 'remediation'];
const PARENT_TTL = 14 * 24 * 3600;
const CHILD_TTL = 120 * 24 * 3600;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- utilitaires ----------
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function hmacHex(secret, msg) {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function safeEqual(secret, a, b) {
  // Comparaison à temps constant via HMAC des deux valeurs
  const [x, y] = await Promise.all([crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(a)), crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(b))]);
  const ax = new Uint8Array(x), ay = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < ax.length; i++) d |= ax[i] ^ ay[i];
  return d === 0;
}

function requireSecrets(env) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new HttpError(500, 'Serveur mal configuré : SESSION_SECRET (≥ 32 caractères) manquant.');
}

async function signToken(env, payload) {
  requireSecrets(env);
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env.SESSION_SECRET), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}
async function readToken(env, req) {
  const h = req.headers.get('authorization') || '';
  const m = /^Bearer ([\w-]+\.[\w-]+)$/.exec(h);
  if (!m) return null;
  const [body, sig] = m[1].split('.');
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(env.SESSION_SECRET), unb64url(sig), enc.encode(body));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(unb64url(body)));
    if (!p || typeof p.e !== 'number' || p.e < Date.now() / 1000) return null;
    if (p.r !== 'parent' && p.r !== 'child') return null;
    return p;
  } catch { return null; }
}

function corsHeaders(env, req) {
  const origin = req.headers.get('origin');
  const h = { vary: 'Origin' };
  const allowed = origin && (origin === env.ALLOWED_ORIGIN || (env.ALLOW_LOCALHOST === '1' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)));
  if (allowed) {
    h['access-control-allow-origin'] = origin;
    h['access-control-allow-headers'] = 'authorization, content-type';
    h['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
    h['access-control-max-age'] = '600';
  }
  return h;
}

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra } });

async function readBody(req, maxBytes) {
  const len = Number(req.headers.get('content-length') || 0);
  if (len > maxBytes) throw new HttpError(413, 'Requête trop volumineuse.');
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, 'Requête trop volumineuse.');
  try { return text ? JSON.parse(text) : {}; } catch { throw new HttpError(400, 'JSON invalide.'); }
}

const uuid = () => crypto.randomUUID();
const clip = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

async function tooManyFailures(env, key, max, windowSec) {
  const since = Math.floor(Date.now() / 1000) - windowSec;
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM attempts WHERE key = ? AND ts > ?').bind(key, since).first();
  return (r?.n || 0) >= max;
}
async function recordFailure(env, key) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO attempts (key, ts) VALUES (?, ?)').bind(key, now),
    env.DB.prepare('DELETE FROM attempts WHERE ts < ?').bind(now - 86400),
  ]);
}
const clientIp = (req) => req.headers.get('cf-connecting-ip') || 'local';

function genCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}
const normCode = (s) => String(s || '').toUpperCase().split('').filter((c) => CODE_ALPHABET.includes(c)).join('');
const prettyCode = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;

// ---------- accès ----------
async function auth(env, req, role) {
  const t = await readToken(env, req);
  if (!t) throw new HttpError(401, 'Connexion requise.');
  if (role && t.r !== role) throw new HttpError(403, 'Accès refusé.');
  return t;
}

// ---------- séances ----------
function cleanItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 80) throw new HttpError(400, 'Séance invalide.');
  return items.map((it) => {
    if (!it || !Number.isFinite(Number(it.qid)) || !KINDS.includes(it.kind)) throw new HttpError(400, 'Question invalide.');
    const weight = Number(it.weight);
    if (!(weight > 0 && weight <= 20)) throw new HttpError(400, 'Poids invalide.');
    let points = Number(it.points);
    if (!Number.isFinite(points)) points = 0;
    points = Math.min(weight, Math.max(0, points));
    if (it.kind === 'pending') points = 0;
    return {
      qid: Number(it.qid), topic: clip(it.topic, 120), prompt: clip(it.prompt, 1500), type: clip(it.type, 20),
      weight, answer: clip(it.answer, 2000), expected: clip(it.expected, 1500), explanation: clip(it.explanation, 1500),
      kind: it.kind, points,
    };
  });
}
function totals(items) {
  let score = 0, pending = 0, max = 0;
  for (const it of items) { score += it.points; max += it.weight; if (it.kind === 'pending') pending += it.weight; }
  return { score, pending, max };
}

async function postSession(env, req, tok) {
  const b = await readBody(req, 300_000);
  const id = typeof b.id === 'string' && /^[\w-]{8,64}$/.test(b.id) ? b.id : null;
  if (!id) throw new HttpError(400, 'Identifiant de séance invalide.');
  if (!MODES.includes(b.mode)) throw new HttpError(400, 'Mode invalide.');
  const items = cleanItems(b.items);
  const t = totals(items);
  const now = Date.now();
  const startedAt = Number.isFinite(Number(b.startedAt)) ? Math.min(now, Math.max(0, Number(b.startedAt))) : null;
  const r = await env.DB.prepare(
    'INSERT OR IGNORE INTO sessions (id, profile_id, course_id, course_name, subject, mode, score, pending, max, items, started_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
  ).bind(id, tok.p, clip(b.courseId, 80), clip(b.courseName, 160), clip(b.subject, 60), b.mode, t.score, t.pending, t.max, JSON.stringify(items), startedAt, now).run();
  return json({ ok: true, duplicate: !(r.meta?.changes > 0) });
}

function sessionRow(r, withItems) {
  const o = { id: r.id, profileId: r.profile_id, courseId: r.course_id, courseName: r.course_name, subject: r.subject, mode: r.mode, score: r.score, pending: r.pending, max: r.max, startedAt: r.started_at, createdAt: r.created_at };
  if (withItems) o.items = JSON.parse(r.items);
  return o;
}

function topicStats(rows) {
  const topics = new Map();
  for (const r of rows) {
    if (r.mode === 'remediation') continue; // pas une note sur 20 : exclu de la progression par notion
    for (const it of JSON.parse(r.items)) {
      if (it.kind === 'pending') continue;
      const key = `${r.subject} · ${it.topic}`;
      const t = topics.get(key) || { topic: it.topic, subject: r.subject, earned: 0, max: 0 };
      t.earned += it.points; t.max += it.weight;
      topics.set(key, t);
    }
  }
  return [...topics.values()].map((t) => ({ ...t, rate: t.max ? t.earned / t.max : 0 })).sort((a, b) => a.rate - b.rate);
}

async function overview(env) {
  const profiles = (await env.DB.prepare('SELECT id, name, created_at FROM profiles ORDER BY name').all()).results;
  const out = [];
  for (const p of profiles) {
    const rows = (await env.DB.prepare('SELECT * FROM sessions WHERE profile_id = ? ORDER BY created_at DESC LIMIT 60').bind(p.id).all()).results;
    out.push({
      id: p.id, name: p.name,
      sessionCount: rows.length,
      pendingToGrade: rows.reduce((n, r) => n + (r.pending > 0 ? 1 : 0), 0),
      recent: rows.slice(0, 8).map((r) => sessionRow(r, false)),
      topics: topicStats(rows),
    });
  }
  return { profiles: out };
}

async function gradeItem(env, id, body) {
  const row = await env.DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'Séance introuvable.');
  const grade = body.grade === 1 || body.grade === 0 ? body.grade : null;
  if (grade === null || !Number.isFinite(Number(body.qid))) throw new HttpError(400, 'Validation invalide.');
  const items = JSON.parse(row.items);
  const it = items.find((x) => x.qid === Number(body.qid));
  if (!it || it.type !== 'manual' || !String(it.answer || '').trim()) throw new HttpError(400, 'Cette question ne se valide pas à la main.');
  it.kind = grade === 1 ? 'correct' : 'wrong';
  it.points = grade === 1 ? it.weight : 0;
  it.gradedByParent = true;
  const t = totals(items);
  await env.DB.prepare('UPDATE sessions SET items = ?, score = ?, pending = ? WHERE id = ?').bind(JSON.stringify(items), t.score, t.pending, id).run();
  return sessionRow({ ...row, items: JSON.stringify(items), score: t.score, pending: t.pending }, true);
}

// ---------- chapitres ----------
function rebalanced(chapter) {
  for (const bank of ['questions', 'evaluationQuestions']) {
    const qs = chapter[bank];
    if (!Array.isArray(qs) || !qs.length) continue;
    const sum = qs.reduce((a, q) => a + (Number(q.weight) || 0), 0);
    if (Math.abs(sum - 20) > 1e-8) {
      const w = normalizeWeights(qs, false);
      qs.forEach((q, i) => { q.weight = w[i]; });
    }
  }
  return chapter;
}

async function saveDraft(env, chapter, warnings) {
  const now = Date.now();
  await env.DB.prepare('INSERT INTO chapters (id, status, json, warnings, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .bind(chapter.id, 'draft', JSON.stringify(chapter), JSON.stringify(warnings || []), now, now).run();
}

async function aiQuota(env) {
  const limit = Math.max(1, Number(env.AI_DAILY_LIMIT) || 20);
  const day = new Date().toISOString().slice(0, 10);
  await env.DB.prepare('INSERT INTO ai_usage (day, count) VALUES (?, 0) ON CONFLICT(day) DO NOTHING').bind(day).run();
  const r = await env.DB.prepare('UPDATE ai_usage SET count = count + 1 WHERE day = ? AND count < ?').bind(day, limit).run();
  if (!(r.meta?.changes > 0)) throw new HttpError(429, `Plafond quotidien de ${limit} générations atteint (garde-fou de coût). Réessaie demain.`);
}

// ---------- routeur ----------
async function route(req, env, url) {
  const { pathname: path } = url;
  const method = req.method;
  let m;

  if (path === '/api/health' && method === 'GET') return json({ ok: true, ai: Boolean(env.GEMINI_API_KEY), provider: env.AI_PROVIDER || 'gemini' });

  if (path === '/api/parent/login' && method === 'POST') {
    requireSecrets(env);
    if (!env.PARENT_PASSWORD || env.PARENT_PASSWORD.length < 12) throw new HttpError(500, 'Serveur mal configuré : PARENT_PASSWORD (≥ 12 caractères) manquant.');
    const key = `plogin:${clientIp(req)}`;
    if (await tooManyFailures(env, key, 8, 900)) throw new HttpError(429, 'Trop de tentatives. Réessaie dans 15 minutes.');
    const b = await readBody(req, 5_000);
    if (typeof b.password !== 'string' || !(await safeEqual(env.SESSION_SECRET, b.password, env.PARENT_PASSWORD))) {
      await recordFailure(env, key);
      throw new HttpError(401, 'Mot de passe incorrect.');
    }
    return json({ token: await signToken(env, { r: 'parent', e: Math.floor(Date.now() / 1000) + PARENT_TTL }) });
  }

  if (path === '/api/child/login' && method === 'POST') {
    requireSecrets(env);
    const key = `clogin:${clientIp(req)}`;
    if (await tooManyFailures(env, key, 10, 900)) throw new HttpError(429, 'Trop de tentatives. Réessaie dans 15 minutes.');
    const b = await readBody(req, 2_000);
    const code = normCode(b.code);
    const row = code.length === 8 ? await env.DB.prepare('SELECT id, name FROM profiles WHERE code_hash = ?').bind(await hmacHex(env.SESSION_SECRET, code)).first() : null;
    if (!row) { await recordFailure(env, key); throw new HttpError(401, 'Code incorrect.'); }
    return json({ token: await signToken(env, { r: 'child', p: row.id, e: Math.floor(Date.now() / 1000) + CHILD_TTL }), name: row.name });
  }

  // --- enfant ---
  if (path === '/api/me' && method === 'GET') {
    const t = await auth(env, req);
    if (t.r === 'parent') return json({ role: 'parent' });
    const p = await env.DB.prepare('SELECT name FROM profiles WHERE id = ?').bind(t.p).first();
    if (!p) throw new HttpError(401, 'Profil supprimé.');
    return json({ role: 'child', name: p.name });
  }
  if (path === '/api/sessions' && method === 'POST') {
    const t = await auth(env, req, 'child');
    const exists = await env.DB.prepare('SELECT 1 AS x FROM profiles WHERE id = ?').bind(t.p).first();
    if (!exists) throw new HttpError(401, 'Profil supprimé.');
    return postSession(env, req, t);
  }
  if (path === '/api/chapters' && method === 'GET') {
    await auth(env, req);
    const rows = (await env.DB.prepare("SELECT json FROM chapters WHERE status = 'published' ORDER BY created_at").all()).results;
    return json({ chapitres: rows.map((r) => JSON.parse(r.json)) });
  }

  // --- parent ---
  if (path.startsWith('/api/parent/')) {
    await auth(env, req, 'parent');

    if (path === '/api/parent/overview' && method === 'GET') return json(await overview(env));

    if (path === '/api/parent/profiles' && method === 'POST') {
      const b = await readBody(req, 2_000);
      const name = clip(b.name, 40).trim();
      if (!name) throw new HttpError(400, 'Prénom requis.');
      const count = (await env.DB.prepare('SELECT COUNT(*) AS n FROM profiles').first()).n;
      if (count >= 8) throw new HttpError(400, 'Maximum 8 profils.');
      const code = genCode();
      const id = uuid();
      await env.DB.prepare('INSERT INTO profiles (id, name, code_hash, created_at) VALUES (?,?,?,?)').bind(id, name, await hmacHex(env.SESSION_SECRET, code), Date.now()).run();
      return json({ id, name, code: prettyCode(code) }, 201);
    }
    if ((m = /^\/api\/parent\/profiles\/([\w-]+)\/reset-code$/.exec(path)) && method === 'POST') {
      const code = genCode();
      const r = await env.DB.prepare('UPDATE profiles SET code_hash = ? WHERE id = ?').bind(await hmacHex(env.SESSION_SECRET, code), m[1]).run();
      if (!(r.meta?.changes > 0)) throw new HttpError(404, 'Profil introuvable.');
      return json({ code: prettyCode(code) });
    }
    if ((m = /^\/api\/parent\/profiles\/([\w-]+)$/.exec(path)) && method === 'DELETE') {
      await env.DB.batch([env.DB.prepare('DELETE FROM sessions WHERE profile_id = ?').bind(m[1]), env.DB.prepare('DELETE FROM profiles WHERE id = ?').bind(m[1])]);
      return json({ ok: true });
    }
    if ((m = /^\/api\/parent\/profiles\/([\w-]+)\/sessions$/.exec(path)) && method === 'GET') {
      const rows = (await env.DB.prepare('SELECT * FROM sessions WHERE profile_id = ? ORDER BY created_at DESC LIMIT 100').bind(m[1]).all()).results;
      return json({ sessions: rows.map((r) => sessionRow(r, false)) });
    }
    if ((m = /^\/api\/parent\/sessions\/([\w-]+)$/.exec(path)) && method === 'GET') {
      const r = await env.DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(m[1]).first();
      if (!r) throw new HttpError(404, 'Séance introuvable.');
      return json(sessionRow(r, true));
    }
    if ((m = /^\/api\/parent\/sessions\/([\w-]+)\/grade$/.exec(path)) && method === 'POST') {
      return json(await gradeItem(env, m[1], await readBody(req, 2_000)));
    }

    if (path === '/api/parent/chapters' && method === 'GET') {
      const rows = (await env.DB.prepare('SELECT id, status, json, warnings, updated_at FROM chapters ORDER BY updated_at DESC').all()).results;
      return json({ chapters: rows.map((r) => ({ id: r.id, status: r.status, updatedAt: r.updated_at, warnings: JSON.parse(r.warnings || '[]'), chapter: JSON.parse(r.json) })) });
    }
    if ((m = /^\/api\/parent\/chapters\/([a-z0-9-]+)$/.exec(path)) && method === 'PUT') {
      const row = await env.DB.prepare('SELECT status FROM chapters WHERE id = ?').bind(m[1]).first();
      if (!row) throw new HttpError(404, 'Chapitre introuvable.');
      const b = await readBody(req, 400_000);
      const chapter = rebalanced(b.chapter);
      if (chapter?.id !== m[1]) throw new HttpError(400, "L'identifiant du chapitre ne peut pas changer.");
      try { validateChapter(chapter); } catch (e) { throw new HttpError(422, e.message); }
      await env.DB.prepare('UPDATE chapters SET json = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(chapter), Date.now(), m[1]).run();
      return json({ ok: true, chapter });
    }
    if ((m = /^\/api\/parent\/chapters\/([a-z0-9-]+)\/(publish|unpublish)$/.exec(path)) && method === 'POST') {
      const row = await env.DB.prepare('SELECT json FROM chapters WHERE id = ?').bind(m[1]).first();
      if (!row) throw new HttpError(404, 'Chapitre introuvable.');
      if (m[2] === 'publish') { try { validateChapter(JSON.parse(row.json)); } catch (e) { throw new HttpError(422, e.message); } }
      await env.DB.prepare('UPDATE chapters SET status = ?, updated_at = ? WHERE id = ?').bind(m[2] === 'publish' ? 'published' : 'draft', Date.now(), m[1]).run();
      return json({ ok: true });
    }
    if ((m = /^\/api\/parent\/chapters\/([a-z0-9-]+)$/.exec(path)) && method === 'DELETE') {
      await env.DB.prepare('DELETE FROM chapters WHERE id = ?').bind(m[1]).run();
      return json({ ok: true });
    }

    if (path === '/api/parent/ai/models' && method === 'GET') {
      try { return json({ models: await listModels(env), current: env.GEMINI_MODEL || 'gemini-flash-latest' }); }
      catch (e) { if (e instanceof AiError) throw new HttpError(e.status, e.message); throw e; }
    }
    if (path === '/api/parent/ai/import' && method === 'POST') {
      const body = await readBody(req, 400_000);
      let result;
      try {
        const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
        const input = { subject: clean(body?.subject, 60), level: clean(body?.level, 20), title: clean(body?.title, 120) };
        if (!input.subject || !input.level || !input.title) throw new AiError('Matière, niveau et titre sont obligatoires.', 400);
        result = importDraft(input, body?.json);
      } catch (e) { if (e instanceof AiError) throw new HttpError(e.status, e.message); throw e; }
      try { validateChapter(result.chapter); } catch (e) { throw new HttpError(422, `Brouillon invalide : ${e.message}`); }
      await saveDraft(env, result.chapter, result.warnings);
      return json({ id: result.chapter.id, chapter: result.chapter, warnings: result.warnings }, 201);
    }
    if (path === '/api/parent/ai/generate' && method === 'POST') {
      const body = await readBody(req, 7_000_000);
      let input;
      try { input = checkGenerateInput(body); } catch (e) { if (e instanceof AiError) throw new HttpError(e.status, e.message); throw e; }
      await aiQuota(env);
      let result;
      try { result = await generateDraft(env, input); } catch (e) { if (e instanceof AiError) throw new HttpError(e.status, e.message); throw e; }
      try { validateChapter(result.chapter); } catch (e) { throw new HttpError(422, `Brouillon invalide : ${e.message}`); }
      await saveDraft(env, result.chapter, result.warnings);
      return json({ id: result.chapter.id, chapter: result.chapter, warnings: result.warnings }, 201);
    }
  }

  throw new HttpError(404, 'Introuvable.');
}

export default {
  async fetch(req, env) {
    const cors = corsHeaders(env, req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    try {
      const res = await route(req, env, url);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status, cors);
      console.error('Erreur interne', e && e.stack ? e.stack : e);
      return json({ error: 'Erreur interne.' }, 500, cors);
    }
  },
};
