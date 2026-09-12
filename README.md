# SIP Phone

Schlankes SIP-Softphone für Windows als Desktop-App (Electron) – gedacht als Ersatz für Linphone an einer Asterisk-Telefonanlage.

![Icon](assets/icon.png)

## Funktionen

- **Mehrere SIP-Konten gleichzeitig** (z. B. Firmen-Telefonanlage und FRITZ!Box daheim), Anmeldung über UDP mit Digest-Authentifizierung (Passwort oder HA1-Hash). Beim Wählen ist das Konto auswählbar, bei Anrufen, im Verlauf und in Benachrichtigungen steht, über welches Konto es läuft
- **Telefonieren** ein- und ausgehend, Audio mit G.711 (PCMA/PCMU), Stummschalten im Gespräch
- **Tastentöne (DTMF)** im Gespräch über Tastenfeld oder Tastatur – per RFC 4733 (telephone-event), sonst SIP INFO
- **Getrennte Audiogeräte** für Mikrofon, Gespräch und Klingelton – mit Test-Knöpfen und Mikrofonpegel
- **Eigener Klingelton** (WAV, MP3, OGG, M4A, FLAC)
- **Gesprächsverlauf** mit verpassten Anrufen und Rückruf-Knopf
- **Telefonbuch** mit Suche und Anruf per Klick; Import direkt aus dem klassischen Outlook oder als CSV-Export (neues Outlook, Outlook.com). Namen aus dem Telefonbuch erscheinen bei Anrufen, im Verlauf und in Benachrichtigungen
- **Tray-Betrieb**: Minimieren und Schließen legen die App ins Tray, sie bleibt erreichbar
- **Windows-Benachrichtigungen** bei eingehenden Anrufen mit *Annehmen*/*Ablehnen* und bei verpassten Anrufen
- **Nachgemeldete Gegenstelle**: zeigt bei Click-to-Dial oder Weiterleitungen, mit wem man tatsächlich spricht
- **Konten verwalten** in der App (hinzufügen, bearbeiten, löschen); beim ersten Start werden Konto und Audiogeräte automatisch aus Linphone übernommen

## Installation

`SIP-Phone-Setup-<version>.exe` von der [Release-Seite](https://github.com/mraudev/sipphone/releases) laden (oder selbst bauen, siehe unten) und ausführen. Das Setup installiert wahlweise nur für den aktuellen Benutzer (ohne Adminrechte) oder für alle Benutzer.

Beim ersten Start:

- **SmartScreen** warnt, weil die exe nicht signiert ist → *Weitere Informationen* → *Trotzdem ausführen*.
- **Windows-Firewall** fragt nach Netzwerkzugriff → zulassen, sonst kommen keine eingehenden Anrufe an.

## Entwicklung

Voraussetzung: Node.js 22 oder neuer.

```bash
npm install
npm start          # App im Entwicklungsmodus starten
npm run dist       # Setup und Portable-exe nach dist/ bauen
npm run icon       # assets/icon.png und icon.ico aus assets/icon.svg erzeugen
```

SIP-Mitschnitt zur Fehlersuche (PowerShell):

```powershell
$env:SIP_TRACE='1'; npm start
```

### Aufbau

| Datei | Aufgabe |
|---|---|
| `src/main.js` | Electron-Hauptprozess: Fenster, Tray, Benachrichtigungen, IPC |
| `src/phone.js` | Mehrere Konten: je Konto eine SIP-Verbindung, höchstens ein Gespräch gleichzeitig |
| `src/sip.js` | SIP-Stack eines Kontos (Transaktionen, Registrierung, Anrufe, Digest-Auth) |
| `src/rtp.js`, `src/sdp.js` | RTP mit G.711-Codec, SDP-Aushandlung |
| `src/config.js`, `src/history.js` | Einstellungen (inkl. Linphone-Import) und Gesprächsverlauf |
| `public/` | Oberfläche; `audio-worklet.js` setzt Browser-Audio auf 8-kHz-Telefonaudio um |

## Updates

Die installierte App prüft beim Start und alle 4 Stunden, ob es auf GitHub ein neueres [Release](https://github.com/mraudev/sipphone/releases) gibt, und lädt es im Hintergrund. Danach erscheint *Update bereit – Neu starten* (nie während eines Gesprächs); ohne Klick wird das Update beim nächsten Beenden installiert. Die Portable-exe aktualisiert sich nicht selbst.

Neue Version veröffentlichen:

```bash
npm version 0.3.0          # Version in package.json erhöhen, Commit + Tag v0.3.0
git push --follow-tags     # GitHub Actions baut und veröffentlicht das Release
```

## Einstellungen und Daten

Alles liegt unter `%APPDATA%\SIP Phone\`:

- `config.json` – Konten, Audiogeräte, Klingelton. Passwörter und HA1-Hashes werden nur verschlüsselt gespeichert (Windows DPAPI).
- `history.json` – Gesprächsverlauf (die letzten 200 Gespräche)
- `contacts.json` – Telefonbuch
- `ringtone.*` – Kopie des eigenen Klingeltons

Gibt es noch keine `config.json`, sucht die App nach `%LOCALAPPDATA%\linphone\linphonerc` und übernimmt Konto und Audiogeräte. Ohne Linphone erscheint das Formular *SIP-Konto einrichten*.

> Linphone-Konfigurationen (`linphonerc`, `settings_lp`) und `config.json` enthalten Zugangsdaten und dürfen nicht ins Repository – sie stehen in `.gitignore`.

## FRITZ!Box als (zusätzliches) Konto

Die FRITZ!Box verwaltet die Rufnummern des Internetanschlusses (z. B. Vodafone DSL); SIP Phone meldet sich bei ihr als IP-Telefon an:

1. FRITZ!Box: *Telefonie → Telefoniegeräte → Neues Gerät einrichten → Telefon (mit und ohne Anrufbeantworter) → LAN/WLAN (IP-Telefon)*, Benutzername und Kennwort vergeben, ausgehende Rufnummer und die Rufnummern wählen, auf die es klingeln soll.
2. SIP Phone: *Einstellungen → + Konto hinzufügen*, Bezeichnung z. B. „Privat“, Benutzername und Kennwort aus der FRITZ!Box, Server `fritz.box`.

## Hinweise zur Telefonanlage (Asterisk)

- **Gegenstelle bei Click-to-Dial anzeigen:** Asterisk ruft zuerst die eigene Nebenstelle an und meldet das Ziel erst danach nach – das passiert nur, wenn es für die Nebenstelle eingeschaltet ist:
  - chan_sip: `sendrpid=pai` (oder `yes`), optional `rpid_update=yes`
  - PJSIP: `send_pai=yes` (oder `send_rpid=yes`)
  - FreePBX: bei der Nebenstelle *Send RPID* → *Send P-Asserted-Identity header*
- **Umlaute in Anrufernamen:** Die App liest Namen in UTF-8 und Windows-1252. Kommt „oe“ statt „ö“ oder ein „?“ an, ist der Name bereits in der Anlage so hinterlegt und muss dort (als UTF-8) korrigiert werden – oder die Nummer steht im Telefonbuch, dessen Name dann Vorrang hat.

## Einschränkungen

- Nur UDP (kein TCP/TLS), keine Verschlüsselung (SRTP)
- Nur G.711 (PCMA/PCMU)
- Ein Gespräch gleichzeitig über alle Konten; ein zweiter Anruf wird mit „besetzt“ abgewiesen
- Kein Halten oder Weiterleiten
