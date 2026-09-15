# SIP Phone

Schlankes SIP-Softphone für Windows als Desktop-App (Electron), entwickelt für Asterisk-Telefonanlagen.

![Icon](assets/icon.png)

## Funktionen

- **Mehrere SIP-Konten gleichzeitig** (z. B. Firma und privat), Anmeldung über UDP mit Digest-Authentifizierung (Passwort oder HA1-Hash). Beim Wählen ist das Konto auswählbar, bei Anrufen, im Verlauf und in Benachrichtigungen steht, über welches Konto es läuft
- **Telefonieren** ein- und ausgehend, Audio mit G.711 (PCMA/PCMU) und optional G.722 (HD-Sprache, Breitband bis 7 kHz), Stummschalten im Gespräch
- **Halten und Weiterleiten**: Gespräch halten (die Anlage spielt der Gegenstelle Wartemusik) und blind weiterleiten (an Nummer oder Kontakt, mit Vorschlägen)
- **Tastentöne (DTMF)** im Gespräch über Tastenfeld oder Tastatur – per RFC 4733 (telephone-event), sonst SIP INFO
- **Getrennte Audiogeräte** für Mikrofon, Gespräch und Klingelton – mit Test-Knöpfen und Mikrofonpegel; die Rausch-/Echounterdrückung fürs Mikrofon ist abschaltbar (falls sie die Stimme metallisch klingen lässt)
- **Eigener Klingelton** (WAV, MP3, OGG, M4A, FLAC)
- **Gesprächsverlauf** mit verpassten Anrufen und Rückruf-Knopf
- **Vorschläge beim Wählen**: Beim Eingeben einer Nummer oder eines Namens gleicht die App mit Telefonbuch und Verlauf ab und bietet passende Treffer zum Direktwählen an
- **Telefonbuch** mit Suche und Anruf per Klick; Import direkt aus dem klassischen Outlook oder als CSV-Export (neues Outlook, Outlook.com). Namen aus dem Telefonbuch erscheinen bei Anrufen, im Verlauf und in Benachrichtigungen
- **Tray-Betrieb**: Minimieren und Schließen legen die App ins Tray, sie bleibt erreichbar
- **Büro und Homeoffice**: Solange der PC gesperrt ist, meldet sich SIP Phone ab (abschaltbar). Meldet sich dasselbe Konto an einem anderen Gerät an, holt die App die Anmeldung nicht zurück – *Übernehmen* in der Statuszeile holt sie wieder her
- **Windows-Benachrichtigungen** bei eingehenden Anrufen mit *Annehmen*/*Ablehnen* und bei verpassten Anrufen; ob das Fenster bei einem Anruf zusätzlich in den Vordergrund kommt, ist einstellbar
- **Nachgemeldete Gegenstelle**: zeigt bei Click-to-Dial oder Weiterleitungen, mit wem man tatsächlich spricht
- **Konten verwalten** in der App (hinzufügen, bearbeiten, löschen)

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
| `src/config.js`, `src/history.js` | Einstellungen und Gesprächsverlauf |
| `public/` | Oberfläche; `audio-worklet.js` setzt Browser-Audio auf 8-kHz-Telefonaudio um |

## Updates

Die installierte App prüft beim Start und alle 4 Stunden, ob es auf GitHub ein neueres [Release](https://github.com/mraudev/sipphone/releases) gibt, und lädt es im Hintergrund. Danach erscheint *Update bereit – Neu starten* (nie während eines Gesprächs) samt aufklappbarer Beschreibung des Releases (*Was ist neu?*); ohne Klick wird das Update beim nächsten Beenden installiert. Die Portable-exe aktualisiert sich nicht selbst.

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
- `sipphone.log` – Protokoll für die Fehlersuche (ohne Zugangsdaten und Gesprächsinhalte). Am Gesprächsende steht darin eine RTP-Statistik: gesendete Sprach-/Stillepakete, längste Mikrofonpause und – sofern die Anlage RTCP schickt – was sie über den eigenen Sendestrom meldet (Paketverlust, Jitter). Über *Einstellungen → Protokoll → Anzeigen* im Explorer zu öffnen.

Ist noch kein Konto eingerichtet, erscheint beim Start das Formular *SIP-Konto einrichten*.

> `config.json` enthält Zugangsdaten und darf nicht ins Repository – sie steht in `.gitignore`.

## Hinweise zur Telefonanlage (Asterisk)

- **Gegenstelle bei Click-to-Dial anzeigen:** Asterisk ruft zuerst die eigene Nebenstelle an und meldet das Ziel erst danach nach – das passiert nur, wenn es für die Nebenstelle eingeschaltet ist:
  - chan_sip: `sendrpid=pai` (oder `yes`), optional `rpid_update=yes`
  - PJSIP: `send_pai=yes` (oder `send_rpid=yes`)
  - FreePBX: bei der Nebenstelle *Send RPID* → *Send P-Asserted-Identity header*
- **Eine Nebenstelle auf mehreren PCs (Büro/Homeoffice):** chan_sip merkt sich pro Nebenstelle nur ein angemeldetes Gerät, Anrufe gehen an das zuletzt angemeldete. SIP Phone fragt deshalb vor jeder Erneuerung ab, wer gerade angemeldet ist, und verdrängt ein anderes Gerät nicht („An anderem Gerät“ → *Übernehmen*). Beim Beenden oder Sperren meldet es nur die eigene Anmeldung ab – `Expires: 0` würde bei chan_sip auch die des anderen Geräts löschen.
- **Umlaute in Anrufernamen:** Die App liest Namen in UTF-8 und Windows-1252. Kommt „oe“ statt „ö“ oder ein „?“ an, ist der Name bereits in der Anlage so hinterlegt und muss dort (als UTF-8) korrigiert werden – oder die Nummer steht im Telefonbuch, dessen Name dann Vorrang hat.

## Einschränkungen

- Nur UDP (kein TCP/TLS), keine Verschlüsselung (SRTP)
- G.722 (HD, standardmäßig an) und G.711 (PCMA/PCMU); kann die Gegenstelle kein G.722, wird automatisch auf G.711 zurückgefallen. HD ist in den Einstellungen abschaltbar
- Ein Gespräch gleichzeitig über alle Konten; ein zweiter Anruf wird mit „besetzt“ abgewiesen
- Weiterleiten nur blind (ohne Rückfrage); kein zweites gleichzeitiges Gespräch (Rückfrage-Weiterleitung)
