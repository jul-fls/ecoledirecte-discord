# EcoleDirecte → Discord

Service autonome Node.js 24 : une vérification immédiate au démarrage, puis toutes les **60 secondes**, avec le **corps complet et les pièces jointes** des messages non lus envoyés sur Discord. **Après confirmation de tous les envois Discord, le message est marqué comme lu sur EcoleDirecte.** Un conteneur sans volume, aucun serveur web, aucun port à ouvrir, aucune BDD, aucun fichier d'état et aucune dépendance npm. Ce dossier peut être copié tel quel dans un dépôt indépendant.

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
| `ECOLEDIRECTE_PROFILE` | `A` (personnel) ; choisir `P` pour le profil enseignant |
| `ECOLEDIRECTE_ACCOUNT_ID` | Facultatif : ID ou UID du compte de **connexion**, avant changement de profil |
| `ECOLEDIRECTE_API_BASE_URL` | `https://api.ecoledirecte.com/v3` : login et renouvellement |
| `ECOLEDIRECTE_APIP_BASE_URL` | `https://apip.ecoledirecte.com/v3` : messagerie |
| `ECOLEDIRECTE_API_VERSION` | `4.98.0` : version utilisée dans SAC |
| `ECOLEDIRECTE_MESSAGES_YEAR` | Facultatif : année de messagerie `AAAA-AAAA`. Vide = année courante choisie par ED ; si la réponse fournit `anneeMessages`, elle est reprise pour le passage en lu |
| `ECOLEDIRECTE_TIMEZONE` | `Europe/Paris` : fuseau IANA des dates ED sans offset. Les dates portant déjà `Z` ou un offset explicite sont respectées |
| `POLL_INTERVAL_SECONDS` | `60` ; entre 10 et 86400 |
| `REQUEST_TIMEOUT_SECONDS` | `20` par requête ; entre 1 et 120 |
| `ATTACHMENT_MAX_MB` | `10` MiB par pièce jointe téléchargée ; entre 1 et 24. Ne pas dépasser la taille acceptée par votre salon Discord |
| `ATTACHMENTS_TOTAL_MAX_MB` | `64` MiB par message ED ; entre 1 et 1024. Limite du cumul de fichiers conservés en mémoire |
| `DISCORD_USERNAME` | `EcoleDirecte` ; nom affiché par le webhook |
| `DISCORD_THREAD_ID` | Facultatif : ID du fil destinataire |

Sans `ECOLEDIRECTE_ACCOUNT_ID`, le service choisit le premier compte du profil demandé, puis le premier compte P/A disponible si un changement de profil est nécessaire. Le changement reprend le corps `{ profil, uid, uuid }` de SAC. Selon les constantes du client web officiel, **A = personnel** et **P = enseignant**. La lecture et le passage en lu utilisent donc `/personnels/{id}/messages.awp` pour A et `/enseignants/{id}/messages.awp` pour P, avec l'identifiant et le token du profil actif. Pour passer d'un compte personnel au profil enseignant, configurer `ECOLEDIRECTE_PROFILE=P`.

## Notifications et reprise

- Objet, expéditeur, date lorsqu'elle est disponible et contenu lisible dans un embed bleu, avec les véritables pièces jointes uploadées sur Discord.
- Les dates ED sans fuseau sont interprétées en `Europe/Paris` par défaut, avec les changements été/hiver, puis converties en UTC pour Discord. Exemple : `2026-10-05 09:30:00` devient `2026-10-05T07:30:00.000Z`, affiché à 09:30 chez un utilisateur Discord en France. La conversion ne dépend pas du fuseau du conteneur ; l'heure de publication du webhook près de son nom reste celle de l'envoi sur Discord. Une date invalide ou une heure inexistante lors du passage à l'été n'ajoute pas de timestamp. Pour l'heure répétée à l'automne sans offset, le premier instant est retenu ; un offset explicite fourni par ED lève l'ambiguïté.
- Conversion du HTML en texte lisible et neutralisation du Markdown injecté par l'expéditeur. Les mentions `@everyone`, rôles et utilisateurs ne déclenchent aucun ping.
- Corps complet obtenu sur la route de détail `/personnels/{id}/messages/{messageId}.awp` ou `/enseignants/...`, avec `mode=destinataire`. Le HTML encodé en base64 est décodé automatiquement ; le texte brut est également accepté. Un contenu absent du détail provoque une erreur explicite, sans envoyer une notification vide de remplacement.
- Texte dépassant l'aperçu joint intégralement en `.txt`. Les pièces jointes sont téléchargées par POST `/telechargement.awp` avec `fichierId` et `leTypeDeFichier=PIECE_JOINTE`, puis uploadées via multipart. Les noms réels retournés par ED sont conservés, avec des noms uniques si plusieurs fichiers portent le même nom.
- Tous les fichiers sont traités en mémoire, sans écriture locale. Les tailles sont vérifiées pendant le téléchargement, même si ED ne fournit pas `Content-Length`. Une erreur ED dans `X-Code` est refusée même si le statut HTTP est 200 ; une page d'erreur HTML n'est pas envoyée comme PDF.
- Les fichiers sont répartis en lots d'au plus 10, avec au plus 24 MiB de données binaires par requête. Le premier lot contient l'embed ; les suivants sont identifiés comme pièces jointes du même message ED. Le texte long en `.txt` compte comme un fichier. Si un fichier ou le cumul dépasse les limites configurées, l'envoi est interrompu et signalé dans les logs, sans ignorer de pièce jointe.
- Lecture de la liste des messages reçus avec `getAll=1`, puis filtre strict `read === false`, comme dans SAC. Les messages déjà non lus au premier lancement sont envoyés.
- Ordre ancien → récent, un message ED à la fois. Pour chaque message : récupération du détail, restauration immédiate en non lu via `marquerCommeNonLu`, téléchargement de tous les fichiers, confirmation de tous les lots Discord avec `wait=true`, puis action EcoleDirecte `marquerCommeLu` (`verbe=put`, `ids: [id]`, `anneeMessages`).
- Un échec Discord empêche le passage en lu et interrompt le cycle ; le message reste à traiter au cycle suivant. Un échec du passage en lu est également signalé et interrompt le cycle. Les réponses Discord 429 déclenchent jusqu'à deux nouvelles tentatives suivant `retry_after` (30 secondes maximum par attente).
- Un message confirmé comme lu disparaît des notifications suivantes, y compris après redémarrage. Si vous le remettez manuellement en non lu, il sera renvoyé puis marqué comme lu à nouveau.
- Token expiré (codes ED 520/521/525, HTTP 401) : une reconnexion et restauration du profil par opération. L'opération de passage en lu peut être retentée sans renvoyer la notification Discord. Les tokens retournés avec une réponse réussie sont actualisés en mémoire. Un HTTP 403 est signalé sans lancer de connexion supplémentaire.
- Cycles sans chevauchement. Un cycle long reporte le suivant ; le service ne lance pas de rafale de rattrapage. SIGTERM/SIGINT termine l'envoi courant et empêche le démarrage du message suivant.

