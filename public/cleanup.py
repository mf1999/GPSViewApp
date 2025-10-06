#!/usr/bin/env python3
# gps_cleanup_and_interpolate_v2.py — backup CSV, detect spike/teleport runs, and fix by interpolation

from math import radians, sin, cos, asin, sqrt
from datetime import datetime
from pathlib import Path
import shutil
import csv

# ===== CONFIG =====
CSV_FILE = "gps_device2.csv"       # your input CSV
JUMP_TOLERANCE_M = 100.0                 # meters; step distance > tolerance is suspicious
FLAG_TIME_NONMONOTONIC = True            # mark rows where (sec,nanosec) go backward or equal
FLAG_INVALID_LATLON = True               # mark rows with invalid lat/lon
SAVE_SUSPECTS_LOG = True                 # write a suspects log CSV alongside the input
BACKUP_SUFFIX = ".bkp"                   # file extension for backup
# ==================

EARTH_RADIUS_M = 6_371_008.8


def haversine_m(lat1, lon1, lat2, lon2):
    """Distance in meters between two (lat, lon) points (WGS84 sphere approx)."""
    lat1, lon1, lat2, lon2 = map(radians, (lat1, lon1, lat2, lon2))
    dlat, dlon = lat2 - lat1, lon2 - lon1
    a = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_M * asin(sqrt(a))


def to_ns(sec: int, nsec: int) -> int:
    return int(sec) * 1_000_000_000 + int(nsec)


def looks_invalid_latlon(lat, lon):
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        return True
    # treat (0,0) as invalid (often placeholder)
    if abs(lat) < 1e-12 and abs(lon) < 1e-12:
        return True
    return False


def load_csv(path: Path):
    with path.open(newline="") as f:
        reader = csv.DictReader(f)
        rows = [row for row in reader]
    return rows, reader.fieldnames


def write_csv(path: Path, fieldnames, rows):
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in rows:
            w.writerow(r)


