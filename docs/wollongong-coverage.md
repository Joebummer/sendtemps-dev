# Wollongong / Illawarra coverage

Adds three NSW destinations and ten named sectors to the production Worker catalogue. Mount Keira has West Face and South Face; Scarborough Cliffs has Whale of a Time Wall, Kenny’s Wall and Obesity Buttress / Big Fat Fin Slappers; Coalcliff has The Post Office, The Quarterdeck, Powerline Lookout, Ships Prow and Sun Village.

All thirteen records have numeric elevations and existing-schema parent links. Each destination has its own `area` and `AREAS` entry. NSW remains the API region; this does not add a new mobile region-filter value. The scored API carries all records and selects the best child for destination headlines and hourly strips. The native Xcode project is not in this repository, so native rendering is not tested here.

The deprecated web-app catalogue and unrelated scoring drift are outside this backend release. No existing crag record, scoring formula, climate baseline, rain threshold or API protection is changed. `SCORED_CACHE_VERSION` is bumped so the release cannot reuse a regional catalogue cached by the previous deployment.

## Location and elevation evidence

Sources were checked on 20 October 2026. Map and route positions are representative forecast points, not surveyed belays or approach instructions. Parent locations represent an included sector to avoid an unnecessary extra weather location.

| Record / representative point | Latitude | Longitude | Elevation (m) | Basis |
| --- | --- | --- | --- | --- |
| Keira parent / West Face | -34.402670 | 150.854010 | 425 | OSM climbing point; terrain estimate |
| Keira South Face | -34.4041221 | 150.8536520 | 431 | OSM climbing point; terrain estimate |
| Scarborough parent / Whale of a Time Wall | -34.262310 | 150.960480 | 310 | Published Mountain Project sector location and elevation |
| Kenny’s Wall | -34.262864 | 150.959788 | 349 | Published sector map point; terrain estimate |
| Obesity Buttress | -34.263070 | 150.959440 | 349 | Published Big Fat Fin Slappers route location; terrain estimate |
| Coalcliff parent / Powerline Lookout | -34.242713 | 150.966466 | 281 | Published theCrag partner map point; terrain estimate |
| The Post Office | -34.246801 | 150.962172 | 279 | Published partner map point; terrain estimate |
| The Quarterdeck | -34.245285 | 150.962531 | 286 | Published crag coordinate in the guide; terrain estimate |
| Ships Prow | -34.242150 | 150.967153 | 291 | Published partner map point; terrain estimate |
| Sun Village | -34.250389 | 150.967394 | 253 | Published partner map point; terrain estimate |

