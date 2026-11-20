<p align="center"><img src="build/icon.png" width="120" alt="ScènePro"></p>

<h1 align="center">ScènePro</h1>
<p align="center"><b>Régie vidéo pour conférences, présentations et événements</b><br>
Prévisualisation / Programme · 3 programmes · sorties HDMI · diffusion en ligne · mixage audio</p>

---

## ⬇️ Télécharger

**[Télécharger la dernière version pour Windows](../../releases/latest)** : prenez le fichier `ScenePro-Setup-x.y.z.exe`, lancez-le, c'est installé.

> Windows peut afficher « Windows a protégé votre ordinateur » (l'application n'est pas encore signée numériquement). Cliquez sur **Informations complémentaires › Exécuter quand même**.

L'application se met à jour toute seule : quand une nouvelle version est publiée ici, ScènePro la télécharge et propose de redémarrer.

## ✨ Fonctions

- **Prévisualisation (vert) / Programme (rouge)** : préparez le média suivant sans toucher à ce qui est à l'antenne. CUT, AUTO (fondu), SUIVANT, NOIR.
- **3 programmes indépendants (PGM 1, 2, 3)** : le PGM 1 est le programme principal avec le son ; les PGM 2 et 3 alimentent d'autres écrans de la salle.
- **Routage** : boutons S1 · S2 · S3 · WEB sous chaque programme pour choisir ce qui part sur chaque sortie.
- **Retour présentateur** : un programme peut suivre le PGM 1 et afficher l'heure, le temps restant et le média suivant.
- **PIP (image dans l'image)** sur chaque programme : caméra de l'orateur sur les diapositives, etc.
- **3 sorties vidéo plein écran** sur les écrans de votre choix (HDMI, carte vidéo, projecteur). Votre bureau reste privé.
- **Programmation par média** : lecture en boucle, son, volume, durée d'affichage des images, action de fin (rester, suivant automatique, noir).
- **Entrées live** : cartes de capture HDMI/SDI, webcams.
- **Table de mixage** : médias, entrées live (son qui suit l'image), micros, cartes son multi-entrées (une tranche par entrée), masters SALLE et WEB avec vumètres et limiteur.
- **Poste Diffusion autonome** (raccourci « ScènePro Diffusion », sur le même ordinateur ou un autre du réseau) : il reçoit le programme du bus WEB de la régie et gère lui-même la diffusion en ligne vers Facebook, YouTube, Instagram, Twitch ou un serveur perso (plusieurs en même temps, reconnexion automatique) et l'enregistrement **REC** en MP4. Interface façon console : ON AIR et REC rouges avec la durée (`00h30m52s`), aperçu, vumètres, statistiques. Il se prépare à l'avance, même régie éteinte, puis se connecte avec l'adresse et le code d'accès de la régie ; la régie affiche son état (EN LIGNE, REC) et peut le piloter.
- **Poste Enregistrement autonome** (raccourci « ScènePro Enregistrement », sur le même ordinateur ou un autre du réseau) : enregistre en même temps chaque bus choisi (PGM 1 avec le son, PGM 2, PGM 3, WEB), un fichier par bus, en MP4 (montage) ou MKV (sans perte). Grand bouton REC, durée, taille, débit, espace disque restant. Il se prépare même régie éteinte ; depuis la régie, bouton REC sur chaque programme et pastille ENR.
- **Télécommandes** : Stream Deck, Bitfocus Companion, claviers macro (adresses web ou raccourcis clavier).
- **Shows** enregistrés et rechargés.

## ⌨️ Raccourcis essentiels

| Touche | Action |
|---|---|
| `Espace` | AUTO (fondu) |
| `Entrée` | CUT |
| `N` | Média suivant |
| `B` | Fondu au noir |
| `F1` `F2` `F3` | Choisir le programme 1, 2 ou 3 |
| `I` | PIP du programme sélectionné |
| `F` `G` `H` | Plein écran des sorties 1, 2, 3 |

## 🛠️ Pour les développeurs

```bash
npm install
npm start          # lance l'application
npm run build      # crée l'installateur dans dist/
```

**Publier une nouvelle version** : changez `version` dans `package.json`, puis poussez une étiquette du même numéro (ex. `v2.0.1`). GitHub Actions construit l'installateur et le met dans les Releases automatiquement.

```bash
git tag v2.0.1
git push origin v2.0.1
```

Composants : Electron, ffmpeg (encodage de la diffusion), ws.
