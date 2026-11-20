import http from 'node:http';
// Faux serveur Groq (API compatible OpenAI) pour les tests.
export function startMockGroq(port = 8798) {
  const state = { mode: 'ok', calls: 0, last: null, models: [], tpm: 0, vision: [] };
  const q = (type, i, extra = {}) => ({ topic: `Notion ${1 + (i % 4)}`, prompt: `Question ${type} ${i} ?`, type, explanation: `Explication ${i}.`, weight: 1 + (i % 3), ...extra });
  const bank = (n, tag) => Array.from({ length: n }, (_, k) => (k % 6 === 5 ? q('text', k, { prompt: `${tag} courte ${k} ?`, correct: ['mot'], accepted: ['Mot'] }) : q('single', k, { prompt: `${tag} choix ${k} ?`, options: ['Oui', 'Non', 'Parfois'], correct: ['oui'] })));
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      state.calls++;
      const b = body ? JSON.parse(body) : null;
      state.last = { url: req.url, auth: req.headers.authorization, body: b };
      if (req.headers.authorization !== 'Bearer groq-key-SECRET-ne-doit-jamais-sortir') return send(401, { error: { message: 'Invalid API Key' } });
      if (req.url === '/openai/v1/models') return send(200, { data: [{ id: 'openai/gpt-oss-120b' }, { id: 'allam-2-7b' }, { id: 'whisper-large-v3' }, { id: 'openai/gpt-oss-20b' }, { id: 'qwen/qwen3.8-27b' }, { id: 'qwen/qwen3.9-32b' }] });
      if (state.mode === '429') return send(429, { error: { message: 'Rate limit reached for tokens per day' } });
      if (state.mode === 'tpm' && state.tpm++ === 0) { res.setHeader('retry-after', '1'); return send(429, { error: { message: 'Rate limit reached for tokens per minute. Please try again in 1s.' } }); }
      if (state.mode === 'gone' && b.model === 'qwen/qwen3.8-27b') return send(404, { error: { message: `The model ${b.model} does not exist or you do not have access to it.`, code: 'model_not_found' } });
      if (state.mode === 'novision' && Array.isArray(b.messages[1].content)) return send(400, { error: { message: 'image input is not supported for this model' } });
      if (state.mode === 'garbage') return send(200, { choices: [{ message: { content: 'pas du json {' } }] });
      state.models.push(b.model);
      const sys = b.messages[0].content;
      if (sys.startsWith('Tu recopies')) { state.vision.push(b); return send(200, { choices: [{ message: { content: `Texte recopié de ${b.messages[1].content.length - 1} photo(s). La cellule a un [illisible].` } }] }); }
      const out = sys.includes('UNIQUEMENT la banque "training"') ? { warnings: ['Incertain : ligne 2 illisible'], training: bank(20, 'T') } : { warnings: [], evaluation: bank(15, 'E') };
      send(200, { choices: [{ message: { content: JSON.stringify(out) } }] });
    });
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ server, state })));
}
