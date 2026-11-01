# da_orbit

Ein Granular-, Micro-Loop-, Glitch- und Multidelay-Effekt mit Hold-Sampler und 60-Sekunden-Looper, komplett im Browser (Web Audio API + AudioWorklet, keine Abhängigkeiten, kein Build-Schritt).

Die Funktionen orientieren sich am **Microcosm von Hologram Electronics** (11 Effekte × 4 Varianten, acht Makro-Regler mit Shift-Ebene, Tap/Bypass/Hold, Phrase-Looper, 16 User-Presets, MIDI). Design, Code und Algorithmen sind eigenständig; es wird weder Firmware noch Markenzeichen des Originals verwendet. da_orbit steht in keiner Verbindung zu Hologram Electronics.

## Starten

AudioWorklets brauchen einen lokalen Webserver (eine per Doppelklick geöffnete `index.html` funktioniert nicht).

```bash
node server.mjs          # oder: npm start
# dann http://localhost:8080 öffnen
```

Alternativ: `python3 -m http.server 8080`. Getestet mit Chromium; Firefox und Safari unterstützen AudioWorklet ebenfalls.

Beim Start wählst du eine Quelle: eingebaute Demo (Zupf-Arpeggio, E-Piano, Beat), einen Audio-Eingang (Interface, USB-Gerät, Mikrofon) oder eine Audiodatei (auch per Drag & Drop). Mit Mikrofon bitte Kopfhörer verwenden.

## Eingänge: Audio-Interface, Syntakt & Co.

Quelle **Audio-Eingang** wählen; der Browser fragt einmal nach der Freigabe. Danach erscheint über dem Gerät die Eingangsleiste:

* **Gerät**: alle Audio-Eingänge des Systems, z. B. Audio-Interface, Syntakt/Digitakt per USB, eingebautes Mikrofon. Die Liste aktualisiert sich beim An- und Abstecken (↻ liest sie manuell neu ein).
* **Kanäle**: Stereo-Paare (1+2, 3+4 …) oder einzelne Mono-Kanäle. Eine Gitarre an Eingang 1 eines Interfaces also als „1 Mono“ wählen, den Syntakt-Hauptausgang als „1+2 Stereo-Paar“.
* **Verarbeitung**: Stereo oder Mono-Summe (dieselbe Einstellung wie „Eingangsmodus“ in den Einstellungen).
* Gerät und Kanalwahl werden gespeichert. Wird das Gerät getrennt, verbindet da_orbit es beim Wiedereinstecken automatisch.

Wie viele Kanäle eines Mehrkanal-Interfaces im Browser ankommen, entscheiden Browser und Treiber; oft sind es nur die ersten zwei. da_orbit fordert bis zu 32 Kanäle an und zeigt an, wie viele tatsächlich freigegeben wurden.

**Syntakt, Digitakt & Co.**

* **Per USB**: Läuft das Gerät im USB-Audio- oder Overbridge-Modus, erscheint es als eigenes Eingangsgerät; der Hauptausgang liegt auf 1+2. Overbridge stellt die Einzelspuren als weitere Kanäle bereit, sie sind aber nur wählbar, wenn der Browser mehr als zwei Kanäle durchreicht.
* **Analog**: Ausgänge ins Audio-Interface, dort das passende Eingangspaar wählen. Das ist auch der Weg, einzelne Spuren zuverlässig zu nutzen.
* **Tempo**: In da_orbit **MIDI** aktivieren und am Gerät das Senden der Clock einschalten (bei Elektron „Clock Send“). da_orbit folgt der Clock auch ohne Start-Befehl; ein Start setzt den Takt auf die Eins. Ohne Clock übernimmt nach etwa 1,5 s wieder das interne Tempo.

Echo-Unterdrückung, Rauschfilter und automatische Pegelanpassung des Browsers sind abgeschaltet. Für geringe Latenz am Interface eine kleine Puffergröße einstellen; die Leiste zeigt die geschätzte Latenz.

## Bedienung

| Element | Funktion | Shift-Funktion |
|---|---|---|
| Aktivität | Makro für Dichte bzw. Komplexität (je Effekt) | Hallzeit (Zusatz, beim Original nur per MIDI) |
| Wiederholung | Dauer/Häufigkeit: Ausklingen, Feedback, Glitch-Rate | Mod-Tiefe |
| Form | Hüllkurve: rückwärts → schwellend → weich → Gate → perkussiv; bei GLIDE Glide-Kurve, bei PATTERN/WARP Tap-Lautstärkekurve | Mod-Rate |
| Zeit | Teilung ¼× ½× TAP 2× 4× 8× oder (Tempo-Modus) 40–240 BPM | Loop-Tempo ¼×–4× |
| Filter | Resonanz-Tiefpass am Ende der Effektkette, ganz links = Effekt stumm | Resonanz |
| Mix | Dry/Wet, in der Mitte beide voll | Effektlautstärke |
| Raum | Hall + Ping-Pong-Delay, ganz rechts 100 % nass | Hall-Typ (heller Raum, dunkel/mittel, große Halle, Ambient) |
| Loop-Pegel | Lautstärke des Loopers | Fade-Zeit |

Fußschalter: **Links** Tap-Tempo bzw. im Looper-Modus Rec → Play → Dub (lang: Overdub rückgängig/wiederherstellen). **Mitte** Bypass. **Rechts** Hold (friert das zuletzt Gespielte in Länge der Teilung ein und speist es weiter in den Effekt) bzw. im Looper-Modus Stopp (lang: Löschen).

Effektring: Klick auf Effekt oder Variante (A–D), Mausrad blättert durch alle 44. Die Mitte schaltet den Effekt rückwärts (REV).

