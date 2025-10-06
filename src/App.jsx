// App.jsx
import React, { useState, useEffect, useMemo } from 'react';
import Papa from 'papaparse';
import { MapContainer, TileLayer, Polyline } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

const DEVICE_FILES = {
  device1: '/gps_device1.csv',
  device2: '/gps_device2.csv',
};

const DEVICE_COLORS = {
  device1: 'blue',
  device2: 'red',
};

/* ---------- helpers ---------- */

// meters between two lat/lon points (haversine)
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

// Split into segments when gaps are large (time or spatial jump)
function segmentByGap(points, { maxTimeGapMs = 5 * 60 * 1000, maxJumpMeters = 200 } = {}) {
  if (!points || points.length === 0) return [];
  const segs = [];
  let cur = [points[0]];

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const dt = curr.datetime - prev.datetime; // ms
    const d = haversineMeters(prev.lat, prev.lon, curr.lat, curr.lon);

    // break if a large time gap or a large jump
    if (dt > maxTimeGapMs || d > maxJumpMeters || !isFinite(d)) {
      if (cur.length >= 2) segs.push(cur);
      cur = [curr];
    } else {
      cur.push(curr);
    }
  }
  if (cur.length >= 2) segs.push(cur);
  return segs;
}

// Parse CSV -> [{lat, lon, datetime}], sorted by datetime, filtered for validity
function parseCsv(device, file, setFullDeviceData) {
  Papa.parse(file, {
    download: true,
    header: true,
    skipEmptyLines: true,
    complete: (result) => {
      const parsed = result.data
        .map((row) => {
          const lat = parseFloat(row.latitude?.trim?.() ?? row.latitude);
          const lon = parseFloat(row.longitude?.trim?.() ?? row.longitude);
          const dtStr = row.datetime?.trim?.() ?? row.datetime;
          const dt = new Date(dtStr);
          return { lat, lon, datetime: dt };
        })
        .filter(
          (p) =>
            Number.isFinite(p.lat) &&
            Number.isFinite(p.lon) &&
            p.datetime instanceof Date &&
            !Number.isNaN(p.datetime.getTime())
        );

      // ensure chronological order
      parsed.sort((a, b) => a.datetime - b.datetime);

      setFullDeviceData((old) => ({ ...old, [device]: parsed }));
    },
    error: (err) => {
      console.error(`${device} CSV parse error:`, err);
    },
  });
}

/* ---------- app ---------- */

export default function App() {
  // full data per device from CSV
  const [fullDeviceData, setFullDeviceData] = useState({ device1: [], device2: [] });

  // visibility toggles
  const [visibleDevices, setVisibleDevices] = useState({ device1: true, device2: true });

  // datetime filter state (ISO strings)
  const [startDateTime, setStartDateTime] = useState('');
  const [endDateTime, setEndDateTime] = useState('');

  // load CSVs once on mount
  useEffect(() => {
    parseCsv('device1', DEVICE_FILES.device1, setFullDeviceData);
    parseCsv('device2', DEVICE_FILES.device2, setFullDeviceData);
  }, []);

  // compute filtered data for devices based on datetime filter and visibility
  const filteredDeviceData = useMemo(() => {
    const start = startDateTime ? new Date(startDateTime) : null;
    const end = endDateTime ? new Date(endDateTime) : null;

    const filtered = {};
    for (const device of Object.keys(fullDeviceData)) {
      if (!visibleDevices[device]) {
        filtered[device] = [];
        continue;
      }

      filtered[device] = fullDeviceData[device].filter(({ datetime }) => {
        if (start && datetime < start) return false;
        if (end && datetime > end) return false;
        return true;
      });
    }
    return filtered;
  }, [fullDeviceData, visibleDevices, startDateTime, endDateTime]);

  // calculate map center as average of all visible points or default
  const mapCenter = useMemo(() => {
    let latSum = 0,
      lonSum = 0,
      count = 0;
    for (const device of Object.keys(filteredDeviceData)) {
      if (!visibleDevices[device]) continue;
      filteredDeviceData[device].forEach(({ lat, lon }) => {
        latSum += lat;
        lonSum += lon;
        count++;
      });
    }
    if (count === 0) return [43.5, 16.25]; // default coords if no points
    return [latSum / count, lonSum / count];
  }, [filteredDeviceData, visibleDevices]);

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Controls */}
      <div
        style={{
          padding: '10px',
          background: '#eee',
          display: 'flex',
          gap: '20px',
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <label>
            Start datetime:{' '}
            <input
              type="datetime-local"
              value={startDateTime}
              onChange={(e) => setStartDateTime(e.target.value)}
            />
          </label>
        </div>
        <div>
          <label>
            End datetime:{' '}
            <input
              type="datetime-local"
              value={endDateTime}
              onChange={(e) => setEndDateTime(e.target.value)}
            />
          </label>
        </div>

        <div>
          {Object.keys(DEVICE_FILES).map((device) => (
            <label key={device} style={{ marginLeft: 10 }}>
              <input
                type="checkbox"
                checked={visibleDevices[device]}
                onChange={() =>
                  setVisibleDevices((old) => ({ ...old, [device]: !old[device] }))
                }
              />{' '}
              {device}
            </label>
          ))}
        </div>
      </div>

      {/* Map */}
      <MapContainer center={mapCenter} zoom={13} style={{ flexGrow: 1, width: '100%', height: '100%' }}>
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap contributors" />

        {Object.entries(filteredDeviceData).map(([device, coords]) => {
          const clean = coords.filter(({ lat, lon }) => Number.isFinite(lat) && Number.isFinite(lon));

          // break into segments to avoid straight lines across gaps/teleports
          const segments = segmentByGap(clean, {
            maxTimeGapMs: 5 * 60 * 1000, // 5 minutes
            maxJumpMeters: 200, // tune as needed
          });

          if (segments.length === 0) return null;

          return segments.map((seg, idx) => {
            const latlngs = seg.map(({ lat, lon }) => [lat, lon]);
            return (
              <Polyline
                key={`${device}-${idx}`}
                positions={latlngs}
                color={DEVICE_COLORS[device]}
                weight={3}
              />
            );
          });
        })}
      </MapContainer>
    </div>
  );
}
