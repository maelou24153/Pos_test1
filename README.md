# Resto POS

Caisse et prise de commande pour restaurant, en **Node.js**, avec les données stockées **en ligne** (base SQLite côté serveur).
Fonctionne dans le navigateur sur **Android** et **Windows**, et s'installe comme une appli (PWA).

## Fonctions

- Plusieurs restaurants sur un même serveur (chacun a son code et ses données séparées)
- Rôles : gérant, serveur, cuisine
- Plan de tables avec état (libre / occupée / plat prêt)
- Prise de commande tactile, notes pour la cuisine, envoi en cuisine
- Écran cuisine en temps réel (à préparer → en préparation → prêt → servi)
- **Confirmation du cuisinier** : le bouton « Prêt ✔ » demande une confirmation avant de prévenir la salle
- **Alerte serveur « plat prêt »** : bip, vibration, bandeau persistant (table, plat, temps d'attente) et notification système si l'appli est en arrière-plan. Le serveur touche « J'y vais » (la cuisine voit qui vient) puis « Servi »
- **Impression de tickets** : addition, ticket de caisse (proposé après l'encaissement) et bon de cuisine (🖨 sur chaque carte de l'écran cuisine), mis en page pour imprimante thermique 80 mm ou A4
- Encaissement espèces / carte
- Gestion du menu : catégories, produits, prix, masquer un produit, tables
- Gestion de l'équipe
- Rapports : chiffre d'affaires, ticket moyen, produits les plus vendus, ventes par jour, moyens de paiement
- Synchronisation en direct entre tous les appareils (SSE)
- **Commande par les clients** : un QR code par table, le client commande depuis son téléphone sans rien installer ni créer de compte

## Lancer en local

Prérequis : **Node.js 22.5 ou plus récent**. Aucune dépendance à installer.

```bash
npm start
```

Ouvrir http://localhost:3000, puis « Créer mon restaurant ».
Le restaurant est créé avec un menu et 8 tables d'exemple.

## Mettre en ligne

Hébergez le dossier sur un serveur Node 22.5+ (Render, Railway, Fly.io, un VPS…).

- Variable `TRUST_PROXY=1` : à activer derrière un proxy d'hébergeur pour que la limite d'essais de connexion utilise la vraie adresse IP
- Variable `PORT` : port d'écoute (fournie par la plupart des hébergeurs)
- Variable `DB_PATH` : chemin du fichier de base (par défaut `data.db`). **Placez-le sur un disque persistant**, sinon les données sont perdues à chaque redéploiement.
- Utilisez **HTTPS** (indispensable pour installer l'appli et protéger les mots de passe).

## Installer sur Android et Windows

- **Android** (Chrome) : menu ⋮ → « Installer l'application » / « Ajouter à l'écran d'accueil »
- **Windows** (Chrome ou Edge) : icône d'installation dans la barre d'adresse, ou menu → « Installer Resto POS »

## Commande par les clients (QR code)

1. Le gérant ouvre l'onglet **QR codes**, imprime les QR codes et en colle un par table.
   **Ouvrez l'application depuis l'adresse en ligne du restaurant (pas `localhost`) avant d'imprimer** : le QR code contient l'adresse utilisée à ce moment-là.
2. Le client scanne le QR code, voit le menu, compose son panier (avec une précision par plat) et envoie sa commande.
3. Mode réglable dans l'onglet **Menu** :
   - **Le serveur valide chaque commande** (par défaut) : la demande apparaît sur la table (🔔, bip), le serveur l'accepte (elle part en cuisine) ou la refuse. L'encaissement est bloqué tant qu'une demande attend une réponse.
   - **Envoi direct en cuisine** : la commande du client part tout de suite en cuisine.
   - **Désactivée** : les QR codes n'acceptent plus de commande.
4. Le client suit l'état de ses plats (en attente, en cuisine, en préparation, prête…). Il ne voit que ses propres commandes. Le paiement se fait toujours auprès d'un serveur.

Sécurité : chaque table a un jeton secret dans son QR code. Si un QR code est photographié ou partagé par erreur, « Changer » le remplace (l'ancien cesse de fonctionner). Les envois sont limités (10 commandes par 10 minutes par table et par appareil) pour éviter les abus.

## Utilisation

1. Le gérant crée le restaurant, puis configure menu et tables (onglet Menu).
2. Dans « Équipe », il ajoute serveurs et cuisine avec un code PIN, et leur donne le **code du restaurant**.
3. Chaque employé se connecte avec : code du restaurant + nom + PIN.

## Limites actuelles

- Pas de mode hors-ligne pour les commandes (l'interface se charge hors-ligne, mais les données demandent une connexion)
- Impression via la boîte de dialogue du navigateur (pas d'impression automatique silencieuse) ; pas de paiement par terminal intégré (le client ne paie pas depuis son téléphone)
- Les notifications système fonctionnent tant que l'appli reste ouverte (même en arrière-plan) ; elles ne sont pas envoyées si elle est complètement fermée
- Pas de gestion des stocks, des taxes détaillées ni du partage de l'addition

## Structure

- `server.js` : API HTTP + SQLite (intégré à Node) + temps réel, sans dépendance externe
- `public/` : interface (HTML/CSS/JS), manifeste PWA, service worker
