import http from 'node:http';
export function startMockGemini(port = 8799) {
  const state = { mode: 'ok', last: null, calls: 0 };
  const q = (type, i, extra = {}) => ({ topic: `Notion ${1 + (i % 4)}`, prompt: `Question ${type} numéro ${i} ?`, type, explanation: `Explication ${i}.`, weight: 1 + (i % 3), ...extra });
  const bank = (n, tag) => {
    const out = [];
    for (let i = 1; i <= n; i++) {
      if (i % 5 === 0) out.push(q('text', i, { prompt: `${tag} réponse courte ${i} ?`, correct: ['réponse', 'variante'], accepted: ['Réponse', 'autre'] }));
      else if (i % 7 === 0) out.push(q('multi', i, { prompt: `${tag} multi ${i} ?`, options: ['A', 'B', 'C', 'D'], correct: ['A', 'C'] }));
      else out.push(q('single', i, { prompt: `${tag} choix ${i} ?`, options: ['Vrai', 'Faux', 'Peut-être'], correct: [i % 2 ? 'vrai' : 'Faux'] })); // 'vrai' en minuscule : doit être réparé
    }
    out.push(q('single', 90, { prompt: `${tag} cassée (bonne réponse absente)`, options: ['X', 'Y'], correct: ['Z'] }));
    out.push(q('manual', 91, { prompt: `${tag} libre 1`, example: 'ex' }), q('manual', 92, { prompt: `${tag} libre 2` }), q('manual', 93, { prompt: `${tag} libre 3` }));
    return out;
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(typeof o === 'string' ? o : JSON.stringify(o)); };
      if (req.url === '/__state') return send(200, state);
      if (req.url.startsWith('/__mode/')) { state.mode = req.url.split('/')[2]; return send(200, { ok: true }); }
      state.calls++;
      state.last = { url: req.url, key: req.headers['x-goog-api-key'], body: body ? JSON.parse(body) : null };
      if (req.headers['x-goog-api-key'] !== 'test-key-SECRET-ne-doit-jamais-sortir') return send(403, { error: 'bad key' });
      if (req.url.startsWith('/v1beta/models?')) return send(200, { models: [{ name: 'models/gemini-flash-latest', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-3-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-4-flash-preview', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] }] });
      if (state.mode === 'oldmodel' && !req.url.includes('/gemini-3-flash:')) return send(404, { error: { message: 'model not found' } });
      if (state.mode === 'busy' && !req.url.includes('/gemini-flash-latest:')) return send(503, { error: { message: 'This model is currently experiencing high demand.' } });
      if (state.mode === '429') return send(429, { error: { message: 'quota' } });
      if (state.mode === 'garbage') return send(200, { candidates: [{ content: { parts: [{ text: 'pas du json {' }] } }] });
      if (state.mode === 'blocked') return send(200, { promptFeedback: { blockReason: 'SAFETY' } });
      send(200, { candidates: [{ content: { parts: [{ text: JSON.stringify({ warnings: ['Incertain : mot illisible ligne 3'], training: bank(22, 'T'), evaluation: bank(16, 'E') }) }] } }] });
    });
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ server, state })));
}
