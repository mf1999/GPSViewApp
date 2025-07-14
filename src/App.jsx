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

function parseCsv(device, file, setFullDeviceData) {
  Papa.parse(file, {
    download: true,
    header: true,
    skipEmptyLines: true,
    complete: (result) => {
      const parsed = result.data
        .map((row) => {
          const lat = parseFloat(row.latitude?.trim());
          const lon = parseFloat(row.longitude?.trim());
          const dt = new Date(row.datetime?.trim());
          return { lat, lon, datetime: dt };
        })
        .filter(
          (p) =>
            !isNaN(p.lat) &&
            !isNaN(p.lon) &&
            p.datetime instanceof Date &&
            !isNaN(p.datetime.getTime())
        );
      setFullDeviceData((old) => ({ ...old, [device]: parsed }));
    },
    error: (err) => {
      console.error(`${device} CSV parse error:`, err);
    },
  });
}

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
      <div style={{ padding: '10px', background: '#eee', display: 'flex', gap: '20px', alignItems: 'center' }}>
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

      <MapContainer
        center={mapCenter}
        zoom={13}
        style={{ flexGrow: 1, width: '100%', height: '100%' }}
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution="&copy; OpenStreetMap contributors"
        />
        {Object.entries(filteredDeviceData).map(([device, coords]) => {
  const latlngs = coords
  .filter(({ lat, lon }) => !isNaN(lat) && !isNaN(lon))
  .map(({ lat, lon }) => [lat, lon]);

  console.log(`Device: ${device}`);
  console.log('Last 3–4 drawn coords:', latlngs.slice(-4));

  return (
    <Polyline
      key={device}
      positions={latlngs}
      color={DEVICE_COLORS[device]}
      weight={3}
    />
  );
})}
      </MapContainer>
    </div>
  );
}
