# Scored forecast response versions

`GET /forecast/scored` defaults to the installed-client response (`schemaVersion=1`).
Its root fields are `region`, `dates`, `tripDates`, `crags`, `byDate`, `weekendTrip`,
and `today`. Keep these fields and their established types stable. Score/cache
implementation details (`scoreContext`, `dailyContext`) are never public fields.

`GET /forecast/scored?schemaVersion=2` opts into the current extensions. It adds
`schemaVersion: 2` and `forecastMeta` (retrieval time, age, calendar timezone,
staleness and cache source). Per-crag timezone/local-date fields, daylight,
session usability and marine availability fields are also available in version 2.
Never use a root `forecast` key for metadata: it can overlap with legacy envelope
detection. Unsupported or repeated schema versions return HTTP 400.

Both versions use the same scoring calculations, destination-local times,
provider elevation and scored caches. Version 1 serializes recovery progress as
whole completed hours and optional hourly-average/probability fields as integers;
version 2 retains their precise values. Weather measurements and established
fractional window averages (`avg`, `runAvg`) retain their precision in both.
The `X-Climbable-Schema-Version` header identifies the representation. Retrieval
time and stale-data headers remain available in either version.

Every contribution must include `category`, `label`, `delta` and a String
`detail`. The shipped Swift `Contribution.detail` is non-optional: one missing
detail anywhere, including a future date or trip, rejects the entire response.
Serialization repairs missing/null details in saved payloads as well.

Contract tests cover default/explicit version 1, opt-in version 2, shared-cache
reads, all regional and national forecasts, numeric compatibility, private
field isolation, and required fields/types from the native Codable models in
`SendTemps-iOS` (inspected 27 November 2026). The fixture stores only the public
field/type contract. These checks do not replace an on-device rendering test.
