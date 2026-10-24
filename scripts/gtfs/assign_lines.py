#!/usr/bin/env python3
"""
Assigns MKS line numbers (A, 10, E4…) to GTFS route variants.

The MKS GTFS has no line numbers – routes are only named like "JASŁO - BIERÓWKA - NIEPLA",
and one GTFS route can hold several lines. The official general timetable (PDF) has them,
so every route variant (same stop sequence) is matched against it with two signals:

  1. destination and route  – `line-rules.json`, written by hand from the PDF columns
                               "Kierunek" / "przez" (does the variant start at the line's
                               terminus in Jasło and pass its destination / via streets?)
  2. departure times        – departures of the variant's trips found in the PDF block of
                               the line (left column = from Jasło, right = return trips)

Output: scripts/gtfs/line-assignments.json  { signature: {line, confidence, …} }
The signature is a hash of the stop *names* in order, so it survives stop-ID changes
between GTFS versions (build-gtfs.mjs computes the same one).

Usage (needs `pdftotext` from poppler-utils):
  python3 -I scripts/gtfs/assign_lines.py <GTFS.zip> <Rozklad jazdy ogolny.pdf>

Run it again whenever MKS publishes a new GTFS or timetable; check the summary and fix
remaining mistakes in line-overrides.json (it wins over this file). Lines that share one route
on different days (e.g. D at weekends / E2 on weekdays to Hankówka) can only be told apart
per trip – put those in line-overrides.json as "byStart" entries.
"""
import collections, csv, hashlib, io, json, re, subprocess, sys, unicodedata, zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent


