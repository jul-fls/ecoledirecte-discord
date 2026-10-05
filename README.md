# EcoleDirecte → Discord

Service autonome Node.js 24 : une vérification immédiate au démarrage, puis toutes les **60 secondes**, avec un embed Discord par message non lu. **Après confirmation Discord, le message est marqué comme lu sur EcoleDirecte.** Un conteneur sans volume, aucun serveur web, aucun port à ouvrir, aucune BDD, aucun fichier d'état et aucune dépendance npm. Ce dossier peut être copié tel quel dans un dépôt indépendant.

## Démarrage Docker Compose

Depuis ce dossier :

```sh
cp .env.example .env
# Renseigner identifiant, mot de passe et URL du webhook dans .env.
docker compose up -d --build
docker compose logs -f notifier
```

Sous PowerShell, remplacer la première commande par `Copy-Item .env.example .env`.

Créer le webhook dans les paramètres du salon Discord → Intégrations → Webhooks, puis copier son URL dans `DISCORD_WEBHOOK_URL`. Garder les secrets entre guillemets simples dans `.env`, pour que Compose préserve notamment les `$` et `#`. Un salon texte classique suffit ; pour un fil existant ou un salon forum/media, renseigner aussi `DISCORD_THREAD_ID`.

Le conteneur tourne avec l'utilisateur non privilégié `node`. Les identifiants et tokens ne sont pas intégrés à l'image. Les tokens EcoleDirecte restent uniquement en mémoire ; le service ne modifie jamais `.env`.

```sh
docker compose down            # Arrêter
docker compose up -d --build   # Mettre à jour / relancer
```

Utiliser **une seule instance** du service par compte : le statut lu/non lu sur EcoleDirecte détermine les notifications. Le service ne stocke rien sur disque.

## Variables d'environnement

| Variable | Valeur par défaut / rôle |
| --- | --- |
| `ECOLEDIRECTE_IDENTIFIANT` | Obligatoire : identifiant de connexion |
| `ECOLEDIRECTE_MDP` | Obligatoire : mot de passe |
| `DISCORD_WEBHOOK_URL` | Obligatoire : URL HTTPS du webhook |
| `ECOLEDIRECTE_PROFILE` | `A` : profil demandé ; accepte `P` ou `A` |
| `ECOLEDIRECTE_ACCOUNT_ID` | Facultatif : ID ou UID du compte de **connexion**, avant changement de profil |
| `ECOLEDIRECTE_API_BASE_URL` | `https://api.ecoledirecte.com/v3` : login et renouvellement |
| `ECOLEDIRECTE_APIP_BASE_URL` | `https://apip.ecoledirecte.com/v3` : messagerie |
| `ECOLEDIRECTE_API_VERSION` | `4.98.0` : version utilisée dans SAC |
| `ECOLEDIRECTE_MESSAGES_YEAR` | Facultatif : année de messagerie `AAAA-AAAA`. Vide = année courante choisie par ED ; si la réponse fournit `anneeMessages`, elle est reprise pour le passage en lu |
| `ECOLEDIRECTE_CONTENT_ENCODING` | `plain` ; choisir `base64` uniquement si le champ `content` de votre compte est encodé |
| `POLL_INTERVAL_SECONDS` | `60` ; entre 10 et 86400 |
| `REQUEST_TIMEOUT_SECONDS` | `20` par requête ; entre 1 et 120 |
| `DISCORD_USERNAME` | `EcoleDirecte` ; nom affiché par le webhook |
| `DISCORD_THREAD_ID` | Facultatif : ID du fil destinataire |

Sans `ECOLEDIRECTE_ACCOUNT_ID`, le service choisit le premier compte du profil demandé, puis le premier compte P/A disponible si un changement de profil est nécessaire. La convention P/A et le corps `{ profil, uid, uuid }` reprennent le code SAC : le service demande exactement la lettre configurée à EcoleDirecte, sans déduire un rôle de son libellé.

## Notifications et reprise

- Objet, expéditeur, date lorsqu'elle est disponible, contenu lisible et noms des pièces jointes dans un embed bleu avec lien vers EcoleDirecte.
- Conversion du HTML en texte lisible et neutralisation du Markdown injecté par l'expéditeur. Les mentions `@everyone`, rôles et utilisateurs ne déclenchent aucun ping.
- Texte dépassant l'aperçu joint intégralement en `.txt`. Les pièces jointes EcoleDirecte sont listées, sans téléchargement automatique.
- Lecture de la liste des messages reçus avec `getAll=1`, puis filtre strict `read === false`, comme dans SAC. Les messages déjà non lus au premier lancement sont envoyés.
- Ordre ancien → récent, un envoi à la fois. Pour chaque message : confirmation Discord avec `wait=true`, puis action EcoleDirecte `marquerCommeLu` (`verbe=put`, `ids: [id]`, `anneeMessages`).
- Un échec Discord empêche le passage en lu et interrompt le cycle ; le message reste à traiter au cycle suivant. Un échec du passage en lu est également signalé et interrompt le cycle. Les réponses Discord 429 déclenchent jusqu'à deux nouvelles tentatives suivant `retry_after` (30 secondes maximum par attente).
- Un message confirmé comme lu disparaît des notifications suivantes, y compris après redémarrage. Si vous le remettez manuellement en non lu, il sera renvoyé puis marqué comme lu à nouveau.
- Token expiré (codes ED 520/521/525, HTTP 401) : une reconnexion et restauration du profil par opération. L'opération de passage en lu peut être retentée sans renvoyer la notification Discord. Les tokens retournés avec une réponse réussie sont actualisés en mémoire. Un HTTP 403 est signalé sans lancer de connexion supplémentaire.
- Cycles sans chevauchement. Un cycle long reporte le suivant ; le service ne lance pas de rafale de rattrapage. SIGTERM/SIGINT termine l'envoi courant et empêche le démarrage du message suivant.

