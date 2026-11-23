# Forecast comparison API

`GET https://api.sendtemps.app/forecast/compare`

## Query parameters

| Parameter | Required | Meaning |
| --- | --- | --- |
| `cragId` | Yes | Exact ID from the existing crag catalogue, including subcrag IDs. Coordinates and elevation come from the backend catalogue. |
| `date` | Yes | `YYYY-MM-DD`, today through today +2 inclusive in the crag's local timezone. |
| `models` | No | Comma-separated IDs from the table below. Defaults to ECMWF IFS HRES 9 km, GFS Global, ICON Global and UK Met Office Global. One model is supported. Order and duplicate IDs do not affect the cache. Maximum six entries. |

Other parameters and repeated query keys return 400. Send one request per selected date. The response identifies its timezone. Date validation happens before cache lookup, including across midnight.

## Models

| ID | Display name |
| --- | --- |
| `ecmwf_ifs` | ECMWF IFS HRES 9 km (default) |
| `ecmwf_ifs025` | ECMWF IFS 0.25° (optional legacy feed) |
| `gfs_global` | NOAA GFS Global |
| `icon_global` | DWD ICON Global |
| `jma_gsm` | JMA GSM (optional) |
| `ukmo_global_deterministic_10km` | UK Met Office Global 10 km |

JMA GSM and the legacy ECMWF 0.25° feed are available through explicit `models` selections. Existing clients can continue requesting `ecmwf_ifs025`. Clients using the default set should support the new `ecmwf_ifs` ID.

Every returned model includes `id` and `displayName`.

## Authorization

No Authorization header is accepted or required for this endpoint. Pro entitlement is enforced by the iOS interface in this version. The current backend has no subscription verifier. This endpoint is publicly accessible and does not provide server-enforced Pro access. Never embed the Open-Meteo API key or a shared backend secret in iOS. The provider key stays in the Worker environment.

## Example request

```http
GET /forecast/compare?cragId=camels-hump&date=2026-11-23&models=gfs_global
```

## Example success response

Illustrative response with one hour shown. Production responses include all usable hours for the requested date.

```json
{
  "schemaVersion": 1,
  "cragId": "camels-hump",
  "date": "2026-11-23",
  "timezone": "Australia/Melbourne",
  "latitude": -37.38,
  "longitude": 144.59,
  "elevationM": 1000,
  "generatedAt": "2026-11-23T02:30:00.000Z",
  "expiresAt": "2026-11-23T02:50:00.000Z",
  "valueType": "raw_weather",
  "models": [{
    "id": "gfs_global",
    "displayName": "NOAA GFS Global",
    "hours": [{
      "time": "2026-11-23T10:00",
      "temperatureC": 17.2,
      "feelsLikeC": 16.1,
      "humidityPercent": 65,
      "windSpeedKmh": 12.3,
      "windDirectionDegrees": 240,
      "precipitationMm": 0,
      "cloudCoverPercent": 40
    }]
  }],
  "unavailableModels": [],
  "attribution": {
    "name": "Open-Meteo",
    "url": "https://open-meteo.com/",
    "licence": "CC BY 4.0",
    "licenceUrl": "https://creativecommons.org/licenses/by/4.0/"
  }
}
```

Values are normalized raw model weather data in Celsius, km/h, mm and percent. They are not converted into SendTemps scores or wet-rock penalties. `time` is local wall time in the supplied timezone, without a UTC suffix. Rainfall is the preceding-hour total. The API uses Open-Meteo's hourly interpolation where necessary.

Temperature, humidity, wind speed and rainfall must all be finite for an hour to be included. Other fields can be null. A model is returned only if at least one usable hour exists. Models can have different hour counts, so join by time and handle missing hours. `unavailableModels` lists requested models with no usable hours. The backend never substitutes another model's fields. All models unavailable produces 502.

The server cache lasts 20 minutes per crag, date and sorted model set. Responses send `Cache-Control: no-store` to clients and `X-SendTemps-Cache: HIT` or `MISS`. Crag coordinates, elevation and timezone also participate in cache identity. Concurrent identical requests share one upstream call within a Worker isolate. Existing public and provider rate limits apply.

Render the supplied attribution alongside provider names.

## Errors

Endpoint validation/provider errors use this envelope.

```json
{"error":{"code":"invalid_date","message":"date must be between 2026-11-23 and 2026-11-25"}}
```

| HTTP status | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_parameters` | Unsupported or repeated query key. |
| 400 | `invalid_date` | Missing, malformed or out-of-range date. |
| 400 | `invalid_models` | Unsupported, empty or excessive model list. |
| 404 | `unknown_crag` | Missing or unknown crag ID. |
| 405 | `method_not_allowed` | Use GET. OPTIONS supports web CORS preflight. |
| 429 | `rate_limited` | Shared upstream weather budget exhausted. Retry-After is 60 seconds. |
| 502 | `forecast_unavailable` | Provider failure, malformed response or no usable model data. |
| 503 | `crag_unavailable` | Trusted crag location or timezone unavailable. |

The pre-existing public IP limiter can also return HTTP 429 before this handler with `{"error":"Please retry shortly"}` and `Retry-After: 60`. Clients should handle status first and allow either error envelope. Errors are not cached. There are no 401/403 entitlement responses in this version.
