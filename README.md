# DWD Weather Hub

A modernized, highly interactive German Weather Service (Deutscher Wetterdienst - DWD) weather forecast server and visualization dashboard.

## Features
- **Lightweight FastAPI Backend**: Fetches and decompresses DWD MOSMIX forecast KML data on-demand and caches it locally.
- **Interactive SPA Dashboard**: Renders weather datasets (temperature, rain probability, sunshine duration, etc.) using a uniform time-scale chart powered by Chart.js.
- **Local Sensor Integration**: Subscribes to local MQTT brokers to overlay real-time temperature sensor measurements (10-minute downsampled intervals) on the forecast timeline.
- **Persistent State**: Automatically saves and reloads MQTT sensor history across server restarts.
- **Systemd & Arch Packaging**: Configured with a systemd service descriptor and a PKGBUILD script for easy installation on Arch Linux.

---

*Note: This modernized codebase was developed and written by the Google DeepMind AI coding agent, **Antigravity**.*
