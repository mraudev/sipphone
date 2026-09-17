# Versionsübersicht

Zusammenfassung der Erweiterungen je Version, neueste zuerst. Die fertigen Installer liegen auf der [Release-Seite](https://github.com/mraudev/sipphone/releases).

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
