# Révisio V3.1 — Application familiale de révisions

Site : https://nadir-formadirect.github.io/revisio/

## Architecture
- `index.html` : moteur d'interface, correction, notation, bilans et import local de chapitre.
- `chapitres.json` : bibliothèque publique de chapitres (données uniquement).

Pour publier un **nouveau chapitre sur tous les appareils**, ajouter un objet chapitre à `chapitres.json`, dans le tableau `chapitres`. Ne pas modifier le moteur `index.html`.

## Ajouter un chapitre sur un seul appareil
Depuis l'accueil Révisio, utiliser « Importer une nouvelle leçon » et sélectionner un fichier JSON contenant un chapitre, ou un objet `{"chapitres":[...]}`.
L'import est stocké localement dans le navigateur. Il **n'est pas synchronisé** et peut être perdu si les données Safari sont effacées. Ne pas y stocker des informations personnelles concernant les enfants.

## Format d'un chapitre
```json
{
  "id": "svt-cellules-5e",
  "subject": "SVT",
  "name": "Les cellules",
  "level": "5e",
  "questions": [
    {
      "id": 1,
      "topic": "Mémorisation",
      "prompt": "Une question inédite du cours ?",
      "type": "single",
      "options": ["Bonne réponse", "Mauvaise réponse"],
      "solution": "Bonne réponse",
      "explanation": "Explication pédagogique fiable",
      "weight": 1
    }
  ]
}
```
Cet exemple montre seulement la structure ; un import réel nécessite **5 à 60 questions totalisant exactement 20 points** et des réponses vérifiées.

Types pris en charge : `single`, `multi`, `text`, `manual`, `pair`, `factor`. Les réponses libres `manual` demandent une validation parentale.

## Processus de travail conseillé
1. Le parent envoie les photos de cours à ChatGPT.
2. L'IA extrait le contenu, signale les zones illisibles et prépare un contrôle structuré avec barème et corrigé.
3. Le parent vérifie le contenu.
4. ChatGPT modifie uniquement `chapitres.json` dans GitHub (pas `index.html`).
5. GitHub Pages publie la bibliothèque mise à jour à l'adresse inchangée.

## Limites de la V3.1
Pas d'IA intégrée au site, pas d'analyse de photo automatique, pas d'authentification, pas de synchronisation des résultats entre appareils. GitHub Pages et ce dépôt sont publics ; aucun nom, photo de cahier nominative, note individuelle ou information sensible ne doit être publié dans `chapitres.json`.


## V3.1 — Évaluations distinctes de l'entraînement

Chaque chapitre peut contenir deux banques distinctes :
- `questions` : entraînement (correction immédiate)
- `evaluationQuestions` : contrôle inédit (sans correction avant le bilan ; ordre des questions mélangé à chaque séance)

Chaque banque est notée indépendamment sur 20 points. Les questions ont des identifiants distincts entre banques.
Le moteur de notation, la validation parentale et les bilans sont communs, mais la série de questions affichée dépend du mode choisi.
Pour un nouveau cours, préparer les **deux banques**, avec exercices différents sur les mêmes compétences, et vérifier chaque corrigé et chaque barème.
La validation d'un chapitre est refusée si les identifiants se chevauchent ou si une banque ne totalise pas exactement 20 points.
Cette version possède 100 questions d'entraînement et 75 questions d'évaluation, sur 5 chapitres.

Les évaluations ne sont pas générées à la volée par une IA : ce sont des sujets prévalidés. Le mélange de l'ordre ne doit pas être confondu avec une nouvelle génération d'exercices.
