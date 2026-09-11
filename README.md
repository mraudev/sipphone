# SIP Phone

Schlankes SIP-Softphone für Windows als Desktop-App (Electron) – gedacht als Ersatz für Linphone an einer Asterisk-Telefonanlage.

![Icon](assets/icon.png)

## Funktionen

- **Registrierung** an einem SIP-Server über UDP mit Digest-Authentifizierung (Passwort oder HA1-Hash)
- **Telefonieren** ein- und ausgehend, Audio mit G.711 (PCMA/PCMU)
- **Getrennte Audiogeräte** für Mikrofon, Gespräch und Klingelton – mit Test-Knöpfen und Mikrofonpegel
- **Eigener Klingelton** (WAV, MP3, OGG, M4A, FLAC)
- **Gesprächsverlauf** mit verpassten Anrufen und Rückruf-Knopf
- **Tray-Betrieb**: Minimieren und Schließen legen die App ins Tray, sie bleibt erreichbar
- **Windows-Benachrichtigungen** bei eingehenden Anrufen mit *Annehmen*/*Ablehnen* und bei verpassten Anrufen
- **Nachgemeldete Gegenstelle**: zeigt bei Click-to-Dial oder Weiterleitungen, mit wem man tatsächlich spricht
- **Konto-Einrichtung** in der App; beim ersten Start werden Konto und Audiogeräte automatisch aus Linphone übernommen

## Installation

Setup bauen (siehe unten) und `dist\SIP Phone Setup <version>.exe` ausführen. Das Setup installiert wahlweise nur für den aktuellen Benutzer (ohne Adminrechte) oder für alle Benutzer.

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
| `src/sip.js` | SIP-Stack (Transaktionen, Registrierung, Anrufe, Digest-Auth) |
| `src/rtp.js`, `src/sdp.js` | RTP mit G.711-Codec, SDP-Aushandlung |
| `src/config.js`, `src/history.js` | Einstellungen (inkl. Linphone-Import) und Gesprächsverlauf |
| `public/` | Oberfläche; `audio-worklet.js` setzt Browser-Audio auf 8-kHz-Telefonaudio um |

## Einstellungen und Daten

Alles liegt unter `%APPDATA%\SIP Phone\`:

- `config.json` – Konto, Audiogeräte, Klingelton. Das Passwort wird nur verschlüsselt gespeichert (Windows DPAPI).
- `history.json` – Gesprächsverlauf (die letzten 200 Gespräche)
- `ringtone.*` – Kopie des eigenen Klingeltons

Gibt es noch keine `config.json`, sucht die App nach `%LOCALAPPDATA%\linphone\linphonerc` und übernimmt Konto und Audiogeräte. Ohne Linphone erscheint das Formular *SIP-Konto einrichten*.

> Linphone-Konfigurationen (`linphonerc`, `settings_lp`) und `config.json` enthalten Zugangsdaten und dürfen nicht ins Repository – sie stehen in `.gitignore`.

## Hinweise zur Telefonanlage (Asterisk)

- **Gegenstelle bei Click-to-Dial anzeigen:** Asterisk ruft zuerst die eigene Nebenstelle an und meldet das Ziel erst danach nach – das passiert nur, wenn es für die Nebenstelle eingeschaltet ist:
  - chan_sip: `sendrpid=pai` (oder `yes`), optional `rpid_update=yes`
  - PJSIP: `send_pai=yes` (oder `send_rpid=yes`)
  - FreePBX: bei der Nebenstelle *Send RPID* → *Send P-Asserted-Identity header*
- **Umlaute in Anrufernamen:** Die App liest Namen in UTF-8 und Windows-1252. Kommt „oe“ statt „ö“ oder ein „?“ an, ist der Name bereits in der Anlage so hinterlegt und muss dort (als UTF-8) korrigiert werden.

## Einschränkungen

- Nur UDP (kein TCP/TLS), keine Verschlüsselung (SRTP)
- Nur G.711 (PCMA/PCMU)
- Ein Gespräch gleichzeitig; ein zweiter Anruf wird mit „besetzt“ abgewiesen
- Noch keine Tastentöne im Gespräch (DTMF), kein Halten, Stummschalten oder Weiterleiten
