# EcoleDirecte → Discord

Service autonome Node.js 24 : une vérification immédiate au démarrage, puis toutes les **60 secondes**, avec un embed Discord par nouveau message non lu. Un conteneur, aucun serveur web, aucun port à ouvrir, aucune BDD et aucune dépendance npm. Ce dossier peut être copié tel quel dans un dépôt indépendant.

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
docker compose down            # Arrêter, en conservant l'état anti-doublons
docker compose up -d --build   # Mettre à jour / relancer
```

`docker compose down -v` supprime l'état : les messages toujours non lus seront alors renvoyés. Utiliser **une seule instance** du service par compte/webhook et volume.

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
| `ECOLEDIRECTE_CONTENT_ENCODING` | `plain` ; choisir `base64` uniquement si le champ `content` de votre compte est encodé |
| `POLL_INTERVAL_SECONDS` | `60` ; entre 10 et 86400 |
| `REQUEST_TIMEOUT_SECONDS` | `20` par requête ; entre 1 et 120 |
| `DISCORD_USERNAME` | `EcoleDirecte` ; nom affiché par le webhook |
| `DISCORD_THREAD_ID` | Facultatif : ID du fil destinataire |
| `STATE_FILE` | `./data/state.json` en local ; Compose fixe `/app/data/state.json` dans son volume |

Sans `ECOLEDIRECTE_ACCOUNT_ID`, le service choisit le premier compte du profil demandé, puis le premier compte P/A disponible si un changement de profil est nécessaire. La convention P/A et le corps `{ profil, uid, uuid }` reprennent le code SAC : le service demande exactement la lettre configurée à EcoleDirecte, sans déduire un rôle de son libellé.

## Notifications et reprise

- Objet, expéditeur, date lorsqu'elle est disponible, contenu lisible et noms des pièces jointes dans un embed bleu avec lien vers EcoleDirecte.
- Conversion du HTML en texte lisible et neutralisation du Markdown injecté par l'expéditeur. Les mentions `@everyone`, rôles et utilisateurs ne déclenchent aucun ping.
- Texte dépassant l'aperçu joint intégralement en `.txt`. Les pièces jointes EcoleDirecte sont listées, sans téléchargement automatique.
- Lecture de la liste des messages reçus avec `getAll=1`, puis filtre strict `read === false`, comme dans SAC. Aucun message n'est marqué comme lu. Les messages déjà non lus au premier lancement sont envoyés.
- Ordre ancien → récent, un envoi à la fois. Un message toujours non lu n'est envoyé qu'une fois, même après redémarrage et même s'il est lu puis remis en non lu.
- Confirmation Discord avec `wait=true` avant sauvegarde de l'identifiant. Un échec d'envoi interrompt le cycle et est retenté au cycle suivant. Les réponses 429 déclenchent jusqu'à deux nouvelles tentatives suivant `retry_after` (30 secondes maximum par attente).
- Token expiré (code ED 520, HTTP 401/403) : une reconnexion et restauration du profil par cycle. Les tokens retournés avec une réponse de messagerie réussie sont actualisés en mémoire.
- Cycles sans chevauchement. Un cycle long reporte le suivant ; le service ne lance pas de rafale de rattrapage. SIGTERM/SIGINT termine l'envoi courant et empêche le démarrage du message suivant.

Le fichier JSON ne contient que des identifiants de messages et une empreinte du contexte compte/profil/destination. Il est écrit atomiquement dans le volume `notifications`. Aucun contenu de message, mot de passe, cookie ou token n'y est conservé. Les identifiants restent mémorisés sans purge automatique afin d'éviter de renvoyer un ancien message non lu. Un fichier corrompu ou une erreur de sauvegarde arrête le service et est signalé dans les logs.

Une coupure entre l'acceptation du webhook et l'écriture de l'état, ou une réponse Discord perdue après acceptation, peut produire un doublon au prochain essai. Le webhook ne permet pas une transaction atomique avec le fichier local.

## Exécution locale et tests

```sh
node --env-file-if-exists=.env src/index.js
node --test
```

Si npm est disponible, `npm start` et `npm test` sont équivalents. Rien à installer. Les tests utilisent des réponses simulées, sans identifiants réels et sans publier sur Discord.

## Origine et limites de l'intégration

Extraction du dépôt SAC : `src/scripts/auto/login.script.js` (GTK, login, `switchProfile`), `src/API_SAC/commons/helpers.common.js` (POST form-urlencoded, reconnexion), `src/API_SAC/commons/constants.common.js` (endpoint enseignants), `src/scripts/auto/get_data.script.js` (liste `received`, `read === false`). Aucun import SAC, Prisma ou frontend n'est nécessaire.

Le contenu envoyé correspond au champ `content` fourni par la **liste** de messagerie, comme dans le code d'origine. Si ED ne fournit que l'objet et l'expéditeur, la notification contient ces informations et un lien vers ED. Le service ne lance pas de requête de détail susceptible de marquer le message comme lu. Le lien ouvre EcoleDirecte ; il ne prétend pas pointer directement vers le message.

L'API EcoleDirecte reprise du dépôt doit être vérifiée avec votre compte. Un compte nécessitant une question de sécurité, un captcha ou une validation interactive ne peut pas être connecté automatiquement par ce flux de login (`fa: []`). Une erreur distante affiche uniquement son code, sans divulguer sa réponse.

Références Discord : [exécution des webhooks](https://docs.discord.com/developers/resources/webhook#execute-webhook) et [limites des embeds](https://docs.discord.com/developers/resources/message#embed-limits).
