# JakDojadę Jasło (autobusy)

Webowa aplikacja z mapą komunikacji miejskiej MKS Jasło. Pokazuje wszystkie przystanki na mapie, odjazdy na żywo dla wybranego przystanku i wyszukuje połączenia z punktu A do punktu B (bezpośrednie i z jedną przesiadką).

Dane o odjazdach pochodzą z publicznego API systemu [kiedyprzyjedzie.pl](https://mksjaslo.kiedyprzyjedzie.pl). Pozycje przystanków są trzymane lokalnie w pliku JSON, żeby można je było ręcznie poprawiać.

## Funkcje

- **Mapa przystanków** – Leaflet + kafelki OpenStreetMap, wyśrodkowana na Jaśle; 586 słupków (ok. 350 unikalnych nazw).
- **Odjazdy na żywo** – kliknięcie przystanku otwiera dymek z najbliższymi 8 odjazdami (linia, kierunek, czas, znacznik `LIVE` dla czasów z GPS).
- **Wyszukiwarka przystanków** – pole w lewym górnym rogu, po wybraniu mapa przelatuje do przystanku.
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
│   └── main-map.component.ts            # Logika UI + algorytm wyszukiwania połączeń
├── core/services/timetable.service.ts   # Klient API kiedyprzyjedzie.pl
├── features/map/services/
│   └── map-marker.service.ts            # Rysowanie przystanków i dymków z odjazdami
└── shared/
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
| `GET /api/trip_execution/{base64(tripId)}` | Pełna lista przystanków i godzin konkretnego kursu |

Do rysowania tras (dojście pieszo, przejazd autobusu) używane są publiczne serwery OSRM: `routing.openstreetmap.de`, a w razie błędu `router.project-osrm.org`. Gdy oba zawiodą, rysowana jest linia prosta.

## Jak działa wyszukiwanie połączeń

1. **Kandydaci** – jeśli wybrano konkretny przystanek, brany jest tylko on; jeśli punkt na mapie – 10 najbliższych przystanków.
2. **Połączenia bezpośrednie** – dla każdej pary (start, cel) szukane są wspólne linie. Kierunek jazdy sprawdzany jest najpierw po nazwie kierunku i położeniu, a potem dokładnie – po kolejności przystanków w `trip_execution`.
3. **Przesiadki** – gdy połączeń bezpośrednich jest mniej niż 5, algorytm sprawdza kolejne przystanki kursów odjeżdżających ze startu i szuka tam linii jadącej do celu (min. 2 minuty na przesiadkę). Wyników jest maksymalnie 6.
4. **Sortowanie** – najpierw połączenia z realnym najbliższym odjazdem, posortowane po łącznym czasie. Czas dojścia liczony jest jako 80 m/min w linii prostej.

## Poprawianie pozycji przystanków

1. W `map-marker.service.ts` ustaw `devMode = true`.
2. Przeciągnij znacznik w miejsce, gdzie faktycznie stoi wiata.
3. Skopiuj obiekt JSON z konsoli przeglądarki i podmień wpis w `public/assets/data/stops-base.json` (pole `id` musi zostać bez zmian).
4. Przywróć `devMode = false`.

## Znane ograniczenia

- Planer wykonuje dziesiątki zapytań do API jedno po drugim, więc wyszukiwanie może trwać kilka–kilkanaście sekund.
- Obsługiwana jest maksymalnie jedna przesiadka.
- Testy obejmują na razie tylko komponent główny i helpery tekstowe – algorytm planera nie ma testów.
