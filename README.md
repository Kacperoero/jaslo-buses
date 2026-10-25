# JakDojadę Jasło (autobusy)

Webowa aplikacja z mapą komunikacji MKS Jasło. Pokazuje przystanki na mapie, najbliższe odjazdy z wybranego przystanku i wyszukuje połączenia z punktu A do punktu B (bezpośrednie i z jedną przesiadką).

Dane pochodzą z **oficjalnego rozkładu jazdy MKS Jasło w formacie GTFS** ([mksjaslo.pl → Strefa pasażera → GTFS](https://www.mksjaslo.pl/strefa-pasazera/gtfs)). Skrypt zamienia go na pliki aplikacji, a wszystko (odjazdy, planer) liczy się w przeglądarce – aplikacja nie odpytuje żadnych serwerów z danymi o autobusach. Nie ma też danych na żywo: wszystkie godziny są planowe.

## Funkcje

- **Mapa przystanków** – Leaflet + kafelki OpenStreetMap, wyśrodkowana na Jaśle; 554 przystanki z GTFS.
- **Odjazdy z przystanku** – kliknięcie przystanku otwiera okienko z najbliższymi odjazdami w ciągu 3 godzin (linia, kierunek, za ile minut / godzina).
- **Wyszukiwarka przystanków** – pole w lewym górnym rogu, po wybraniu mapa przelatuje do przystanku.
- **Wybór daty i godziny** – przycisk „🕒 Teraz” pod wyszukiwarką i sekcja „Kiedy” w planerze. „Inny termin” przełącza okienka i planer na wybrany dzień i godzinę (do końca ważności rozkładu).
- **Ulubione i ostatnie** – gwiazdka ☆ w okienku przystanku (ulubione mają na mapie żółtą kropkę). Po kliknięciu w puste pole wyszukiwarki widać ulubione i ostatnio oglądane przystanki. W planerze puste pola A/B podpowiadają ulubione, a pod formularzem jest lista ostatnich tras. Dane są w przeglądarce (`localStorage`); tras z „Moja lokalizacja” nie zapisujemy.
- **Planer trasy A → B** – punkt startu/celu z listy przystanków, kliknięty na mapie albo z lokalizacji; „Wyjazd o” albo „Na miejscu o”. Do 3 przesiadek, także z przejściem pieszo na inny przystanek. Wybrana trasa jest rysowana na mapie, każdy autobus innym kolorem. Wyszukiwanie trwa kilka–kilkadziesiąt milisekund.
- **Tryb korekty pozycji** – po ustawieniu `devMode = true` w `MapMarkerService` znaczniki można przeciągać, a nowe współrzędne lądują w konsoli.

## Wymagania

- Node.js w wersji obsługiwanej przez Angular 21 (20.19+, 22.12+ lub 24)
- npm 11 (zgodnie z polem `packageManager`)
- Do aktualizacji numerów linii (rzadko): Python 3 i `pdftotext` (pakiet poppler-utils)

## Uruchomienie

```bash
npm install
```

```bash
npm start
```

Aplikacja wystartuje pod `http://localhost:4200/` i przeładuje się sama po każdej zmianie w kodzie.

### Pozostałe komendy

| Komenda | Co robi |
| --- | --- |
| `npm run build` | Build produkcyjny do `dist/autobusy/browser` |
| `npm test` | Testy jednostkowe (Vitest) |
| `npm run gtfs:build -- --download` | Pobiera aktualny GTFS ze strony MKS i przebudowuje dane aplikacji |
| `npm run gtfs:build -- --zip plik.zip` | To samo z lokalnego pliku GTFS |
| `npm run gtfs:shapes` | Przelicza przebiegi autobusów po drogach (z zapisanej sieci dróg OSM; `-- --refresh` pobiera ją od nowa) |

## Wdrożenie produkcyjne

Build to zwykłe statyczne pliki (`dist/autobusy/browser`) – można je wrzucić na dowolny hosting (GitHub Pages, Netlify, nginx…). Nie jest potrzebny żaden serwer ani proxy.

## Dane rozkładowe

### Skąd

MKS publikuje plik GTFS z rozkładem (obecnie `GTFS_1389_20260312125003.zip`, ważny 11.03.2026 – 12.03.2027, przygotowany przez Teroplan S.A. / e-podroznik.pl). Skrypt `scripts/gtfs/build-gtfs.mjs` zamienia go na:

| Plik w `public/assets/data/` | Zawartość |
| --- | --- |
| `gtfs.json` (~86 KB, ~17 KB po kompresji) | przystanki, warianty tras z numerami linii, kursy (godziny), kalendarz kursowania |
| `stops-base.json` | przystanki dla mapy |
| `legacy-stop-ids.json` | stare identyfikatory przystanków (kiedyprzyjedzie) → nowe, do przeniesienia zapisanych ulubionych |
| `shapes.json` (~52 KB) | przebiegi po drogach między kolejnymi przystankami (patrz „Przebiegi po drogach”) |

Pliki są w repozytorium, więc aplikacja działa bez uruchamiania skryptu. Po nowym rozkładzie MKS: `npm run gtfs:build -- --download`, a potem sprawdzić numery linii (niżej).

### Przebiegi po drogach

GTFS od MKS nie ma pliku `shapes.txt`, więc przebieg autobusu po ulicach liczy skrypt `scripts/gtfs/build-shapes.mjs`, raz przy budowaniu danych – aplikacja nie pyta żadnego serwera o trasy:

1. Sieć dróg z OpenStreetMap – jedno zapytanie do Overpass API o drogi przejezdne dla autobusu w obszarze przystanków (+1 km). Wynik (~16 MB) ląduje w `scripts/gtfs/.cache/` (poza gitem) i jest używany przy kolejnych uruchomieniach.
2. **Kierunki przystanku** (`scripts/gtfs/stop-directions.mjs`) – z rozkładu: dla każdego zatrzymania kierunek jazdy (poprzedni → następny przystanek), pogrupowany. Jedna grupa = przystanek jednokierunkowy (autobus staje po jednej stronie drogi), dwie = autobusy stają w obu kierunkach. Ta informacja trafia też do `stops-base.json` (`directions`, a dla jednokierunkowych `towards` – zwykle następny przystanek) i jest widoczna w okienku przystanku.
3. **Punkt na drodze** – dla każdego kierunku przystanek dostaje własny punkt zatrzymania na drodze (do 150 m), na odcinku drogi biegnącym zgodnie z kierunkiem jazdy (różnica do 75°; bliskość i zgodność kierunku są ważone, większe drogi mają lekką przewagę). Dzięki temu linia nie zbacza na chodnik do znacznika przystanku. Punkty są zapisane w `shapes.json` (`roadPoints`); mediana odległości od znacznika przystanku to 6 m.
4. Dla każdej pary kolejnych przystanków, między którymi jeździ autobus (848 par), liczona jest najkrótsza droga od punktu na drodze przy jednym przystanku (dla kierunku jazdy) do punktu przy następnym (A*, z jednokierunkowymi ulicami; drogi serwisowe tylko gdy trzeba). Gdy wychodzi podejrzanie długa (> 3× linia prosta i > 1 km dłużej), zostaje odcinek prosty.
5. Linie są upraszczane (tolerancja 4 m) i zapisywane jako zakodowane polilinie.

Obecnie po drogach idzie 844 z 848 par. Pozostałe są na mapie rysowane **kropkowaną linią prostą** w kolorze autobusu, z dopiskiem „przebieg nieznany” po kliknięciu – żeby nie udawały prawdziwej trasy. Dotyczy to Towarowa III ↔ Floriańska skrz. Żniw (w OSM ul. Żniwna nie łączy się z Towarową; w 2026 r. trwa tam remont, objazd nieznany) oraz Osobnica 4 Imielna ↔ Osobnica Skała 3 (przystanek ponad 150 m od drogi – do sprawdzenia przy poprawianiu położenia przystanków). Raport (`scripts/gtfs/shapes-report.json`) wymienia pary z odcinkiem prostym i przystanki daleko od drogi – przydatne przy poprawianiu położenia przystanków. Po zmianie rozkładu albo poprawkach przystanków: `npm run gtfs:shapes`.

**Licencja:** dane drogowe © współtwórcy OpenStreetMap, licencja [ODbL](https://opendatacommons.org/licenses/odbl/). `shapes.json` jest z nich wyprowadzony – przy publikacji aplikacja musi pokazywać atrybucję OSM (mapa już ją ma) i udostępniać ten plik na tej samej licencji.

### Numery linii

GTFS od MKS **nie zawiera numerów linii** – trasy mają tylko nazwy typu „JASŁO - BIERÓWKA - NIEPLA”, a jedna trasa potrafi obejmować kilka linii. Numery przypisuje narzędzie `scripts/gtfs/assign_lines.py` na podstawie [ogólnego rozkładu jazdy w PDF](https://www.mksjaslo.pl/rozklad-jazdy/ogolny-rozklad-jazdy):

1. **Kierunek i trasa** – `scripts/gtfs/line-rules.json`, spisane ręcznie z kolumn „Kierunek” / „przez” w PDF (np. A: z Rynku do Warzyc przez Bieszczadzką; `never` = miejsca, przez które linia nie jedzie).
2. **Godziny odjazdu** – kursy wariantu szukane w bloku linii w PDF, z uwzględnieniem dni kursowania (D = pon.–pt., C = sob.–nd. itd.).

```bash
python3 -I scripts/gtfs/assign_lines.py GTFS_….zip "Rozklad jazdy ogolny….pdf"
```

Wynik trafia do `scripts/gtfs/line-assignments.json`; błędy poprawia się w `scripts/gtfs/line-overrides.json` (wygrywa z automatem; można zmienić cały wariant albo pojedyncze kursy po godzinie odjazdu). Obecnie numer ma ok. 88% kursów (451 z 515); kursy bez pewnego numeru pokazują „–” i kierunek. Sprawdzone na kilkunastu kursach z porównania z danymi kiedyprzyjedzie – zgodne, ale to heurystyka, więc pojedyncze pomyłki są możliwe.

Ciekawostka: kurs w GTFS to często cały przejazd autobusu przez kilka tras (np. Gądki → Rynek → Warzyce → Rynek), a kiedyprzyjedzie pokazuje go pod jednym numerem linii.

## Struktura projektu

```
src/app/
├── app.ts / app.html                    # Główny komponent – renderuje tylko mapę
├── app.config.ts                        # Providery: router, HttpClient
├── main-map/                            # Widok mapy: Leaflet, znaczniki, przyciski na mapie
├── core/services/
│   ├── gtfs.service.ts                  # Wczytanie gtfs.json, indeks odjazdów i kalendarza
│   ├── timetable.service.ts             # Odjazdy, linie przystanku, przebieg kursu (z GTFS)
│   ├── stops.service.ts                 # Lista przystanków i wyszukiwanie (bez polskich znaków, po słowach)
│   ├── travel-time.service.ts           # Wybrana data/godzina podróży (null = teraz)
│   ├── favorites.service.ts             # Ulubione, ostatnie przystanki i trasy (localStorage)
│   └── geolocation.service.ts           # Lokalizacja użytkownika z przeglądarki
├── features/
│   ├── stop-search/                     # Wyszukiwarka przystanków (lewy górny róg)
│   ├── map/services/
│   │   ├── map-marker.service.ts        # Znaczniki przystanków i okienka z odjazdami
│   │   └── route-layer.service.ts       # Rysowanie punktów A/B i wybranego połączenia
│   └── route-planner/
│       ├── raptor.ts                    # Algorytm RAPTOR (sieć, rundy, odtwarzanie trasy)
│       ├── route-planner.service.ts     # Wyszukiwanie: dojście do przystanków, tryby, wynik
│       ├── planner-state.service.ts     # Stan planera: punkty, wyszukiwanie, wyniki
│       ├── planner-panel/               # Panel boczny planera
│       ├── stop-input/                  # Pole przystanku z podpowiedziami (A / B)
│       ├── connection-card/             # Karta jednego połączenia
│       └── recent-routes/               # Lista ostatnich tras
└── shared/
    ├── components/time-picker/          # Wybór „Teraz / Inny termin”
    ├── models/transit.models.ts         # Typy: Stop, Departure, TripExecutionResponse…
    └── utils/                           # Tekst (polskie znaki, escapowanie), geometria, czas
```

Stan planera trzyma `PlannerStateService`; komponenty panelu tylko go wyświetlają i wywołują jego metody, a `MainMapComponent` na podstawie tego samego stanu rysuje trasę na mapie (`RouteLayerService`). Listy podpowiedzi zamykają się po kliknięciu poza nimi albo klawiszem Esc.

```
scripts/gtfs/
├── build-gtfs.mjs                       # GTFS → public/assets/data (Node, bez zależności)
├── build-shapes.mjs                     # Przebiegi po drogach z OSM → shapes.json
├── assign_lines.py                      # Numery linii z PDF → line-assignments.json
├── line-rules.json                      # Kierunki i trasy linii (z PDF)
├── line-assignments.json                # Wynik assign_lines.py
└── line-overrides.json                  # Ręczne poprawki numerów linii
```

Przy wstawianiu tekstu do okienek Leaflet (`bindPopup`, `setContent`) zawsze używaj `escapeHtml()`. Nazwy przystanków i kierunków porównuj przez `namesMatch()`.

## Jak działa wyszukiwanie połączeń

Planer używa algorytmu **RAPTOR** (Round-bAsed Public Transit Optimized Router, Delling i in.) na lokalnym rozkładzie – `features/route-planner/raptor.ts`, opakowany w `RoutePlannerService`.

1. **Dojście** – wybrany przystanek razem z jego drugim słupkiem (ta sama nazwa, do 400 m), albo przystanki do 1 km od punktu na mapie (maks. 12 najbliższych). Tak samo na końcu trasy.
2. **Rundy** – runda *k* wyznacza najwcześniejsze dotarcie do każdego przystanku *k* autobusami. Między rundami można przejść pieszo na inny przystanek do 500 m (przesiadka z dojściem). Na tym samym przystanku przesiadka wymaga min. 2 minut. Maksymalnie 4 przejazdy (3 przesiadki).
3. **Wiele propozycji** – RAPTOR jest uruchamiany dla kolejnych momentów wyjścia (tak, żeby zdążyć na kolejne odjazdy z przystanków startowych) w oknie 3 godzin. Z wyników zostają te, których nic nie bije jednocześnie godziną wyjścia, przyjazdu i liczbą przesiadek. Maks. 6 propozycji.
4. **Tryby** – „Wyjazd o” sortuje po najwcześniejszym przyjeździe; „Na miejscu o” szuka połączeń przyjeżdżających najpóźniej o podanej godzinie i sortuje od najpóźniejszego wyjścia z domu.
5. **Pieszo** – gdy A i B dzieli do 25 minut marszu, wśród propozycji jest też dojście pieszo.

Dojście liczone jest jako 80 m/min w linii prostej. Kursy po północy są uwzględniane (rozkład z poprzedniego i następnego dnia). Jedno wyszukiwanie trwa zwykle kilka–kilkadziesiąt milisekund.

**Rysowanie trasy na mapie** nie korzysta z żadnego zewnętrznego serwera: przejazd autobusu idzie po drogach między kolejnymi przystankami kursu (z `shapes.json`, kropki na przystankach pośrednich, każdy autobus innym kolorem), a dojście pieszo to przerywana linia prosta.

## Poprawianie pozycji przystanków

1. W `map-marker.service.ts` ustaw `devMode = true`.
2. Przeciągnij znacznik w miejsce, gdzie faktycznie stoi wiata.
3. Skopiuj obiekt JSON z konsoli przeglądarki.
4. Przywróć `devMode = false`.

Uwaga: `npm run gtfs:build` nadpisuje `stops-base.json` i `gtfs.json`, więc poprawek nie wpisuj na razie bezpośrednio do tych plików – patrz „Do zrobienia → 2”.

## Znane ograniczenia

- Brak danych na żywo (opóźnień, pozycji autobusów) – MKS udostępnia je tylko przez płatny system kiedyprzyjedzie, bez publicznego API dla innych. Warstwa „Autobusy na żywo” była zrobiona na tym API i została usunięta; jej kod jest w historii git (commit `b790d54`), gdyby pojawiło się legalne źródło.
- Numery linii są przypisane heurystycznie (patrz „Numery linii”).
- Jedyne zewnętrzne zasoby to kafelki mapy OpenStreetMap i czcionka Google Fonts. Kafelki OSM mają [zasady użycia](https://operations.osmfoundation.org/policies/tiles/) – przy publikacji z większym ruchem warto przejść na własnego lub płatnego dostawcę kafelków.
- Przebieg po drogach to najkrótsza droga między przystankami według OSM – tam, gdzie autobus jedzie dłuższą trasą (np. objazd, zakaz skrętu, którego nie ma w OSM), linia na mapie może się różnić od prawdziwej. Dojście pieszo nadal liczone jest w linii prostej.

## Do zrobienia

### 1. Aktualność GTFS

Plik GTFS na stronie MKS ma rozkład z 11.03.2026, a [ogólny rozkład w PDF](https://www.mksjaslo.pl/rozklad-jazdy/ogolny-rozklad-jazdy) obowiązuje od 01.04.2026. Sprawdzone 24.10.2026 (odjazdy z przystanku początkowego Rynek, dzień roboczy / sobota / niedziela):

- linie **C, D, E2** – zgodne co do minuty,
- linia **A** – 9 z 12 kursów zgodnych; różnice: PDF 06:40 / GTFS 06:45, kurs 07:50 w PDF od pon. do sob. / w GTFS tylko w sobotę, kursu 10:05 (pon.–pt.) brak w GTFS.

Na przystankach pośrednich (3 Maja 01) ok. 20% godzin różniło się od danych kiedyprzyjedzie, głównie o 1 minutę. Do zrobienia: sprawdzić pozostałe linie i zapytać MKS o aktualizację pliku GTFS.

### 2. Ręczne poprawienie położenia przystanków

Część przystanków ma współrzędne nie tam, gdzie faktycznie stoi wiata (np. po złej stronie drogi albo kilkadziesiąt metrów obok), przez co planer czasem pokazuje złe miejsce wsiadania lub wysiadania. To współrzędne z GTFS (MKS), więc nowe wersje pliku tego same nie naprawią.

- Poprawki trzymać w osobnym pliku (np. `scripts/gtfs/stop-overrides.json`), który `build-gtfs.mjs` nakłada na dane – żeby aktualizacja GTFS ich nie nadpisywała. Klucz: nazwa przystanku + przybliżone położenie (identyfikatory mogą się zmieniać między wersjami GTFS).
- Narzędziem jest tryb przeciągania znaczników (`devMode` w `MapMarkerService`) – do rozbudowy o zapis poprawek do pliku zamiast do konsoli.
- Weryfikacja: porównanie z mapą OSM (wiaty / `highway=bus_stop`) lub objazd w terenie.

### 3. Pozostałe

- Własna nazwa aplikacji przed publikacją (nazwa „JakDojade” należy do istniejącej aplikacji).
- Przed publikacją: mail do MKS (biuro@mksjaslo.com.pl) – zgoda na użycie GTFS, aktualizacja pliku, dopisanie numerów linii do GTFS, możliwość udostępnienia danych na żywo (np. GTFS-Realtime z systemu kiedyprzyjedzie).