Terrain estimates were retrieved from [Open-Meteo’s elevation API](https://open-meteo.com/en/docs/elevation-api) on 20 October 2026, using Copernicus DEM GLO-90 at 90 m resolution ([DOI](https://doi.org/10.5270/ESA-c5d3d65)). At Whale of a Time Wall the DEM returns 344 m; the explicitly published climbing-sector value of 310 m is retained instead. The Post Office guide also gives an approach coordinate about 50 m from its sector map pin; this record uses the sector map pin. Terrain values can blend cliff tops and slopes, so these remain estimates and should be refined with local evidence when available.

Sources:

- [theCrag – Mount Keira](https://www.thecrag.com/en/climbing/australia/wollongong/mt-keira): established West and South Faces and Summit Park / Dave Walsh Track approach.
- [Mount Keira West Face, OSM-derived Mapcarta point](https://mapcarta.com/N1525910745) and [OSM South Face node](https://www.openstreetmap.org/node/1525910742). © OpenStreetMap contributors.
- [theCrag – Scarborough Cliffs](https://www.thecrag.com/en/climbing/australia/wollongong/area/351925620): sector names and generally southerly aspects/morning sun.
- [Mountain Project – Whale of a Time Wall](https://www.mountainproject.com/area/125750754/whale-of-a-time-wall) and [Scarborough overview](https://www.mountainproject.com/area/125750743/scarborough-cliffs): location, elevation and southeast-facing escarpment description.
- [theCrag – Kenny’s Wall](https://www.thecrag.com/en/climbing/australia/wollongong/area/1124667354): map coordinate and explicitly east-facing wall.
- [theCrag – Obesity Buttress](https://www.thecrag.com/en/climbing/australia/wollongong/area/3353344581) and [Big Fat Fin Slappers](https://www.thecrag.com/en/climbing/australia/wollongong/route/2565164712): sector identity, location south of Kenny’s Wall and representative route coordinate.
- [theCrag – The Quarterdeck](https://www.thecrag.com/en/climbing/australia/wollongong/area/7498960179): explicit crag coordinate, morning sun and broad area south of Powerline Lookout.
- theCrag partner content on Outdooractive: [The Post Office](https://www.outdooractive.com/en/climbingspot/cliff/the-post-office/263817522/), [Powerline Lookout](https://www.outdooractive.com/en/climbingspot/sector/powerline-lookout/227354650/), [Ships Prow](https://www.outdooractive.com/en/climbingspot/sector/ships-prow/227354638/) and [Sun Village](https://www.outdooractive.com/en/climbingspot/crag/sun-village/263222430/). Partner copies can lag the live guide. [Live Powerline guide](https://www.thecrag.com/en/climbing/australia/wollongong/area/635001255) documents morning sun.

## Conditions and initial calibration

Known aspects use the existing geometric sun and directional-wind calculations: Keira West W, Keira South S, Whale of a Time Wall SE and Kenny’s Wall E. Other sectors deliberately use `mixed` rather than an invented bearing. No unverified fixed shade-start hour or all-day-shade exemption is assigned. Guide descriptions of morning sun are retained in the relevant notes and shade metadata.

The initial temperature band is 10–19°C, with a 20°C heat cap, using the existing cool NSW sandstone profile as a planning baseline. This is a starting calibration for climbing quality, not a measured site-specific ideal. Dry ratings are initially 3, except the wind-sheltered, rain-exposed Post Office at 2. Exposure metadata is an initial planning judgement; it does not introduce a new physical shelter model.

The Post Office’s documented wind shelter is explained in its notes. The current engine calculates wind shelter from aspect and direction; it does not quantify additional terrain shelter at a mixed-aspect wall. Sun Village’s reported rain shelter and Ships Prow’s overhangs are advisory notes only. All sectors retain the existing wet-sandstone protection, including the 1 mm rain-event threshold. No rain immunity or marine-wave hazard is inferred from these descriptions. New crags use the existing climate-profile fallback; no historical baseline is invented.

## Access

The [NPWS Illawarra Escarpment plan, January 2023 amendment](https://www.environment.nsw.gov.au/sites/default/files/illawarra-escarpment-state-conservation-area-plan-management-230059.pdf), printed pp. 26 and 29, permits climbing in the conservation area on Mount Keira’s west/south cliffs and cliffs north of Bulli Pass. All records carry an access notice requiring established approaches and current closure checks. The Keira scope is limited to West Face and South Face; other faces and bouldering areas are not added.

The [NPWS alerts page](https://www.nationalparks.nsw.gov.au/visit-a-park/parks/illawarra-escarpment-state-conservation-area/local-alerts), checked on 20 October 2026, lists Byarong Park access to the Keira Ring Track closed until 23 October, Sublime Point Walking Track closed until 30 November, and rehabilitation closures on unauthorised bike trails. These are approach-specific notices, not grounds to set all climbing records `closedAll`. The app uses a lasting instruction to check current alerts rather than a dated closure notice that would remain after expiry. A weather score is not access clearance.

## Validation

The deployment workflow runs the crag contract validator, the existing API-protection checks and targeted Wollongong integration checks. New checks exercise the real NSW scored response, all thirteen records, best-child destination hourly strips, one batched weather request, and the 0.2 mm / 1 mm sandstone threshold.

Before changes, `npm run check` had 108 passing and 16 failing tests. The existing failures cover legacy client/backend catalogue parity, trip-score equivalence expectations and older temperature-scoring expectations. Preserve the measured baseline; do not change live scoring or the deprecated web catalogue to make this data release pass those unrelated assertions. Verify the same failure set after implementation, and inspect the production deployment and live NSW response separately.

Local release validation: 352 Worker records and 323 legacy web records pass the contract validator; all 339 existing Worker records are unchanged; the three Wollongong integration checks and all 50 API-protection checks pass. The full suite reports 111 passing and the same 16 pre-existing failures, with no new failures.
