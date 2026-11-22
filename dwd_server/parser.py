import logging
import urllib.request
import zipfile
from io import BytesIO
import xml.etree.ElementTree as ET
from pydantic import BaseModel

logger = logging.getLogger("dwd_server.parser")

class WeatherForecast(BaseModel):
    station_id: str
    station_name: str
    coordinates: list[float]
    issue_time: str
    timesteps: list[str]
    elements: dict[str, list[float | None]]

def fetch_and_parse(station_id: str) -> WeatherForecast | None:
    url = f"https://opendata.dwd.de/weather/local_forecasts/mos/MOSMIX_L/single_stations/{station_id}/kml/MOSMIX_L_LATEST_{station_id}.kmz"
    logger.info(f"Fetching DWD MOSMIX KMZ from: {url}")
    
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'DwdWeatherModernizer/1.0'})
        with urllib.request.urlopen(req, timeout=15) as response:
            kmz_data = response.read()
    except Exception as e:
        logger.error(f"Failed to download DWD forecast for station {station_id}: {e}")
        return None

    try:
        with zipfile.ZipFile(BytesIO(kmz_data)) as z:
            kml_filename = z.namelist()[0]
            kml_content = z.read(kml_filename)
    except Exception as e:
        logger.error(f"Failed to decompress KMZ for station {station_id}: {e}")
        return None

    try:
        root = ET.fromstring(kml_content)
    except Exception as e:
        logger.error(f"Failed to parse KML XML for station {station_id}: {e}")
        return None

    # Namespace definitions
    namespaces = {
        'kml': 'http://www.opengis.net/kml/2.2',
        'dwd': 'https://opendata.dwd.de/weather/lib/pointforecast_dwd_extension_V1_0.xsd'
    }

    doc = root.find('kml:Document', namespaces)
    if doc is None:
        logger.error("Could not find Document element in KML")
        return None

    # Parse IssueTime
    issue_time_node = doc.find('.//dwd:IssueTime', namespaces)
    issue_time = issue_time_node.text if issue_time_node is not None and issue_time_node.text else ""

    # Parse Timesteps
    timesteps: list[str] = []
    timesteps_container = doc.find('.//dwd:ForecastTimeSteps', namespaces)
    if timesteps_container is not None:
        for ts in timesteps_container.findall('dwd:TimeStep', namespaces):
            if ts.text:
                timesteps.append(ts.text)

    num_timesteps = len(timesteps)
    if num_timesteps == 0:
        logger.error("No timesteps found in forecast KML")
        return None

    # Parse Placemark Info (Station Info)
    placemark = doc.find('kml:Placemark', namespaces)
    if placemark is None:
        logger.error("Could not find Placemark element in KML")
        return None

    station_name = ""
    desc_node = placemark.find('kml:description', namespaces)
    if desc_node is not None and desc_node.text:
        station_name = desc_node.text.strip()

    coordinates: list[float] = [0.0, 0.0, 0.0]
    point_node = placemark.find('kml:Point', namespaces)
    if point_node is not None:
        coords_node = point_node.find('kml:coordinates', namespaces)
        if coords_node is not None and coords_node.text:
            coords_str = coords_node.text.strip().split(',')
            if len(coords_str) >= 2:
                try:
                    # coordinates in KML are lon,lat,height.
                    # We store them as [lon, lat, height]
                    coordinates = [
                        float(coords_str[0]),
                        float(coords_str[1]),
                        float(coords_str[2]) if len(coords_str) > 2 else 0.0
                    ]
                except ValueError:
                    pass

    # Parse Forecast Elements
    elements_of_interest = {'TTT', 'SunD1', 'wwP', 'DRR1', 'RR1c', 'R101', 'RRS1c'}
    elements_data: dict[str, list[float | None]] = {}

    ext_data = placemark.find('kml:ExtendedData', namespaces)
    if ext_data is not None:
        for fc in ext_data.findall('dwd:Forecast', namespaces):
            elem_name = fc.get('{https://opendata.dwd.de/weather/lib/pointforecast_dwd_extension_V1_0.xsd}elementName')
            if elem_name in elements_of_interest:
                val_node = fc.find('dwd:value', namespaces)
                if val_node is not None and val_node.text:
                    raw_vals = val_node.text.split()
                    parsed_vals: list[float | None] = []
                    for val in raw_vals:
                        if val == '-' or val == '-----':
                            parsed_vals.append(None)
                        else:
                            try:
                                parsed_vals.append(float(val))
                            except ValueError:
                                parsed_vals.append(None)
                    
                    # Pad or truncate to match timesteps
                    if len(parsed_vals) < num_timesteps:
                        parsed_vals += [None] * (num_timesteps - len(parsed_vals))
                    elif len(parsed_vals) > num_timesteps:
                        parsed_vals = parsed_vals[:num_timesteps]

                    elements_data[elem_name] = parsed_vals

    # Ensure all elements of interest have lists even if missing from KML
    for elem in elements_of_interest:
        if elem not in elements_data:
            elements_data[elem] = [None] * num_timesteps

    return WeatherForecast(
        station_id=station_id,
        station_name=station_name,
        coordinates=coordinates,
        issue_time=issue_time,
        timesteps=timesteps,
        elements=elements_data
    )
