The project in `OldVersion` shall be modernized.

It accesses the freely available German weather information published by DWD and prints a forecast graphics.

We want to streamline this old version:

- generate a server that caches DWD weather information and prevents unnecessary requests to the DWD servers: Weather information is only requested on demand (no polling), and a config parameter limits how often the information is updated (hard minimal limit: at least 1800 sec between updates).
- Only weather information for one location (default station-id 10865) is maintained via config parameter
- The server exposes a REST interface that allows various clients to get forecast information.
- A web-based visualization is provided, is displays near-term forecasts in higher time-resolution than longer term forecasts

Please research the latest APIs of DWD (see `OldVersion/README.md` for starting points)

