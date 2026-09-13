# Canberra coverage additions

This update adds six destinations and 19 records. It reclassifies the existing Booroomba destination and its two sectors from NSW to ACT without changing their IDs or scoring parameters. Totals: 307 records, 76 parent destinations; ACT 6, NSW 20, VIC 15, TAS 10, QLD 5, SA 7, WA 13.

Mount Coree is included in the Canberra collection but classified as NSW: the mapped walls lie west of the territory border. Tora Bora is pending a trustworthy map pin; the CCA guide gives an approach description but no verified coordinates. Do not substitute a similarly named overseas crag.

## Sources and location accuracy

- [Canberra Climbers Association visitor information](https://canberraclimbing.org.au/visitor-information/): regional venues.
- [Orroral Ridge guide](https://canberraclimbing.org.au/climbing-guides/orroral-ridge/) and [georeferenced climbing map](https://daneevans.github.io/static_host/data/Canberra/October-22.pdf): named sectors; coordinates interpolated from the map georeferencing. Parent location represents Tower Rocks.
- [Gibraltar Peak guide](https://canberraclimbing.org.au/climbing-guides/gibraltar-peak/): setting and climbing. [Mapped crag](https://mapcarta.com/N13807556124), [Nailbiter Spike](https://www.thecrag.com/en/climbing/australia/gibraltar-peak-and-corin-road-crags/area/12281821): locations. Ape Area uses the published Ape Escape route location.
- [Snake Rock](https://www.thecrag.com/en/climbing/australia/gibraltar-peak-and-corin-road-crags/snake-rock): main location. CCA Snake Rock guide names The Tiers, The Amphitheatre and The Buttress. These compact sectors share the representative main-crag weather point and elevation; they are not separately surveyed pins.
- [Mount Coree guide](https://canberraclimbing.org.au/climbing-guides/mt-coree-hollywood/): sectors and seasonal exposure. Wind Wall uses the [Super Jesus route location](https://www.thecrag.com/en/climbing/australia/mount-coree/route/12297049); Sun Wall uses Golden Age and The Lime uses Lime Tree Arbor published route locations. The parent represents Wind Wall.
- [River crags guide](https://canberraclimbing.org.au/climbing-guides/river-crags/): Red Rocks and Kambah setting, sun and access. Red Rocks uses the published Murrumbidgee climbing-area point, a representative gorge forecast location, not the precise cliff approach. [Kambah Rocks](https://www.ukclimbing.com/logbook/crags/kambah_rocks-17487/): coordinates, rhyolite and southeast aspect.
- [Parks ACT climbing information](https://www.parks.act.gov.au/things-to-do/climbing): peregrine restrictions. Red Rocks has an explicit 1 August to 31 December closure notice. An access notice does not suppress weather scoring; a weather score is not an access clearance.
- [Tora Bora guide](https://canberraclimbing.org.au/climbing-guides/tora-bora/): pending location verification.

All new elevations are numeric terrain estimates in metres from the [Open-Meteo elevation API](https://open-meteo.com/en/docs/elevation-api), queried at the stored coordinates on 13 September 2026. They describe representative forecast terrain, not surveyed belay heights. Nearby points can return different terrain heights on steep slopes. Existing Booroomba elevations are preserved.

| Location | Latitude | Longitude | Elevation (m) |
| --- | --- | --- | --- |
| Tower Rocks / Orroral parent | -35.60435 | 148.95090 | 1347 |
| Belfry | -35.61045 | 148.95893 | 1362 |
| Legoland | -35.60044 | 148.94662 | 1323 |
| Trojan Wall | -35.59471 | 148.94301 | 1319 |
| Cloisters | -35.61217 | 148.95933 | 1351 |
| Gibraltar parent | -35.45835 | 148.94762 | 1033 |
| Ape Area | -35.45828 | 148.94776 | 983 |
| Nailbiter Spike | -35.458479 | 148.947836 | 1033 |
| Snake Rock and sectors | -35.479142 | 148.953291 | 816 |
| Wind Wall / Coree parent | -35.30608 | 148.81079 | 1334 |
| Sun Wall | -35.30966 | 148.80768 | 1312 |
| The Lime | -35.30989 | 148.80730 | 1255 |
| Red Rocks forecast point | -35.407564 | 149.034809 | 562 |
| Kambah Rocks | -35.405737 | 149.027247 | 539 |

Temperature preferences, dryness ratings and travel times are initial planning estimates. Mixed aspects deliberately avoid unsupported route-level precision. New destinations use the existing scoring fallback where no historical climate profile exists; no historical baseline has been invented. Rhyolite uses the existing generic rock-drying fallback. Client and worker additions are identical; unrelated pre-existing differences between the databases are preserved.
