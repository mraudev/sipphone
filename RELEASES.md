# Versionsübersicht

Zusammenfassung der Erweiterungen je Version, neueste zuerst. Die fertigen Installer liegen auf der [Release-Seite](https://github.com/mraudev/sipphone/releases).

## 1.23.0
- **Auflege-Ton:** Endet ein verbundenes Gespräch – egal ob die Gegenstelle oder du auflegst –, kommt im Headset (Gesprächsgerät) ein kurzer Ton aus drei absteigenden Tönen. Bei verpassten oder abgelehnten Anrufen ertönt er nicht.

## 1.22.2
- **Headset-Mikrofon mit Jabra-Softphone-Integration:** Die App meldet dem Headset des Gesprächs-Geräts jetzt immer „im Gespräch“ (Off-Hook) – unabhängig von der Option zur Rufannahme per Knopf. Der Jabra Link 390 gibt mit eingeschalteter Softphone-Integration das Mikrofon erst dann frei; vorher hörte die Gegenstelle nichts. Klingeln am Headset und Annehmen per Knopf bleiben optional.
- Bei Gesprächs-Gerät „Systemstandard“ wird das tatsächliche Windows-Standardgerät erkannt (vorher wurde das erste Gerät der Liste angenommen).

## 1.22.1
- **Einstellungen optisch überarbeitet:** schmaler, abgerundeter Scrollbalken passend zum Design (hell und dunkel, ohne Pfeile); die Headset-Zeile ist am Text der Option ausgerichtet, mit Statuspunkt und kleinem „Verbinden …“-Knopf; die Konten erscheinen als Liste mit Trennlinien und „+ Konto hinzufügen“ als letzte Zeile, passend dazu die Box unter „Allgemein“.

## 1.22.0
- **Klingelton auswählbar:** Neben dem Standard-Dreiklang stehen zehn weitere eingebaute Töne zur Wahl – fünf einfache (Marimba, Kristall, Sanfter Puls, Harfe, Morgen) und fünf mehrstimmige (Sonnenaufgang, Glockenspiel mit Echo, Lounge, Arcade, Kino). Eine eigene Datei geht weiterhin. Beim Auswählen wird der Ton einmal vorgespielt.
- **Einstellungen in Reitern:** Audio, Anrufe, Konten und Allgemein statt einer langen Liste; ein Klick auf die Statuszeile öffnet direkt die Konten. Die Knopfleiste bleibt immer sichtbar.
- Hinweistext zur Headset-Rufannahme korrigiert (Rufannahme-Knopf statt Mute-Knopf, Hinweis auf die Jabra-Softphone-Integration).

## 1.21.1
- **Protokoll aufgeräumt:** Die Diagnose-Einträge zur Headset-Anbindung (jeder Tastendruck, Gerätelisten) sind wieder entfernt; es werden nur noch echte Fehler protokolliert.

## 1.21.0
- **Linux-Version:** Neben Windows gibt es jetzt ein **AppImage** (ohne Installation, aktualisiert sich selbst) und ein **Debian/Ubuntu-Paket** (`.deb`). Unter Linux entfallen der Outlook-Import und das Abmelden bei gesperrtem Bildschirm; Details in der README.

## 1.20.7
- **Fehlerbehebungen aus einem Code-Review:**
  - Ein kaputtes/ungültiges RTP-Paket bricht die Audioverarbeitung nicht mehr ab, sondern wird verworfen.
  - Beim Beenden während einer Rückfrage werden jetzt **beide** Gespräche sauber mit BYE beendet (vorher blieb die Rückfrage offen).
  - Die ACK-Wiederholung wird je Gespräch getrennt gespeichert – zwei gleichzeitige Gespräche stören sich nicht mehr (verhindert seltene Abbrüche bei Paketverlust).
  - CSV-Export: Bezeichnungen wie „Haupt“ gehen beim Wiederimport nicht mehr verloren (Spaltennamen sind jetzt import-kompatibel).

## 1.20.6
- **Headset-Annahme auch ohne aktive Softphone-Integration:** Sendet das Headset den Anruf-Knopf im Ruhezustand als Medientaste (statt als Hook Switch), nimmt die App beim Klingeln trotzdem an. Der Standard-Weg (Hook Switch/Ring) bleibt zusätzlich aktiv.

## 1.20.5
- **Headset-Annahme über die Standard-Anrufsteuerung:** Beim Klingeln signalisiert die App dem Headset den Anruf (Ring), der **Rufannahme-/Gesprächsknopf** nimmt an, im Gespräch legt er auf (Ring-/Hook-Handshake, HID-LED-Page). Zuverlässiger als der Mikrofonarm, der beim Klingeln nicht auswertbar war.

## 1.20.4
- **Headset-Annahme erkennt den Jabra-Mikrofonarm:** Das Runterklappen meldet das Jabra über seinen eigenen HID-Report (nicht den Standard-Mute-Report). Die App wertet diesen jetzt aus und nimmt beim Runterklappen (Arm oben→unten) an; andere Headset-Meldungen (Akku/Status) werden ignoriert.

## 1.20.3
- **Headset-Annahme nur noch beim Unmute:** Bisher nahm das Headset den Anruf sofort beim Klingeln an (es wertete jeden Headset-Report aus). Jetzt wird gezielt der „Phone Mute“-Zustand gelesen und nur beim **Unmute** (Mikrofonarm runterklappen, 1→0) angenommen.

## 1.20.2
- **Richtiges Headset für die Rufannahme:** Bei mehreren angeschlossenen Jabras wird jetzt das HID-Gerät genutzt, das zum eingestellten Gesprächs-Gerät passt (gleiche USB-Kennung), statt einfach das erste Jabra. Wechselt automatisch mit, wenn das Gesprächs-Gerät geändert wird.

## 1.20.1
- **Headset-Rufannahme robuster:** Die Geräteauswahl findet jetzt auch den Jabra-Dongle (Filter auf die Jabra-Hersteller-ID erweitert), mit Rückmeldung beim Verbinden. Zusätzliche Diagnose im Protokoll für Rufannahme und „Klingeln im Headset“ (welche Geräte genutzt werden).

## 1.20.0
- **Anruf per Headset-Knopf annehmen (Jabra):** neue Option – während es klingelt, nimmt ein Druck auf den Mute-Knopf des Headsets den Anruf an. Über WebHID-Anrufsteuerung; einmalig „Headset verbinden“ in den Einstellungen.

## 1.19.0
- **Kurzwahl blättert:** der Reiter „Kurzwahl" nutzt jetzt Seiten (wie Verlauf und Telefonbuch) statt eines Scrollbalkens.
- **Klingeln zusätzlich im Headset:** neue Option, bei der der Klingelton bei einem Anruf gleichzeitig auf dem Klingel-Gerät und dem Gesprächsgerät (Headset) kommt.

## 1.18.0
- **Kontakt auf Kurzwahl legen:** im Telefonbuch je Rufnummer ein Stern-Knopf, der die Nummer auf die Kurzwahl legt (und wieder entfernt).

## 1.17.0
- **Kurzwahl mit Besetztlampenfeld (BLF):** neuer Reiter „Kurzwahl" mit häufigen Nebenstellen/Nummern zum Wählen per Klick. Ein Statuspunkt zeigt *frei/klingelt/besetzt* (über SUBSCRIBE/NOTIFY `dialog-info`), sofern die Anlage den Status liefert (Hints/`allowsubscribe`).

## 1.16.0
- **„Neu verbinden"-Knopf** oben rechts (Aktualisieren-Symbol): baut die SIP-Registrierung jederzeit von Hand neu auf.

## 1.15.0
- **Kontakt aus dem Verlauf übernehmen:** unbekannte Anrufer lassen sich im Verlauf mit einem Klick als Kontakt anlegen (Dialog vorbelegt mit Name und Nummer).
- **CSV-Export des Telefonbuchs:** das gesamte Telefonbuch als CSV speichern (UTF-8, für Excel und zur Sicherung, in Outlook und der App wieder importierbar).

## 1.14.0
- **Konto-Import aus PhonerLite:** beim Einrichten ein Konto aus einer `sipper.ini` übernehmen (alle Felder außer dem dort verschlüsselten Passwort).

## 1.13.0
- **Heller und dunkler Modus** (Einstellung „Darstellung"), standardmäßig nach Systemvorgabe.

## 1.12.1
- Einstellungs-Text „HD-Sprache" auf **Opus/G.722** aktualisiert.

## 1.12.0
- **Freisprech-Profil** mit eigenem Mikrofon und Lautsprecher, im Gespräch per Knopf umschaltbar, samt dauerhaftem **Lautstärkeregler**.

## 1.11.0
- **Opus-Codec** (HD, Fullband, robust gegen Paketverluste) als bevorzugter Codec mit automatischem Rückfall auf G.722/G.711.

## 1.10.0
- **Audiogerät während des Gesprächs wechseln** (z. B. vom Headset auf Laptop-Lautsprecher, wenn jemand dazukommt) – ohne Qualitätsverlust.

## 1.9.0
- **Weiterleiten mit Rückfrage:** erst mit dem Ziel sprechen, dann verbinden.

## 1.8.0
- **Halten und Weiterleiten:** Gespräch halten (Anlage spielt Wartemusik) und blind an Nummer oder Kontakt weiterleiten.

## 1.7.1
- **HD-Sprache (G.722) standardmäßig an.**

## 1.7.0
- **Wähl-Vorschläge:** beim Eingeben einer Nummer oder eines Namens Abgleich mit Telefonbuch und Verlauf mit Direktwahl-Vorschlägen.

## 1.6.0
- **HD-Sprache G.722** (Breitband), zunächst abschaltbar im Testbetrieb.

## 1.5.3
- **Mikrofon-Aufbereitung (Rausch-/Echounterdrückung) abschaltbar.**

## 1.5.2
- **RTCP-Diagnose** verbessert, Jitter-Berechnung korrigiert.

## 1.5.1
- **Installer als Ein-Klick nur für den aktuellen Benutzer** – Updates ohne Admin-Abfrage.

## 1.5.0
- **Protokoll für die Fehlersuche** (mit RTP-Statistik am Gesprächsende), **RTCP-Auswertung** und **Release-Notes beim Update** („Was ist neu?").

## 1.4.2
- **Bessere Sprachqualität** beim Gegenüber.

## 1.4.1
- Annehmen über die Windows-Meldung holt das Fenster nicht mehr in den Vordergrund.

## 1.4.0
- Option **„Fenster bei Anruf in den Vordergrund holen"**; README bereinigt.

## 1.3.0
- **Büro/Homeoffice:** Abmelden bei gesperrtem PC, Anmeldung an einem anderen Gerät wird erkannt („Übernehmen").

## 1.2.0
- **Mehrere SIP-Konten gleichzeitig.**

## 1.1.3
- **Sicherheit:** Verbindungen nur zum eigenen Server, geschützter Sprachstrom, HA1 verschlüsselt gespeichert.

## 1.1.2
- **Blättern statt Scrollen** in Verlauf und Telefonbuch.

## 1.1.1
- Keine äußere Scrollleiste bei langen Listen.

## 1.1.0
- **Telefonbuch** mit **Outlook- und CSV-Import.**

## 1.0.1
- Release-Workflow: genau ein Release pro Tag.

## 1.0.0
- **Tastentöne (DTMF)** im Gespräch über Tastenfeld oder Tastatur.

## 0.2.0
- **Auto-Update** über GitHub Releases.

## 0.1.0
- Erste Version: SIP-Softphone als Electron-Desktop-App, ein- und ausgehende Gespräche, Stummschalten.
