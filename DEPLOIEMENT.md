# Révisio autonome — mise en ligne (≈ 20 min)

Architecture : `index.html` + `parent.html` restent sur GitHub Pages. Un petit serveur (Cloudflare Worker + base D1, dossier `worker/`) garde la clé Gemini, les résultats et les chapitres créés. **Aucun secret ni donnée d'enfant dans le dépôt GitHub.**

## 1. Serveur (sur ton PC, Node 20+)
```bash
cd worker
npm install
npx wrangler login                 # ouvre le navigateur, compte Cloudflare gratuit
npx wrangler d1 create revisio     # copie le database_id affiché dans wrangler.toml
npm run db:init                    # crée les tables
npx wrangler secret put GROQ_API_KEY      # colle ta clé Groq (console.groq.com)
npx wrangler secret put PARENT_PASSWORD   # 12 caractères minimum, que toi seul connais
npx wrangler secret put SESSION_SECRET    # ex. résultat de : openssl rand -base64 36
npx wrangler deploy                # affiche l'adresse https://revisio-api.XXXX.workers.dev
```
Si tu recrées `SESSION_SECRET`, tous les codes enfants et sessions sont invalidés (à ne faire qu'en cas de fuite).

## 2. Site
Dans `config.js`, mets `API_BASE: 'https://revisio-api.XXXX.workers.dev'` puis publie sur GitHub (`index.html`, `parent.html`, `config.js`). Si ton site n'est pas à `https://nadir-formadirect.github.io`, adapte `ALLOWED_ORIGIN` dans `wrangler.toml` et redéploie.

## 3. Premier usage
1. Ouvre `…/revisio/parent.html` sur ton téléphone → mot de passe.
2. **Réglages → Tester l’IA** : vérifie que la clé marche et affiche le modèle utilisé.
3. **Enfants → Ajouter un enfant** : note le code (affiché une seule fois). L'enfant l'entre une fois sur son appareil.
4. **Créer un cours** : texte et/ou photos → brouillon → tu relis, retires les questions douteuses → Publier.

## Garde-fous
- Plafond de 20 générations IA par jour (`AI_DAILY_LIMIT`). Palier gratuit Groq sans carte bancaire = refus (429) en cas de dépassement, pas de facture.
- Connexions limitées (8 essais parent / 10 essais code enfant par 15 min et par IP).
- L'IA ne voit jamais les résultats des enfants et ne note rien : la note vient des règles du moteur ; l'IA n'écrit que des brouillons que tu publies.
- Supprimer un profil efface tout son historique.

## Fournisseur IA
Par défaut : **Groq** (`AI_PROVIDER = "groq"`, `GROQ_MODEL` pour le texte du cours, `GROQ_VISION_MODEL` pour les photos, dans `wrangler.toml`). Si ce modèle est retiré par Groq, le serveur en choisit automatiquement un autre. Gemini reste disponible en réserve (`AI_PROVIDER = "gemini"` + secret `GEMINI_API_KEY`).

La clé peut aussi être ajoutée sans ligne de commande : tableau de bord Cloudflare → Workers & Pages → `revisio-api` → Settings → Variables and Secrets → Add → type **Secret**, nom `GROQ_API_KEY`.

## Conformité Gemini (si réactivé)
Les conditions Gemini API (en vigueur au 23/03/2026) interdisent les services « dirigés vers des moins de 18 ans ou susceptibles d'être utilisés par eux » et imposent le palier **payant** pour des utilisateurs de l'EEE. Elles indiquent aussi que le palier gratuit sert à améliorer les produits Google. Ici, l'IA n'est appelée que depuis l'espace parent, mais la clause vise le service dans son ensemble : **prototype uniquement**. Pour un usage durable, changer de fournisseur ou passer au palier payant (ajouter une fonction dans `PROVIDERS` de `worker/src/ai.js`).

## Tests
`cd worker && npm test` (API, 87 vérifications, Gemini et Groq simulés).