L'appel de détail ED peut marquer le message comme lu. Le service tente de le remettre immédiatement en non lu, même si cet appel échoue ou si sa réponse est perdue. Si la restauration elle-même échoue, l'erreur est signalée et l'envoi n'est pas lancé : le statut du message doit alors être vérifié sur ED. Une coupure du processus entre lecture et restauration peut aussi laisser un message lu avant sa livraison. Sans état persistant et sans transaction côté ED, cette petite fenêtre ne peut pas être supprimée.

Une coupure entre l'acceptation du webhook et le passage définitif en lu, une réponse Discord perdue après acceptation, un échec du passage en lu ou l'échec d'un lot après l'envoi des précédents peut produire des doublons au prochain cycle. Discord et EcoleDirecte ne partagent pas de transaction atomique. Un échec de téléchargement ou d'envoi après restauration laisse le message non lu pour sa reprise.

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

Un `lecture des messages : API 403` peut venir d'une route incompatible avec le profil. L'ancienne version utilisait systématiquement `/enseignants`, même avec A : ce défaut est corrigé. Si le refus persiste avec la route correspondant au profil, vérifier les droits de messagerie du compte et le profil demandé sur EcoleDirecte.

Le client transmet `Origin` et `Referer` EcoleDirecte, conserve les cookies de session uniquement en mémoire et les actualise à chaque réponse. Le GET initial GTK ne comporte pas d'en-tête `Content-Type` de formulaire, réservé aux POST.

Après mise à jour, reconstruire l'image locale avec `docker compose up -d --build`, puis consulter `docker compose logs --tail=30 notifier`. Si vous utilisez une image publiée plutôt que le build local, il faut publier la nouvelle version et recréer le conteneur avec cette image ; reconstruire localement ne met pas automatiquement à jour le registre.

### Code extrait

Extraction du dépôt SAC : `src/scripts/auto/login.script.js` (GTK, login, `switchProfile`), `src/API_SAC/commons/helpers.common.js` (POST form-urlencoded, reconnexion), `src/API_SAC/commons/constants.common.js` (endpoint enseignants), `src/scripts/auto/get_data.script.js` (liste `received`, `read === false`). Aucun import SAC, Prisma ou frontend n'est nécessaire.

Le contenu est désormais récupéré sur la route de **détail** plutôt que sur la liste, puis les fichiers sont téléchargés avec le token et les cookies de session ED. Les URL présentes dans les métadonnées des fichiers ne sont pas suivies : seul l'endpoint de téléchargement ED configuré est utilisé. Le lien de l'embed ouvre EcoleDirecte ; il ne prétend pas pointer directement vers le message.

L'API EcoleDirecte reprise du dépôt doit être vérifiée avec votre compte. Un compte nécessitant une question de sécurité, un captcha ou une validation interactive ne peut pas être connecté automatiquement par ce flux de login (`fa: []`). Une erreur distante affiche uniquement son code, sans divulguer sa réponse.

Références Discord : [exécution des webhooks](https://docs.discord.com/developers/resources/webhook#execute-webhook), [envoi de fichiers](https://docs.discord.com/developers/reference#uploading-files) et [limites des messages](https://docs.discord.com/developers/resources/message#create-message).

Routes de profils et action de passage en lu vérifiées dans [le code du client web officiel EcoleDirecte](https://www.ecoledirecte.com/chunk-JGSLBWTI.js), consulté le 5 octobre 2026 : mapping `A: personnels`, `P: enseignants`, méthodes `getUnreadMessages`, `markMessagesAsRead` et `swipeProfil`. Ce fichier peut changer avec les mises à jour du site. La sélection implicite de l'année reste à confirmer avec votre compte réel ; `ECOLEDIRECTE_MESSAGES_YEAR` permet de fixer l'année explicitement si nécessaire.