def main():
    path = Path(CSV_FILE)
    if not path.exists():
        raise FileNotFoundError(f"CSV not found: {path}")

    # 1) Backup original
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_path = path.with_suffix(path.suffix + BACKUP_SUFFIX + f".{stamp}")
    shutil.copy2(path, backup_path)
    print(f"[info] Backup saved to: {backup_path}")

    # 2) Load CSV
    rows, fieldnames = load_csv(path)
    required = {"sec", "nanosec", "latitude", "longitude", "datetime"}
    if not required.issubset(set(fieldnames)):
        raise ValueError(f"CSV must have columns: {sorted(required)}; found: {fieldnames}")

    n = len(rows)
    if n == 0:
        print("[info] CSV is empty; nothing to do.")
        return

    # parse numeric fields
    t_ns = []
    lat = []
    lon = []
    for i, r in enumerate(rows):
        try:
            sec = int(r["sec"])
            nsec = int(r["nanosec"])
            la = float(r["latitude"])
            lo = float(r["longitude"])
        except Exception as e:
            raise ValueError(f"Parse error at row {i}: {e}")
        t_ns.append(to_ns(sec, nsec))
        lat.append(la)
        lon.append(lo)

    # 3) Pre-mark “hard” bad rows (invalid lat/lon, nonmonotonic time)
    hard_bad = [False] * n
    if FLAG_INVALID_LATLON:
        for i in range(n):
            if looks_invalid_latlon(lat[i], lon[i]):
                hard_bad[i] = True
    if FLAG_TIME_NONMONOTONIC:
        for i in range(1, n):
            if t_ns[i] <= t_ns[i - 1]:
                hard_bad[i] = True

    # 4) Compute consecutive step distances
    step_dist = [0.0] * n
    for i in range(1, n):
        step_dist[i] = haversine_m(lat[i - 1], lon[i - 1], lat[i], lon[i])

    # 5) Find suspicious runs: edges where step distance > tolerance OR row is hard_bad
    #    Then only “fix” if the run closes back near the last good anchor (i.e., a spike/teleport).
    is_bad = [False] * n
    segments = []  # list of (start_idx, end_idx, L, R) to be fixed, inclusive of start/end
    i = 1
    last_good_anchor = 0  # first row is initial anchor by definition
    while i < n:
        suspicious = hard_bad[i] or (step_dist[i] > JUMP_TOLERANCE_M)
        if not suspicious:
            last_good_anchor = i
            i += 1
            continue

        # start of a run
        run_start = i
        j = i
        while j < n and (hard_bad[j] or step_dist[j] > JUMP_TOLERANCE_M):
            j += 1
        run_end = j - 1  # inclusive indices run_start..run_end are suspicious transitions

        # Determine R (the first non-suspicious row after the run)
        R = j if j < n else None
        L = last_good_anchor if last_good_anchor is not None else None

        # Check closure: if both anchors exist and distance L -> R is within tolerance, it's a spike
        should_fix = False
        if L is not None and R is not None:
            close_dist = haversine_m(lat[L], lon[L], lat[R], lon[R])
            if close_dist <= JUMP_TOLERANCE_M:
                should_fix = True
                seg_a = run_start
                seg_b = R - 1  # we fix all rows between anchors (exclude L and R)
                segments.append((seg_a, seg_b, L, R))
                # after fixing, consider R the new anchor
                last_good_anchor = R
                i = R + 1
                continue

        # No closure case:
        # - If run is at the start and we have only a right anchor, copy R
        # - If run is at the end and we have only a left anchor, copy L
        # - Otherwise: treat as real movement (do NOT fix), advance and set the new anchor at the first non-suspicious row
        if L is None and R is not None:
            # Fix by copying R (no left anchor available)
            segments.append((run_start, R - 1, R, R))  # L==R means copy R
            last_good_anchor = R
            i = R + 1
        elif L is not None and R is None:
            # Fix by copying L (no right anchor)
            segments.append((run_start, n - 1, L, L))
            i = n  # we're done
        else:
            # No fix (likely real motion); move anchor forward to R and continue
            last_good_anchor = R if R is not None else last_good_anchor
            i = (R + 1) if R is not None else n

    # Mark is_bad for logging
    for (a, b, L, R) in segments:
        for k in range(a, b + 1):
            is_bad[k] = True

    print(f"[info] Will fix {len(segments)} suspicious segment(s).")

    # 6) Apply fixes: interpolate between anchors (L,R). If L==R, copy that point.
    fixes = 0
    for (a, b, L, R) in segments:
        if L == R:
            # Copy lat/lon from the sole anchor
            for k in range(a, b + 1):
                lat[k] = lat[L]
                lon[k] = lon[L]
                fixes += 1
            continue

        # Interpolate linearly in time
        tL = t_ns[L]
        tR = t_ns[R]
        dt_total = tR - tL
        if dt_total <= 0:
            # Fallback: midpoint average
            base_lat = 0.5 * (lat[L] + lat[R])
            base_lon = 0.5 * (lon[L] + lon[R])
            for k in range(a, b + 1):
                lat[k] = base_lat
                lon[k] = base_lon
                fixes += 1
            continue

        for k in range(a, b + 1):
            alpha = (t_ns[k] - tL) / dt_total
            if alpha < 0.0:
                alpha = 0.0
            elif alpha > 1.0:
                alpha = 1.0
            lat[k] = lat[L] + alpha * (lat[R] - lat[L])
            lon[k] = lon[L] + alpha * (lon[R] - lon[L])
            fixes += 1

    # 7) Write back CSV (overwrite original)
    for i in range(n):
        rows[i]["latitude"] = f"{lat[i]:.7f}"
        rows[i]["longitude"] = f"{lon[i]:.7f}"

    write_csv(path, fieldnames, rows)
    print(f"[done] Wrote cleaned file: {path}")
    print(f"[done] Fixed {fixes} values across {len(segments)} segment(s).")

    # 8) Optional suspects log (segments and brief reasons)
    if SAVE_SUSPECTS_LOG:
        sus_path = path.with_name(path.stem + "_suspects.csv")
        with sus_path.open("w", newline="") as g:
            w = csv.writer(g)
            w.writerow(["segment_start_idx", "segment_end_idx", "left_anchor_idx", "right_anchor_idx"])
            for (a, b, L, R) in segments:
                w.writerow([a, b, L, R])
        print(f"[info] Suspects log saved to: {sus_path}")


if __name__ == "__main__":
    main()
