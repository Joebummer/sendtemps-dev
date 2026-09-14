# Feels-like heat scoring

All server-scored crags receive a continuous heat constraint above 21°C feels-like:
four points per degree, capped at 40 points. Existing lower ideal-temperature
limits and air-temperature heat caps remain unchanged.

For explicitly identified hot-weather venues, the feels-like constraint is
1.5 points per degree from 21 to 26°C, then four points per degree above 26°C,
also capped at 40. This is a calibration choice, not a measured rock temperature.

The engine takes the stronger of air heat (distance above the ideal maximum
plus ambient heat) and feels-like heat. It retains separate cold and solar
penalties. Wind and humidity already influence feels-like; no cooling bonus is
added. Rock wetness, humidity, wind and solar effects retain their existing rules.

Hourly and daily scoring use the same calculation. Daily comfort penalties are
averaged from individual climbing-hour samples, not calculated from mean
temperature. Existing time-outside-local-ideal penalties are retained. Bonuses
cannot erase the combined temperature constraint.

## Explicit lighter profiles

User-confirmed: Camel's Hump, The Balcony, King Rat Gully, Central Gully Right,
The Ravine, and West Flank. The Ravine retains all-day relief following the
user's firsthand confirmation of near-all-day shade. West Flank receives the
lighter profile only before 12:00. Boronia receives it from 17:00. These are conservative
calibration windows in the forecast's existing climbing-hour time basis, not
measured sun-arrival times. Unknown or invalid time receives the standard
penalty. Boronia retains ideal [10, 20] and heatCap 23; air heat can still dominate.
See [the evidence audit](hot-weather-evidence.md) for confidence and limitations.

Catalogue-supported shaded candidates: Henry Bolte Wall, Pharos Back Wall,
Grotto Wall, The Bluffs South Side, and Mt York Shady Side. These are provisional
calibrations from the audit, not independently measured microclimates. The
profile lightens only the new comfort constraint; it does not waive solar heat,
local air-temperature limits or closures. Camel's Hump is currently one combined
record; no unreviewed descendants inherit profiles.

Bell Supercrag, The Freezer, Colosseum Cave and other uncertain/mixed candidates
receive the standard profile pending sector, aspect or mapping verification.
Central Gully Left and shaded bouldering areas are not automatically exempt.

The warmWeatherRelief catalogue field accepts light, morning, afternoon,
late-afternoon or evening. Morning ends at 12:00; afternoon starts at 12:00,
late-afternoon at 16:00 and evening at 17:00. All windows use the existing
forecast local-hour basis and reject missing/invalid hours. Missing
values mean standard behaviour. Both catalogue copies carry the metadata, but
the legacy web scoring implementation is unchanged.

Tests cover the 21°C boundary, stronger heat, light profiles, morning expiry, evening onset,
missing hourly detail, overlapping penalties, solar/wind effects, brief heat,
Westside regression fixtures and Blue Mountains cold edges.

## Confirmed sector follow-up

The Freezer uses afternoon relief and elevation 1,009 m, confirmed by the user.
Its description places it near Cosmic County in the Dargan Creek area. Preserve
ideal 10–26 and air heat cap 28. The existing lapse adjustment changes from
-1.04°C to -3.9585°C, once before both hourly and daily scoring. This is a
correction to the catalogue input, not a new elevation model.

Bell Shady Side receives light relief. Bell Sunny Side receives evening relief.
The combined Bell record now has mixed shade and remains on standard heat
scoring. Lower Tribute receives late-afternoon relief. Upper Tribute has its
own record and shade description but retains standard heat scoring until its
earlier shade window can be established. Original ideal bands and heat caps are
copied to the new sectors without widening them. Keep the existing combined
IDs for favourites, with the four new sector IDs under the established Blue
Mountains/Grampians destination hierarchy.

These relief windows are conservative calibration choices; they do not replace
the solar geometry model with measured shadow maps. The Freezer's previously
unverified S aspect is now mixed/unknown, and it is no longer marked all-day
shade. No new bearing was inferred solely from its summer suitability.
