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
The Ravine, and West Flank. West Flank receives the lighter profile only before
12:00 in the forecast's existing climbing-hour time basis; unknown time receives
the standard penalty.

Catalogue-supported shaded candidates: Henry Bolte Wall, Pharos Back Wall,
Grotto Wall, The Bluffs South Side, and Mt York Shady Side. These are provisional
calibrations from the audit, not independently measured microclimates. The
profile lightens only the new comfort constraint; it does not waive solar heat,
local air-temperature limits or closures. Camel's Hump is currently one combined
record; no unreviewed descendants inherit profiles.

Bell Supercrag, The Freezer, Colosseum Cave and other uncertain/mixed candidates
receive the standard profile pending sector, aspect or mapping verification.
Central Gully Left and shaded bouldering areas are not automatically exempt.

The warmWeatherRelief catalogue field accepts only light or morning. Missing
values mean standard behaviour. Both catalogue copies carry the metadata, but
the legacy web scoring implementation is unchanged.

Tests cover the 21°C boundary, stronger heat, light profiles, morning expiry,
missing hourly detail, overlapping penalties, solar/wind effects, brief heat,
Westside regression fixtures and Blue Mountains cold edges.
