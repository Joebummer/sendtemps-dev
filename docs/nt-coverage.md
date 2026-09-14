# Northern Territory coverage

Adds three Top End destinations and nine named subcrags (12 records), identical in the client and Worker databases. Totals are 319 records and 79 parent destinations. NT is automatically recognised by the scored API because its supported-region set is derived from the Worker database. The web region selector, alert coordinate lookup, client asset versions, scored cache version, marketing coverage list and coverage map are updated together.

## Sources and forecast locations

The [Top End Rock guide (2006–2007)](https://www.chockstone.org/nt/topendalternativeclimbingguide.pdf), pages 7, 28–37 and 39–44, documents the three sandstone destinations and these sectors:

- Robin Falls: Right Hand Side and Left Hand Side.
- Hayes Creek: Right Hand Side, Upper Right Hand Side, Left Hand Side and Spider Gully.
- Umbrawarra Gorge: First Pool, Second Pool Left Hand Side and Second Pool Right Hand Side.

The guide establishes climbing history and sector names, not current access. No route descriptions have been copied.

| Destination | Representative forecast point | Latitude | Longitude | Terrain elevation (m) |
| --- | --- | --- | --- | --- |
| Robin Falls | Registered waterfall location | -13.3541 | 131.13009 | 160 |
| Hayes Creek | Registered Hayes Creek Inn location | -13.583307 | 131.457962 | 134 |
| Umbrawarra Gorge | Published nature-park location | -13.971414 | 131.689301 | 226 |

Robin Falls and Hayes Creek coordinates come from the NT Place Names Register: [waterfall](https://www.ntlis.nt.gov.au/placenames/view.jsp?id=18040) and [inn](https://www.ntlis.nt.gov.au/placenames/view.jsp?id=13485). Umbrawarra's published ExplorOz nature-park point agrees, within metres, with the [published park coordinates](https://en.wikipedia.org/wiki/Umbrawarra_Gorge_Nature_Park).

Elevations were queried from the [Open-Meteo elevation API](https://open-meteo.com/en/docs/elevation-api) on 14 September 2026. Requests:

- `latitude=-13.3541&longitude=131.13009` returned `[160.0]`.
- `latitude=-13.583307,-13.971414&longitude=131.457962,131.689301` returned `[134.0,226.0]`.

These are area weather points, not independently surveyed cliff or belay positions. All sectors share their parent's coordinates and terrain elevation. The Hayes point is at the approach landmark, not the climbing walls; Robin Falls is at the waterfall, not the slabs. In-app notes disclose the representative location. Better verified sector pins can replace these later without changing IDs. Terrain-model elevations on steep ground may differ substantially from the actual belay height.

## Access

The current [Hayes Creek listing](https://www.thecrag.com/en/climbing/australia/hayes-creek) reports that access is closed. This notice is present on the parent and all four children.

The [Umbrawarra listing](https://www.thecrag.com/en/climbing/australia/umbrawarra-gorge) reports climbing only at First Pool. Both historical Second Pool sectors explicitly say climbing is reported not permitted. Older sources disagree on permits and permitted pools, so no old permit rule, fee or phone number is presented as current. Records direct users to NT Parks to confirm current requirements.

The [official park page](https://nt.gov.au/parks/find-a-park/umbrawarra-gorge-nature-park) supplies the ranger contact (08 8999 4555) and wet-season road information. Park opening is not evidence of climbing permission.

Access notices follow the existing data model: they do not remove a location from weather rankings or prevent alerts. A conditions score is not access clearance.

## Modelling and scope

Aspect is `mixed` and shade is `variable` because compass orientations have not been verified. Dryness rating 3, ideal temperature 12–24°C, travel times from Darwin and trip category are initial modelling estimates. They are not measured observations or new scoring rules. No historical NT climate profile has been invented; the existing scorer's fallback applies. Existing forecast date/time handling is unchanged, including its Melbourne calendar convention.

This is initial Top End coverage, not a claim that every NT climbing area is catalogued. Gilmour River, Butterfly Gorge and Central Australian areas remain outside this addition pending reliable location and area-level verification.

## Verification

The real NT scoring pipeline is included in the existing response-contract, trip-equivalence and cache tests using fixed-clock synthetic weather. Data validation covers every parent and child in both databases. Coverage checks include NT counts, identical NT data and access notices. Existing records and scoring formulas are unchanged.
