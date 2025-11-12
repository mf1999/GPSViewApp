// src/App.jsx — GPS + AIS CSV viewer with timestamp filtering + AUTOPLAY
// GPS CSV columns:   sec,nanosec,latitude,longitude,datetime
// AIS CSV columns:   mmsi,latitude,longitude,header_sec,header_nanosec,bag_name
import React, { useEffect, useMemo, useRef, useState } from 'react';
import Papa from 'papaparse';
import { MapContainer, TileLayer, Polyline, Tooltip, CircleMarker } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

// Default files (served from /public). Safe if missing.
const DEVICE_FILES = {
  device1: '/gps_device1.csv',
  device2: '/gps_device2.csv',
};
const AIS_DEFAULT_FILE = '/ais_position_reports.csv';

// ---------- Helpers ----------
function hashColor(id) {
  const s = String(id);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return `hsl(${h}, 70%, 45%)`;
}
function toFloat(v) {
  const x = typeof v === 'string' ? v.trim() : v;
  const n = parseFloat(x);
  return Number.isFinite(n) ? n : NaN;
}
function toInt(v) {
  if (v === null || v === undefined) return NaN;
  const n = parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : NaN;
}

// Haversine distance in meters
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371008.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Convert a point's time to milliseconds since epoch (number) for filtering/segmenting/rendering.
 * We store/sec/nsec as numbers to avoid BigInt → Number precision issues:
 *   ms = t_sec * 1000 + t_nsec / 1e6
 * Fallback to parsing 't' (datetime string) if t_sec/t_nsec are not present.
 */
function pointTimeMs(p) {
  if (Number.isFinite(p.t_sec)) {
    return p.t_sec * 1000 + (Number.isFinite(p.t_nsec) ? p.t_nsec / 1e6 : 0);
  }
  const tNum = Number(p.t);
  if (Number.isFinite(tNum)) return tNum;
  const d = new Date(String(p.t));
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

// Split into segments when there are big temporal or spatial gaps
function segmentByGap(points, { maxTimeGapMs = 5 * 60 * 1000, maxJumpMeters = 200 } = {}) {
  if (!points || points.length < 2) return [];
  const segs = [];
  let cur = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const ta = pointTimeMs(a);
    const tb = pointTimeMs(b);
    const dt = tb - ta;
    const d = haversineMeters(a.lat, a.lon, b.lat, b.lon);
    if (dt > maxTimeGapMs || d > maxJumpMeters) {
      if (cur.length > 1) segs.push(cur);
      cur = [b];
    } else {
      cur.push(b);
    }
  }
  if (cur.length > 1) segs.push(cur);
  return segs;
}

// datetime-local helpers (local time)
function toDatetimeLocalValue(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  return `${y}-${m}-${day}T${hh}:${mm}:${ss}`;
}
function fromDatetimeLocalValue(v) {
  if (!v) return NaN;
  return new Date(v).getTime();
}