Une coupure entre l'acceptation du webhook et le passage en lu, une réponse Discord perdue après acceptation ou un échec du passage en lu peut produire un doublon au prochain cycle. Discord et EcoleDirecte ne partagent pas de transaction atomique. Le service privilégie la reprise des messages encore non lus.

### Migration depuis la version avec fichier d'état

Reconstruire avec `docker compose up -d --build`. `STATE_FILE` peut être retiré de votre `.env` : il n'est plus utilisé. L'ancien volume et son JSON ne sont plus montés ; ils peuvent être supprimés séparément si souhaité. Les messages notifiés par l'ancienne version mais toujours non lus seront envoyés à nouveau une fois, puis marqués comme lus.

## Exécution locale et tests

```sh
node --env-file-if-exists=.env src/index.js
node --test
```

Si npm est disponible, `npm start` et `npm test` sont équivalents. Rien à installer. Les tests utilisent des réponses simulées, sans identifiants réels et sans publier sur Discord.

## Origine et limites de l'intégration

### Diagnostic de connexion

Les erreurs indiquent désormais l'étape (`initialisation GTK`, `connexion`, `changement de profil`, `lecture des messages`, `passage du message en lu`) et distinguent le statut **HTTP** du code **API EcoleDirecte**. Les réponses HTTP non réussies indiquent également si le serveur renvoie du HTML ou du JSON, sans afficher le corps, les cookies, les identifiants ou les tokens.

Par exemple, `initialisation GTK : HTTP 403 (réponse HTML)` signifie que le refus arrive avant toute transmission du mot de passe. `connexion : API 250` indique une validation interactive de connexion. `lecture des messages : HTTP 403` situe le refus après authentification et sélection du profil ; le seul code ne permet pas de décider s'il vient du filtrage réseau ou des droits du compte.

Le client transmet `Origin` et `Referer` EcoleDirecte, conserve les cookies de session uniquement en mémoire et les actualise à chaque réponse. Le GET initial GTK ne comporte pas d'en-tête `Content-Type` de formulaire, réservé aux POST.

Après mise à jour, reconstruire l'image locale avec `docker compose up -d --build`, puis consulter `docker compose logs --tail=30 notifier`. Si vous utilisez une image publiée plutôt que le build local, il faut publier la nouvelle version et recréer le conteneur avec cette image ; reconstruire localement ne met pas automatiquement à jour le registre.

### Code extrait

Extraction du dépôt SAC : `src/scripts/auto/login.script.js` (GTK, login, `switchProfile`), `src/API_SAC/commons/helpers.common.js` (POST form-urlencoded, reconnexion), `src/API_SAC/commons/constants.common.js` (endpoint enseignants), `src/scripts/auto/get_data.script.js` (liste `received`, `read === false`). Aucun import SAC, Prisma ou frontend n'est nécessaire.

Le contenu envoyé correspond au champ `content` fourni par la **liste** de messagerie, comme dans le code d'origine. Si ED ne fournit que l'objet et l'expéditeur, la notification contient ces informations et un lien vers ED. Le service ne lance pas de requête de détail avant l'envoi : seul l'appel explicite suivant la confirmation Discord marque le message comme lu. Le lien ouvre EcoleDirecte ; il ne prétend pas pointer directement vers le message.

L'API EcoleDirecte reprise du dépôt doit être vérifiée avec votre compte. Un compte nécessitant une question de sécurité, un captcha ou une validation interactive ne peut pas être connecté automatiquement par ce flux de login (`fa: []`). Une erreur distante affiche uniquement son code, sans divulguer sa réponse.

Références Discord : [exécution des webhooks](https://docs.discord.com/developers/resources/webhook#execute-webhook) et [limites des embeds](https://docs.discord.com/developers/resources/message#embed-limits).

Format de l'action de passage en lu vérifié dans [le client wrapdirecte 0.3.1](https://unpkg.com/wrapdirecte@0.3.1/dist/index.mjs) (module élèves). Le même format est appliqué à la route enseignants utilisée par SAC ; cette adaptation et la sélection implicite de l'année restent à confirmer avec votre compte réel. `ECOLEDIRECTE_MESSAGES_YEAR` permet de fixer l'année explicitement si nécessaire.
