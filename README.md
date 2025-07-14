# GPS Track Visualization App

This React application loads GPS data from CSV files, filters by datetime, and displays device tracks on a Leaflet map. It supports multiple devices with color-coded tracks and datetime filtering.

---

## Features

- Load and parse GPS CSV files for multiple devices
- Filter GPS points by start and end datetime
- Toggle visibility of devices
- Display tracks on an interactive map with color coding
- Logs last few coordinates for debugging

---

## Prerequisites

- [Node.js](https://nodejs.org/) (version 16 or higher recommended)
- [npm](https://www.npmjs.com/) (comes with Node.js)
- Internet connection (for fetching map tiles from OpenStreetMap)

---

## Installation

1. Clone the repository or download the project files:

```bash
git clone git@github.com:mf1999/GPSViewApp.git
cd GPSViewApp

2. Install dependencies:

npm install

3. Start the dev server

npm start