// ---------- Main component ----------
export default function App() {
  // GPS: Map<deviceId, [{lat,lon,t_sec?,t_nsec?,t?,raw}]>
  const [gpsByDevice, setGpsByDevice] = useState(new Map());
  // AIS: Map<mmsi, [{lat,lon,t_sec,t_nsec,bag,raw}]>
  const [aisByMmsi, setAisByMmsi] = useState(new Map());

  // Visibility & legends
  const [showGPS, setShowGPS] = useState(true);
  const [showAIS, setShowAIS] = useState(true);
  const [hiddenDevices, setHiddenDevices] = useState(new Set());
  const [hiddenMmsi, setHiddenMmsi] = useState(new Set());

  // Time filter (ms in local time). Empty = disabled.
  const [filterStartMs, setFilterStartMs] = useState(NaN);
  const [filterEndMs, setFilterEndMs] = useState(NaN);

  // --- AUTOPLAY state ---
  const [isPlaying, setIsPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(1); // 1x .. 10x
  const [currentTimeMs, setCurrentTimeMs] = useState(NaN); // progresses from filterStartMs → filterEndMs
  const rafRef = useRef(null);
  const lastTickRef = useRef(null);

  // ---------- GPS CSV loader ----------
  // Expected: sec,nanosec,latitude,longitude,datetime
  function parseGpsCsv(input, explicitDevice) {
    const isUrl = typeof input === 'string';
    Papa.parse(input, {
      header: true,
      skipEmptyLines: true,
      worker: true,
      download: isUrl,
      complete: ({ data, errors }) => {
        if (errors?.length) console.warn('[GPS] parse warnings:', errors.slice(0, 3));
        const tmp = new Map(gpsByDevice);

        for (const row of data) {
          const lat = toFloat(row.latitude);
          const lon = toFloat(row.longitude);
          const sec = toInt(row.sec);
          const nsec = toInt(row.nanosec);
          const datetimeRaw = row.datetime; // preserved as-is

          if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

          const device =
            explicitDevice ||
            String(row.device ?? row.id ?? row.Device ?? '').trim() ||
            'device';

          // Store sec/nsec (numbers) to avoid BigInt precision issues
          let t_sec = Number.isFinite(sec) ? sec : undefined;
          let t_nsec = Number.isFinite(nsec) ? nsec : undefined;

          const pt =
            Number.isFinite(t_sec)
              ? { lat, lon, t_sec, t_nsec: t_nsec || 0, t: datetimeRaw, raw: row }
              : { lat, lon, t: datetimeRaw, raw: row };

          if (!tmp.has(device)) tmp.set(device, []);
          tmp.get(device).push(pt);
        }

        // sort ascending by time
        for (const [k, arr] of tmp) {
          arr.sort((a, b) => pointTimeMs(a) - pointTimeMs(b));
        }
        setGpsByDevice(tmp);
      },
      error: (err) => console.error('[GPS] CSV parse error:', err),
    });
  }

  // ---------- AIS CSV loader ----------
  // Expected: mmsi,latitude,longitude,header_sec,header_nanosec,bag_name
  function parseAisCsv(input) {
    const isUrl = typeof input === 'string';
    Papa.parse(input, {
      header: true,
      skipEmptyLines: true,
      worker: true,
      download: isUrl,
      complete: ({ data, errors }) => {
        if (errors?.length) console.warn('[AIS] parse warnings:', errors.slice(0, 3));
        const tmp = new Map();

        for (const row of data) {
          const mmsi = String(row.mmsi ?? '').trim();
          const lat = toFloat(row.latitude);
          const lon = toFloat(row.longitude);
          const sec = toInt(row.header_sec);
          const nsec = toInt(row.header_nanosec);
          const bag = String(row.bag_name ?? '').trim();

          if (!mmsi || !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(sec)) continue;

          const t_sec = sec;             // numbers
          const t_nsec = Number.isFinite(nsec) ? nsec : 0;

          const pt = { lat, lon, t_sec, t_nsec, bag, raw: row };
          if (!tmp.has(mmsi)) tmp.set(mmsi, []);
          tmp.get(mmsi).push(pt);
        }

        for (const [k, arr] of tmp) {
          arr.sort((a, b) => pointTimeMs(a) - pointTimeMs(b));
        }
        setAisByMmsi(tmp);
      },
      error: (err) => console.error('[AIS] CSV parse error:', err),
    });
  }

  // ---------- Auto-load defaults if available ----------
  useEffect(() => {
    try {
      Object.entries(DEVICE_FILES).forEach(([device, url]) => url && parseGpsCsv(url, device));
    } catch (e) {
      console.warn('Skipping default GPS CSV load:', e);
    }
    try {
      if (AIS_DEFAULT_FILE) parseAisCsv(AIS_DEFAULT_FILE);
    } catch (e) {
      console.warn('Skipping default AIS CSV load:', e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- Global data time range ----------
  const allTimesMs = useMemo(() => {
    const times = [];
    for (const arr of gpsByDevice.values()) for (const p of arr) {
      const t = pointTimeMs(p);
      if (Number.isFinite(t)) times.push(t);
    }
    for (const arr of aisByMmsi.values()) for (const p of arr) {
      const t = pointTimeMs(p);
      if (Number.isFinite(t)) times.push(t);
    }
    if (times.length === 0) return { min: NaN, max: NaN };
    return { min: Math.min(...times), max: Math.max(...times) };
  }, [gpsByDevice, aisByMmsi]);

  const filterActive = Number.isFinite(filterStartMs) && Number.isFinite(filterEndMs) && filterEndMs >= filterStartMs;

  // If user changes filter while playing, clamp current time
  useEffect(() => {
    if (!filterActive) {
      setIsPlaying(false);
      setCurrentTimeMs(NaN);
      return;
    }
    if (!Number.isFinite(currentTimeMs)) return;
    const clamped = Math.min(Math.max(currentTimeMs, filterStartMs), filterEndMs);
    if (clamped !== currentTimeMs) setCurrentTimeMs(clamped);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterStartMs, filterEndMs, filterActive]);

  // ---------- Filtering (static) ----------
  const gpsFilteredBase = useMemo(() => {
    if (!filterActive) return gpsByDevice;
    const m = new Map();
    for (const [dev, pts] of gpsByDevice.entries()) {
      const keep = pts.filter((p) => {
        const t = pointTimeMs(p);
        return Number.isFinite(t) && t >= filterStartMs && t <= filterEndMs;
      });
      if (keep.length) m.set(dev, keep);
    }
    return m;
  }, [gpsByDevice, filterActive, filterStartMs, filterEndMs]);

  const aisFilteredBase = useMemo(() => {
    if (!filterActive) return aisByMmsi;
    const m = new Map();
    for (const [mmsi, pts] of aisByMmsi.entries()) {
      const keep = pts.filter((p) => {
        const t = pointTimeMs(p);
        return Number.isFinite(t) && t >= filterStartMs && t <= filterEndMs;
      });
      if (keep.length) m.set(mmsi, keep);
    }
    return m;
  }, [aisByMmsi, filterActive, filterStartMs, filterEndMs]);

  // ---------- Apply currentTime cutoff when playing ----------
  const playingActive = isPlaying && filterActive && Number.isFinite(currentTimeMs);

  const gpsForRender = useMemo(() => {
    if (!playingActive) return gpsFilteredBase;
    const m = new Map();
    for (const [dev, pts] of gpsFilteredBase.entries()) {
      const keep = pts.filter((p) => pointTimeMs(p) <= currentTimeMs);
      if (keep.length) m.set(dev, keep);
    }
    return m;
  }, [gpsFilteredBase, playingActive, currentTimeMs]);

  const aisForRender = useMemo(() => {
    if (!playingActive) return aisFilteredBase;
    const m = new Map();
    for (const [mmsi, pts] of aisFilteredBase.entries()) {
      const keep = pts.filter((p) => pointTimeMs(p) <= currentTimeMs);
      if (keep.length) m.set(mmsi, keep);
    }
    return m;
  }, [aisFilteredBase, playingActive, currentTimeMs]);

  // Legends reflect what's being rendered
  const deviceLegend = useMemo(
    () =>
      Array.from(gpsForRender.keys()).map((dev) => ({
        id: dev,
        color: hashColor(dev),
        count: gpsForRender.get(dev)?.length || 0,
      })),
    [gpsForRender]
  );

  const aisLegend = useMemo(
    () =>
      Array.from(aisForRender.keys()).map((mmsi) => ({
        id: mmsi,
        color: hashColor(mmsi),
        count: aisForRender.get(mmsi)?.length || 0,
      })),
    [aisForRender]
  );

  // ---------- AUTOPLAY loop ----------
  useEffect(() => {
    if (!playingActive) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastTickRef.current = null;
      return;
    }

    function tick(ts) {
      if (lastTickRef.current == null) {
        lastTickRef.current = ts;
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      const dtRealMs = ts - lastTickRef.current; // real elapsed ms between frames
      lastTickRef.current = ts;

      setCurrentTimeMs((prev) => {
        const next = prev + dtRealMs * playSpeed;
        if (next >= filterEndMs) {
          // stop at end
          setIsPlaying(false);
          return filterEndMs;
        }
        return next;
      });

      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastTickRef.current = null;
    };
  }, [playingActive, playSpeed, filterEndMs]);

  // ---------- Render ----------
  return (
    <div style={{ height: '100vh', width: '100vw', display: 'flex', flexDirection: 'column' }}>
      {/* Controls */}
      <div style={{ padding: 8, display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong>GPS & AIS Viewer</strong>

        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={showGPS} onChange={(e) => setShowGPS(e.target.checked)} />
          Show GPS
        </label>

        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={showAIS} onChange={(e) => setShowAIS(e.target.checked)} />
          Show AIS
        </label>

        <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          Load GPS CSV:
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) parseGpsCsv(f);
            }}
          />
        </label>

        <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          Load AIS CSV:
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) parseAisCsv(f);
            }}
          />
        </label>

        {/* Time filter controls */}
        <div style={{ display: 'inline-flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ opacity: 0.75 }}>Filter:</span>
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            Start
            <input
              type="datetime-local"
              value={toDatetimeLocalValue(filterStartMs)}
              onChange={(e) => {
                const ms = fromDatetimeLocalValue(e.target.value);
                setFilterStartMs(Number.isFinite(ms) ? ms : NaN);
              }}
              step="1"
            />
          </label>
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            End
            <input
              type="datetime-local"
              value={toDatetimeLocalValue(filterEndMs)}
              onChange={(e) => {
                const ms = fromDatetimeLocalValue(e.target.value);
                setFilterEndMs(Number.isFinite(ms) ? ms : NaN);
              }}
              step="1"
            />
          </label>
          <button
            onClick={() => {
              if (Number.isFinite(allTimesMs.min)) setFilterStartMs(allTimesMs.min);
              if (Number.isFinite(allTimesMs.max)) setFilterEndMs(allTimesMs.max);
            }}
          >
            Use Data Range
          </button>
          <button onClick={() => { setFilterStartMs(NaN); setFilterEndMs(NaN); setIsPlaying(false); setCurrentTimeMs(NaN); }}>
            Clear
          </button>
        </div>

        {/* AUTOPLAY controls */}
        <div style={{ display: 'inline-flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginLeft: 8 }}>
          <span style={{ opacity: 0.75 }}>Autoplay:</span>
          <button
            onClick={() => {
              if (!filterActive) return;
              if (!Number.isFinite(currentTimeMs)) {
                setCurrentTimeMs(filterStartMs);
              }
              setIsPlaying((p) => !p);
            }}
            disabled={!filterActive}
            title={filterActive ? 'Play/Pause within the filter window' : 'Set Start and End first'}
          >
            {isPlaying ? 'Pause' : 'Play'}
          </button>
          <button
            onClick={() => {
              if (!filterActive) return;
              setIsPlaying(false);
              setCurrentTimeMs(filterStartMs);
            }}
            disabled={!filterActive}
            title="Jump to start"
          >
            Reset
          </button>
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            Speed
            <input
              type="range"
              min="1"
              max="10"
              step="1"
              value={playSpeed}
              onChange={(e) => setPlaySpeed(parseInt(e.target.value, 10))}
              style={{ verticalAlign: 'middle' }}
            />
            <span>{playSpeed}×</span>
          </label>
          {filterActive && Number.isFinite(currentTimeMs) && (
            <span style={{ opacity: 0.75 }}>
              {new Date(currentTimeMs).toLocaleString()}
            </span>
          )}
        </div>
      </div>

      {/* Map */}
      <div style={{ flex: 1 }}>
        <MapContainer center={[43.515, 16.25]} zoom={12} style={{ height: '100%', width: '100%' }} preferCanvas>
          <TileLayer
            attribution='&copy; OpenStreetMap contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          {/* GPS tracks (per device) */}
          {showGPS &&
            Array.from(gpsForRender.entries()).map(([device, pts]) => {
              if (hiddenDevices.has(device) || !pts?.length) return null;
              const segs = segmentByGap(pts);
              const color = hashColor(device);
              return (
                <React.Fragment key={`gps-wrap-${device}`}>
                  {segs.map((seg, idx) => {
                    const latlngs = seg.map((p) => [p.lat, p.lon]);
                    return (
                      <Polyline
                        key={`gps-${device}-${idx}`}
                        positions={latlngs}
                        pathOptions={{ color, weight: 3, opacity: 0.95 }}
                      >
                        <Tooltip sticky>
                          <div>
                            <div><strong>{device}</strong></div>
                            <div>points: {seg.length}</div>
                          </div>
                        </Tooltip>
                      </Polyline>
                    );
                  })}
                  {/* current point marker (last point) */}
                  {pts.length > 0 && (
                    <CircleMarker
                      center={[pts[pts.length - 1].lat, pts[pts.length - 1].lon]}
                      radius={4}
                      pathOptions={{ color, fillOpacity: 1, weight: 2 }}
                    />
                  )}
                </React.Fragment>
              );
            })}

          {/* AIS tracks (grouped by MMSI) */}
          {showAIS &&
            Array.from(aisForRender.entries()).map(([mmsi, pts]) => {
              if (hiddenMmsi.has(mmsi) || !pts?.length) return null;
              const color = hashColor(mmsi);
              const latlngs = pts.map((p) => [p.lat, p.lon]);
              return (
                <React.Fragment key={`ais-wrap-${mmsi}`}>
                  <Polyline
                    key={`ais-${mmsi}`}
                    positions={latlngs}
                    pathOptions={{ color, weight: 3, opacity: 0.9 }}
                  >
                    <Tooltip sticky>
                      <div>
                        <div><strong>MMSI {mmsi}</strong></div>
                        <div>reports: {pts.length}</div>
                      </div>
                    </Tooltip>
                  </Polyline>
                  {/* current point marker (last point) */}
                  {pts.length > 0 && (
                    <CircleMarker
                      center={[pts[pts.length - 1].lat, pts[pts.length - 1].lon]}
                      radius={4}
                      pathOptions={{ color, fillOpacity: 1, weight: 2 }}
                    />
                  )}
                </React.Fragment>
              );
            })}
        </MapContainer>
      </div>

      {/* Legends */}
      <div style={{ padding: 8, display: 'flex', gap: 24, fontSize: 14, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>GPS devices</div>
          {deviceLegend.length === 0 && <div style={{ opacity: 0.6 }}>None (in current filter/time)</div>}
          {deviceLegend.map(({ id, color, count }) => (
            <label key={id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <input
                type="checkbox"
                checked={!hiddenDevices.has(id)}
                onChange={(e) => {
                  const next = new Set(hiddenDevices);
                  if (e.target.checked) next.delete(id);
                  else next.add(id);
                  setHiddenDevices(next);
                }}
              />
              <span style={{ display: 'inline-block', width: 12, height: 12, background: color, borderRadius: 2 }} />
              <span style={{ minWidth: 120 }}>{id}</span>
              <span style={{ opacity: 0.7 }}>({count})</span>
            </label>
          ))}
        </div>

        <div>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>AIS MMSI</div>
          {aisLegend.length === 0 && <div style={{ opacity: 0.6 }}>None (in current filter/time)</div>}
          <div style={{ maxHeight: 160, overflow: 'auto', border: '1px solid #ddd', padding: 6, borderRadius: 6 }}>
            {aisLegend.map(({ id, color, count }) => (
              <label key={id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <input
                  type="checkbox"
                  checked={!hiddenMmsi.has(id)}
                  onChange={(e) => {
                    const next = new Set(hiddenMmsi);
                    if (e.target.checked) next.delete(id);
                    else next.add(id);
                    setHiddenMmsi(next);
                  }}
                />
                <span style={{ display: 'inline-block', width: 12, height: 12, background: color, borderRadius: 2 }} />
                <span style={{ minWidth: 120 }}>{id}</span>
                <span style={{ opacity: 0.7 }}>({count})</span>
              </label>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