def read_gtfs(zip_path):
    z = zipfile.ZipFile(zip_path)
    def rd(name):
        with z.open(name) as f:
            return list(csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig")))
    return rd("stops.txt"), rd("trips.txt"), rd("stop_times.txt")


def read_calendar(zip_path):
    z = zipfile.ZipFile(zip_path)
    def rd(name):
        with z.open(name) as f:
            return list(csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig")))
    calendar = {c["service_id"]: c for c in rd("calendar.txt")}
    exceptions = collections.defaultdict(dict)
    for r in rd("calendar_dates.txt"):
        exceptions[r["service_id"]][r["date"]] = r["exception_type"]
    return calendar, exceptions


def signature(stop_names):
    return hashlib.sha1("|".join(stop_names).encode("utf-8")).hexdigest()[:16]


def minutes(t):
    h, m = t.split(":")[:2]
    return int(h) * 60 + int(m)


def norm(s):
    s = s.upper().replace("Ł", "L")
    s = unicodedata.normalize("NFD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^A-Z0-9 ]", "", s)


# ── PDF: which line does each departure time belong to? ──────────────
KNOWN = {"D", "N", "OP", "OM", "ND", "E1", "E2", "E3", "E4", "E5", "E6", "E", "K", "OG", "H", "A", "C",
         "3", "4", "5", "6", "7", "9", "10", "11", "12", "13", "14", "20", "21", "22", "23", "24",
         "25", "29", "30", "32", "33", "34", "36", "39"}
LABEL = re.compile(r"^\s{0,3}(E\d|OG|0G|OP|OM|ND|[A-Z]|\d{1,2})(?=\s|$)")
TIME = re.compile(r"(?<![\d.:])(\d{1,2})[.:](\d{2})(?!\d)\s?(\(6\S*\)|[A-Z+6]*)")
# Day symbols from the PDF legend → day types (W = Mon–Fri, SAT, SUN); None = not restricted
DAY_CODES = {"D": {"W"}, "E": {"W", "SAT"}, "C": {"SAT", "SUN"}, "B": {"W", "SUN"}, "+": {"SUN"},
             "6": {"SAT"}, "S": {"W"}, "H": {"W"}}


def day_types(code):
    code = code.strip("()")
    for ch in code:
        if ch in DAY_CODES:
            return DAY_CODES[ch]
    return None
RIGHT_COLUMN = 62  # departures right of this column are return trips


def pdf_times(pdf_path):
    text = subprocess.run(["pdftotext", "-layout", str(pdf_path), "-"],
                          capture_output=True, text=True, check=True).stdout
    rows = text.split("\n")
    section, entries, labels = None, [], []
    for i, row in enumerate(rows):
        if "Stanowisko MKS Nr 1" in row: section = "RYNEK"; continue
        if "Stanowisko MKS Nr 2" in row: section = "SKARGI"; continue
        if "Stanowisko MKS Nr 3" in row: section = "MICKIEWICZA"; continue
        if section is None or "Godziny odjazdu" in row or row.strip().startswith(("Nr", "Linii")):
            continue
        m = LABEL.match(row)
        if m and m.group(1).replace("0G", "OG") in KNOWN:
            labels.append((i, section, m.group(1).replace("0G", "OG")))
        for tm in TIME.finditer(row):
            h, mm = int(tm.group(1)), int(tm.group(2))
            if h <= 23 and mm <= 59:
                side = "out" if tm.start() < RIGHT_COLUMN else "back"
                entries.append((i, section, side, h * 60 + mm, day_types(tm.group(3) or "")))

    def nearest_label(row, sec):
        c = sorted((abs(r - row), line) for r, s, line in labels if s == sec)
        return c[0][1] if c and c[0][0] <= 6 else None

    index = collections.defaultdict(set)  # (section, side, minute) -> {(line, day types)}
    for row, sec, side, m, days in entries:
        line = nearest_label(row, sec)
        if line:
            index[(sec, side, m)].add((line, frozenset(days) if days else None))
    return index


def line_day_types(index):
    """Day types each line runs on according to the PDF (None = some entry without a day symbol)."""
    days = collections.defaultdict(set)
    for entries in index.values():
        for line, d in entries:
            days[line] |= set(d) if d else {"W", "SAT", "SUN"}
    return days


def lines_at(index, key, trip_days):
    """Lines listing this departure on a day type the trip runs on."""
    return {line for line, days in index.get(key, ()) if days is None or days & trip_days}


TERMINI = {"RYNEK": ["RYNEK (STAROSTWO", "RYNEK 02"], "SKARGI": ["P.SKARGI"],
           "MICKIEWICZA": ["MICKIEWICZA 0"], "GALERIA": ["PAWŁA II Galeria"]}
GENERIC_DESTINATIONS = {norm("RYNEK"), norm("P.SKARGI"), norm("J.PAWŁA II Galeria")}
PDF_SECTION = {"RYNEK": "RYNEK", "SKARGI": "SKARGI", "MICKIEWICZA": "MICKIEWICZA", "GALERIA": "RYNEK"}


def terminus_of(name):
    for place, keys in TERMINI.items():
        if any(norm(k) in norm(name) for k in keys):
            return place
    return None


def trip_day_types(services, calendar, exceptions):
    """Day types (W / SAT / SUN) each service runs on in a normal week of the feed."""
    import datetime
    result = {}
    for sid in services:
        cal = calendar.get(sid)
        start = datetime.datetime.strptime(cal["start_date"], "%Y%m%d").date() if cal else None
        types = set()
        # first full week after the feed start that has no public holidays in Poland we know of
        monday = (start or datetime.date.today()) + datetime.timedelta(days=7)
        monday -= datetime.timedelta(days=monday.weekday())
        for i, wd in enumerate(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]):
            d = (monday + datetime.timedelta(days=i)).strftime("%Y%m%d")
            e = exceptions.get(sid, {}).get(d)
            on = e == "1" or (e != "2" and cal is not None and cal[wd] == "1" and cal["start_date"] <= d <= cal["end_date"])
            if on:
                types.add("W" if i < 5 else "SAT" if i == 5 else "SUN")
        result[sid] = frozenset(types) or frozenset({"W", "SAT", "SUN"})
    return result


def main(zip_path, pdf_path):
    rules = {k: v for k, v in json.loads((HERE / "line-rules.json").read_text("utf-8")).items()
             if not k.startswith("_")}
    stops, trips, stop_times = read_gtfs(zip_path)
    calendar, exceptions = read_calendar(zip_path)
    service_of = {t["trip_id"]: t["service_id"] for t in trips}
    days_of_service = trip_day_types(set(service_of.values()), calendar, exceptions)
    stop_name = {s["stop_id"]: s["stop_name"] for s in stops}
    headsign = {t["trip_id"]: t["trip_headsign"] for t in trips}
    seqs = collections.defaultdict(list)
    for r in stop_times:
        seqs[r["trip_id"]].append(r)

    variants = collections.defaultdict(list)  # signature -> trip rows
    for trip_id, rows in seqs.items():
        rows.sort(key=lambda r: int(r["stop_sequence"]))
        variants[signature([stop_name[r["stop_id"]] for r in rows])].append((trip_id, rows))

    times = pdf_times(pdf_path)
    line_days = line_day_types(times)
    result = {}
    for sig, trips_ in variants.items():
        names = [stop_name[r["stop_id"]] for r in trips_[0][1]]
        nn = [norm(n) for n in names]
        start, end = terminus_of(names[0]), terminus_of(names[-1])

        votes = collections.Counter()
        for trip_id, rows in trips_:
            m0 = minutes(rows[0]["departure_time"])
            tdays = days_of_service[service_of[trip_id]]
            found = set()
            if start:
                found |= lines_at(times, (PDF_SECTION[start], "out", m0), tdays)
            else:
                for sec in ("RYNEK", "SKARGI", "MICKIEWICZA"):
                    found |= lines_at(times, (sec, "back", m0), tdays)
            votes.update(found)

        variant_days = set().union(*(days_of_service[service_of[t]] for t, _ in trips_))
        scores = {}
        for line, rule in rules.items():
            if not any(p in (start, end) for p in rule["from"].split("|")):
                continue
            if line in line_days and not (line_days[line] & variant_days):
                continue  # e.g. E1 runs Mon–Fri only, so it can't be a Saturday-only variant
            if any(norm(k) in n for k in rule.get("never", []) for n in nn):
                continue
            # destination at an end of the variant (or its headsign) counts more than in the middle
            ends_ = [nn[0], nn[-1], norm(headsign[trips_[0][0]])]
            to_end = any(norm(k) in n for k in rule["to"] for n in ends_)
            to_mid = any(norm(k) in n for k in rule["to"] for n in nn)
            via = sum(any(norm(k) in n for n in nn) for k in rule["via"])
            loop = start is not None and end is not None  # starts and ends in Jasło: destination is mid-route
            to = 4 if to_end or (loop and to_mid) else 2.5 if to_mid else 0
            scores[line] = to + min(via, 2) + 0.5 * min(votes.get(line, 0), 6)
        ranked = sorted(scores.items(), key=lambda x: -x[1])
        best, best_score = ranked[0] if ranked else (None, 0)
        margin = best_score - (ranked[1][1] if len(ranked) > 1 else 0)
        top_vote = votes.most_common(1)[0][0] if votes else None

        if best is None or best_score < 5:
            line, confidence = None, "none"
        elif top_vote == best and margin >= 1.5:
            line, confidence = best, "high"
        else:
            line, confidence = best, "medium"
        # Trips running on days the line doesn't run (e.g. Saturday trips in a variant whose line is
        # Mon–Fri only): another fitting line that runs then, or no line rather than a wrong one
        by_start, clashes = {}, set()
        if line:
            for trip_id, rows in trips_:
                tdays = days_of_service[service_of[trip_id]]
                if line_days.get(line, tdays) & tdays:
                    continue
                alt = next((l for l, sc in ranked if sc >= 5 and line_days.get(l, tdays) & tdays), None)
                m0 = minutes(rows[0]["departure_time"])
                key = f"{m0 // 60 % 24:02d}:{m0 % 60:02d}"
                if key in by_start and by_start[key] != alt:
                    clashes.add(key)
                by_start[key] = alt
            # a start time shared by trips needing different lines can't be told apart by time
            for key in clashes:
                by_start.pop(key)

        result[sig] = {"line": line, "confidence": confidence, "trips": len(trips_),
                       **({"byStart": by_start} if by_start else {}),
                       "first": names[0], "last": names[-1], "headsign": headsign[trips_[0][0]],
                       "candidates": [[l, s] for l, s in ranked[:3]]}

    out = HERE / "line-assignments.json"
    out.write_text(json.dumps(dict(sorted(result.items())), ensure_ascii=False, indent=1) + "\n", "utf-8")
    by = collections.Counter()
    for v in result.values():
        by[v["confidence"]] += v["trips"]
    print(f"{len(result)} route variants, {sum(by.values())} trips → high: {by['high']}, "
          f"medium: {by['medium']}, no line: {by['none']}")
    print(f"written {out.relative_to(HERE.parent.parent)}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
