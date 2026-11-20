// Validation d'un chapitre : même règles que validChapter() dans index.html
// (5 à 60 questions par banque, barème = exactement 20 points, identifiants distincts entre banques).

const KINDS = ['single', 'multi', 'text', 'manual', 'pair', 'factor'];

function checkBank(bank, label, usedIds) {
  if (!Array.isArray(bank) || bank.length < 5 || bank.length > 60) throw new Error(`${label} : nombre de questions incorrect`);
  let total = 0;
  const ids = new Set();
  for (const q of bank) {
    if (!q || !Number.isInteger(q.id) || ids.has(q.id) || usedIds.has(q.id)) throw new Error(`${label} : identifiant de question incorrect`);
    if (!KINDS.includes(q.type)) throw new Error(`${label} Q${q.id} : type inconnu`);
    for (const k of ['prompt', 'topic', 'explanation']) {
      if (typeof q[k] !== 'string' || !q[k].trim()) throw new Error(`${label} Q${q.id} : champ « ${k} » manquant`);
    }
    if (!Number.isFinite(q.weight) || q.weight <= 0) throw new Error(`${label} Q${q.id} : poids incorrect`);
    ids.add(q.id);
    total += q.weight;
    if ((q.type === 'single' || q.type === 'multi') && (!Array.isArray(q.options) || q.options.length < 2)) throw new Error(`${label} Q${q.id} : options manquantes`);
    if (q.type === 'single' && !q.options.includes(q.solution)) throw new Error(`${label} Q${q.id} : réponse absente des options`);
    if (q.type === 'multi' && (!Array.isArray(q.solution) || !q.solution.length || q.solution.some((x) => !q.options.includes(x)))) throw new Error(`${label} Q${q.id} : réponses multiples incorrectes`);
    if (q.type === 'text' && !['number', 'string'].includes(typeof q.solution)) throw new Error(`${label} Q${q.id} : réponse texte incorrecte`);
    if (q.type === 'text' && (typeof q.solution === 'string' ? !q.solution.trim() : false)) throw new Error(`${label} Q${q.id} : réponse texte vide`);
    if (q.type === 'pair' && (!Array.isArray(q.solution) || q.solution.length !== 2 || !Array.isArray(q.labels) || q.labels.length !== 2)) throw new Error(`${label} Q${q.id} : paire incorrecte`);
    if (q.type === 'factor' && (typeof q.solution !== 'number' || typeof q.displaySolution !== 'string')) throw new Error(`${label} Q${q.id} : factorisation incorrecte`);
  }
  if (Math.abs(total - 20) > 1e-8) throw new Error(`${label} : barème de ${total} points au lieu de 20`);
  return ids;
}

export function validateChapter(c) {
  if (!c || typeof c.id !== 'string' || !/^[a-z0-9-]{3,80}$/.test(c.id)) throw new Error('Identifiant incorrect');
  for (const k of ['name', 'subject', 'level']) {
    if (typeof c[k] !== 'string' || !c[k].trim()) throw new Error('Matière, titre ou niveau manquant');
  }
  const ids = checkBank(c.questions, 'Entraînement', new Set());
  if (c.evaluationQuestions !== undefined) checkBank(c.evaluationQuestions, 'Évaluation', ids);
  if (c.lesson !== undefined) {
    if (!Array.isArray(c.lesson) || !c.lesson.length || c.lesson.length > 30) throw new Error('Fiche de cours : nombre de cartes incorrect');
    for (const k of c.lesson) {
      if (!k || ['topic', 'title', 'text', 'kind'].some((f) => typeof k[f] !== 'string' || !k[f].trim())) throw new Error('Fiche de cours : carte incomplète');
      if (k.examples !== undefined && (!Array.isArray(k.examples) || k.examples.some((x) => typeof x !== 'string'))) throw new Error('Fiche de cours : exemples incorrects');
    }
  }
  return c;
}

export function tryValidate(c) {
  try {
    validateChapter(c);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