Tastatur: `Q` `W` `E` Fußschalter (halten = lang drücken), `L` Looper, `R` Loop rückwärts, `V` Effekt rückwärts, `T` Zeit-Modus, Pfeiltasten Effekt/Variante, `1`–`4` Variante, `Shift` halten = Shift-Ebene.

## Effekte

| Kategorie | Effekt | Kernidee | A / B / C / D |
|---|---|---|---|
| Micro-Loop | MOSAIC | überlappende Loops in mehreren Geschwindigkeiten | 1×+2× / 1×+½× / 2× / ½×,1×,2×,4× |
| | SEQ | Schnipsel zu neuen Rhythmen umsortiert | Zufallsfilter / Bounce normal-halb (+Pad) / Ebenen mit Filter-Sweeps / Euklid-Rhythmen mit Bitcrusher (+Sub) |
| | GLIDE | Loops gleiten in der Tonhöhe | ½→1 / 2→½ / 1→2 / beide Richtungen |
| Granular | HAZE | Grain-Wolken | gedehnt diffus / zufällig inkl. rückwärts / mit 2× / mit ½× |
| | TUNNEL | zyklische Micro-Loops als Drone | Länge moduliert / Sub-Oktave + Filter-LFO / resonante Bandpässe / hüllkurvengesteuert |
| Glitch | STRUM | Ketten aus den letzten Anschlägen | letzter Ton / phasende Kopien / Kaskaden / Kaskaden + 2× |
| | BLOCKS | Glitches und Ton-Bursts, ausgelöst vom Eingang | Umsortieren + Bursts / mit Pitch / gefiltert-sanft / Pitch + Bitcrusher |
| | INTERRUPT | Glitches unterbrechen das Dry-Signal (Ducking) | CD-Sprung-Stotter / Pitch / Filter-Sweep + Echos / Bitcrusher |
| | ARP | letzte Töne als Arpeggio (nach erkannter Tonhöhe sortiert) | einfach / Pitch-Muster / Zufallsfilter / Bitcrush + Sub-Oktave |
| Multidelay | PATTERN | Delay-Taps in Mustern | linear / punktiert / triolisch / geclustert |
| | WARP | Taps mit Filtern und Pitch | Hüllkurvenfilter / Bandpässe / Pitch-Shift / Crossfade mit 2×-Grains |

## Looper

60 s Stereo, Post-FX (Standard) oder Pre-FX, Overdub mit Undo/Redo, Stopp mit Ausblenden, Rückwärts, Tempo ¼×–4× (Shift + Zeit), Quantisieren auf Schläge, „Nur Looper“ (Effekte stumm, Mod/Filter/Raum bleiben), Burst (nimmt nur auf, solange der Schalter gehalten wird), Reihenfolge Rec→Play→Dub oder Rec→Dub→Play. Loops lassen sich als WAV exportieren und aus Audiodateien laden.

## Presets, Einstellungen, MIDI

* 16 User-Presets in 4 Farbbänken. Gespeichert werden alle Regler, Optionen und der aktuelle Loop (Loop-Audio in IndexedDB, Rest in localStorage). Export/Import der Reglerstellungen als JSON.
* Globale Einstellungen: Mono/Stereo-Eingang, Instrument/Line, Hold umschaltend/momentan, Bypass-Art (ohne Trails, mit Trails, hart), Looper-Reihenfolge und -Fade, Vorschlagswerte beim Effektwechsel, MIDI-Kanal, MIDI-Clock, Expression-Pedal per MIDI-CC.
* Web-MIDI: Programmwechsel 1–44 (Reihenfolge des Originals) und 45–60 für User-Presets, die CC-Belegung des Originals (CC 5–35, 47, 48, 93, 102), MIDI-Clock (auch ohne Start-Befehl, Start setzt die Eins).
* Aufnahme des Ausgangs als WebM/Opus.

## Tests

```bash
node tests/dsp-test.mjs       # alle 44 Algorithmen, Looper, Quantisierung, Hold, Bypass offline in Node
node tests/browser-test.mjs   # Chromium via Playwright: UI, Effekte, Hold, Looper, Presets, Audio-Eingang mit Kanalwahl, Mobil-Layout
```

## Aufbau

```
index.html             Oberfläche
css/style.css          Gestaltung (hell/dunkel, responsiv)
js/orbit-processor.js  DSP-Kern als AudioWorkletProcessor (Verlaufspuffer, Stimmen, Taps, Hold, Looper, Filter, Hall)
js/engine.js           AudioContext, Quellen, Aufnahme, WAV-Export
js/main.js             App-Logik
js/data.js             Effekte, Regler, MIDI-Belegung
js/ui/*.js             Regler, Effektring, Visualisierung
js/presets.js          Presets (localStorage + IndexedDB)
js/midi.js             Web-MIDI
js/demo.js             synthetisierte Demo-Klänge
```

## Bekannte Unterschiede zum Original

* Die Algorithmen sind Nachbildungen nach Handbuch und Testberichten, keine Kopien; Klangcharakter und genaue Reglerkurven weichen ab.
* Onset- und Tonhöhenerkennung (STRUM, ARP, BLOCKS) sind einfach gehalten; bei stark verzerrten Signalen triggern sie unzuverlässig (wie beim Original).
* Kein echtes True-Bypass (im Browser gibt es keine Relais); „hart“ schaltet ohne Trails.
* Expression-Pedal nur über MIDI-CC; MIDI-Clock wird empfangen, aber nicht gesendet.
* Die Latenz hängt von Browser und Audio-Interface ab.
