# JakDojadę Jasło (autobusy)

Webowa aplikacja z mapą komunikacji miejskiej MKS Jasło. Pokazuje wszystkie przystanki na mapie, odjazdy na żywo dla wybranego przystanku i wyszukuje połączenia z punktu A do punktu B (bezpośrednie i z jedną przesiadką).

Dane o odjazdach pochodzą z publicznego API systemu [kiedyprzyjedzie.pl](https://mksjaslo.kiedyprzyjedzie.pl). Pozycje przystanków są trzymane lokalnie w pliku JSON, żeby można je było ręcznie poprawiać.

## Funkcje

- **Mapa przystanków** – Leaflet + kafelki OpenStreetMap, wyśrodkowana na Jaśle; 586 słupków (ok. 350 unikalnych nazw).
- **Odjazdy na żywo** – kliknięcie przystanku otwiera dymek z najbliższymi 8 odjazdami (linia, kierunek, czas, znacznik `LIVE` dla czasów z GPS).
- **Wyszukiwarka przystanków** – pole w lewym górnym rogu, po wybraniu mapa przelatuje do przystanku.
- **Wybór daty i godziny** – przycisk „🕒 Teraz” pod wyszukiwarką i sekcja „Kiedy” w planerze. „Teraz” oznacza odjazdy na żywo; „Inny termin” przełącza dymki i planer na rozkład jazdy dla wybranego dnia i godziny (do 60 dni naprzód). Przydaje się też do testowania w nocy, gdy autobusy nie kursują.
- **Ulubione i ostatnie** – gwiazdka ☆ w okienku przystanku (ulubione mają na mapie żółtą kropkę). Po kliknięciu w puste pole wyszukiwarki widać ulubione i ostatnio oglądane przystanki. W planerze puste pola A/B podpowiadają ulubione, a pod formularzem jest lista ostatnich tras do powtórzenia jednym kliknięciem. Dane są zapisane w przeglądarce (`localStorage`); tras z „Moja lokalizacja” nie zapisujemy.
- **Planer trasy A → B** – punkt startu/celu można wybrać z listy przystanków, kliknąć na mapie albo użyć swojej lokalizacji. Wyniki są sortowane po łącznym czasie podróży (dojście + czekanie + jazda + dojście), a wybrana trasa jest rysowana na mapie.
- **Tryb korekty pozycji** – po ustawieniu `devMode = true` w `MapMarkerService` znaczniki można przeciągać, a nowe współrzędne lądują w konsoli.

## Wymagania

- Node.js w wersji obsługiwanej przez Angular 21 (20.19+, 22.12+ lub 24)
- npm 11 (zgodnie z polem `packageManager`)

## Uruchomienie

```bash
npm install
```

```bash
npm start
```

Aplikacja wystartuje pod `http://localhost:4200/` i przeładuje się sama po każdej zmianie w kodzie.

W trybie deweloperskim zapytania na `/api/*` są przekierowywane przez proxy (`proxy.conf.json`) do `https://mksjaslo.kiedyprzyjedzie.pl`. Dzięki temu przeglądarka nie blokuje ich przez CORS.

### Pozostałe komendy

| Komenda | Co robi |
| --- | --- |
| `npm run build` | Build produkcyjny do `dist/autobusy/browser` |
| `npm run watch` | Build deweloperski w trybie obserwowania zmian |
| `npm test` | Testy jednostkowe (Vitest) |

## Wdrożenie produkcyjne

Build to statyczne pliki, ale **aplikacja potrzebuje proxy dla `/api`** – w produkcji `proxy.conf.json` nie działa. Serwer (np. nginx) musi przekazywać `/api/` do kiedyprzyjedzie.pl, na przykład:

```nginx
location /api/ {
    proxy_pass https://mksjaslo.kiedyprzyjedzie.pl/api/;
    proxy_set_header Host mksjaslo.kiedyprzyjedzie.pl;
    proxy_ssl_server_name on;
}
```

## Struktura projektu

```
src/app/
├── app.ts / app.html                    # Główny komponent – renderuje tylko mapę
├── app.config.ts                        # Providery: router, HttpClient
├── main-map/                            # Cały interfejs: mapa, wyszukiwarka, planer trasy
│   └── main-map.component.ts            # Stan UI, rysowanie tras na mapie
├── core/services/
│   ├── timetable.service.ts             # Klient API kiedyprzyjedzie.pl (na żywo + rozkład)
│   ├── travel-time.service.ts           # Wybrana data/godzina podróży (null = teraz)
│   └── favorites.service.ts             # Ulubione, ostatnie przystanki i trasy (localStorage)
├── features/
│   ├── map/services/map-marker.service.ts      # Rysowanie przystanków i dymków z odjazdami
│   └── route-planner/route-planner.service.ts  # Algorytm wyszukiwania połączeń (+ testy)
└── shared/
    ├── components/time-picker/          # Wybór „Teraz / Inny termin” (chip na mapie, sekcja w planerze)
    ├── models/transit.models.ts         # Typy: Stop, Departure, TripExecutionResponse…
    └── utils/text.utils.ts              # Porównywanie nazw (polskie znaki) i escapowanie HTML

public/assets/data/stops-base.json       # Lokalna baza przystanków
proxy.conf.json                          # Proxy /api → kiedyprzyjedzie.pl (tylko dev)
```

Przy wstawianiu danych z API do dymków Leaflet (`bindPopup`, `setContent`) zawsze używaj `escapeHtml()`. Nazwy przystanków i kierunków porównuj przez `namesMatch()`.

## Używane API

Wszystkie zapytania idą przez `/api` (proxy). Identyfikator przystanku ma postać `1332005:1392084` i jest kodowany w URL.

| Endpoint | Do czego |
| --- | --- |
| `GET /api/departures/{stopId}` | Najbliższe odjazdy z przystanku |
| `GET /api/directions/{stopId}` | Linie i kierunki obsługujące przystanek |
| `GET /api/trip_execution/{base64(tripId)}` | Pełna lista przystanków i godzin konkretnego kursu (na żywo) |
| `GET /api/directions/{stopId}?date=RRRR-MM-DD` | Linie kursujące przez przystanek w danym dniu |
| `GET /api/timetable/{stopId}/{base64url(linia)}?date=RRRR-MM-DD` | Rozkład jednej linii na przystanku w danym dniu (czasy w sekundach od północy) |
| `GET /api/trip/{tripId}/{index}` | Planowa lista przystanków kursu z rozkładu (`index` = pozycja przystanku w kursie) |

W trybie „Inny termin” `TimetableService.getScheduledDepartures()` pobiera rozkłady wszystkich linii danego dnia równolegle i zamienia je na ten sam format, co odjazdy na żywo. Dzięki temu planer działa tak samo w obu trybach. Kursy z rozkładu mają identyfikator `trip:<tripId>:<index>`. Rozkład dnia jest zapamiętywany na czas sesji.

Do rysowania tras (dojście pieszo, przejazd autobusu) używane są publiczne serwery OSRM: `routing.openstreetmap.de`, a w razie błędu `router.project-osrm.org`. Gdy oba zawiodą, rysowana jest linia prosta.

## Jak działa wyszukiwanie połączeń

Algorytm siedzi w `RoutePlannerService`.

1. **Kandydaci** – wybrany przystanek razem z jego drugim słupkiem (ta sama nazwa, do 400 m), albo 10 przystanków najbliższych punktu na mapie.
2. **Połączenia bezpośrednie** – dla odjazdów z przystanków startowych planer pobiera przebieg kursu (listę przystanków z godzinami) i sprawdza, czy autobus dojeżdża później do któregoś przystanku docelowego. Nie porównuje nazw kierunków, bo wiele linii jeździ w pętli i zmienia tablicę po drodze (np. E4 „do Rynku” jedzie dalej, do Szpitala). Brane są tylko linie, które zatrzymują się przy celu albo kończą tam bieg. Każdy kurs autobusu pojawia się raz, z najlepszym przystankiem wsiadania i wysiadania.
3. **Przesiadki** – szukane, gdy połączeń bezpośrednich jest mniej niż 3 albo na najlepsze trzeba czekać ponad 20 minut. Planer jedzie kursem ze startu i na kolejnych przystankach szuka autobusu, który według swojego przebiegu dojeżdża do celu (min. 2 minuty na przesiadkę). Pomija przesiadki, które nie mogą być szybsze od najlepszego połączenia bezpośredniego.
4. **Brak kursów** – gdy nic nie odjeżdża, planer pokazuje linie łączące przystanki z dopiskiem „Brak kursu” (tu nadal na podstawie nazw kierunków).
5. **Sortowanie** – po łącznym czasie (dojście + czekanie + jazda + dojście), maks. 8 wyników. Czas dojścia liczony jest jako 80 m/min w linii prostej.

Zapytania do API idą równolegle, a te same nigdy nie są wysyłane dwa razy (przebieg kursu pobierany jest raz na kurs, niezależnie od przystanku). W trybie „Inny termin” rozkład pobierany jest tylko dla potrzebnych linii.

## Poprawianie pozycji przystanków

1. W `map-marker.service.ts` ustaw `devMode = true`.
2. Przeciągnij znacznik w miejsce, gdzie faktycznie stoi wiata.
3. Skopiuj obiekt JSON z konsoli przeglądarki i podmień wpis w `public/assets/data/stops-base.json` (pole `id` musi zostać bez zmian).
4. Przywróć `devMode = false`.

## Znane ograniczenia

- Planer nadal potrzebuje kilkudziesięciu zapytań do API na jedno wyszukiwanie (ok. 2 s). Dalsze przyspieszenie wymagałoby własnego backendu albo danych GTFS.
- Obsługiwana jest maksymalnie jedna przesiadka.
