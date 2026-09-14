# Temperature scoring calibration

The backend uses one temperature curve for hourly scores and daily averages.
The web app's local scoring copy is deliberately unchanged in this update.

- Cold (feels-like temperature): 2.5 points per degree for the first 5 degrees below the crag's ideal minimum, then 6 points per degree, capped at 80.
- Heat (air temperature): 4 points per degree above ideal, capped at 40.
- Explicit heat caps: ambient heat adds 1.5 points per degree above the cap (maximum 25); solar heat adds up to 1.5 points per degree, scaled by cloud, wall illumination and exposure. Combined ambient/solar maximum: 40.
- Without a heat cap, only the solar component is added above the ideal maximum.
- Daily penalties average the hourly penalties across the configured climbing window. A brief peak has less influence than sustained heat. Overnight temperatures are excluded.
- Existing dwell-time penalties remain, but the target cannot exceed the available climbing hours.
- A score ceiling protects the temperature penalty from unrelated bonuses. Daily breakdowns explain when the ceiling applies.
- The existing elevation correction is applied exactly once, before hourly strips, range counts and daily means. This retains the existing elevation assumption; it does not independently validate its physical accuracy.

These are product calibration choices, not measured rock temperatures or safety thresholds.
The daily score remains a whole-window assessment. A shorter evening window can legitimately score better.
Hourly cells display air temperature. Heat/friction penalties and heat caps use air temperature; cold discomfort uses apparent (feels-like) temperature. Daily scores average those same per-hour penalties. Range counts classify hot air first, then cold feels-like, with the remainder in range. Missing temperature values fall back to the available reading.
The native client must compare the same crag/subcrag when presenting daily and hourly scores.

Regression coverage includes all 28 Blue Mountains records at -5, 0, 5, 10, 15, 20 and 25 degrees, bonus protection, overnight frost, brief versus sustained heat, missing data, all 319 crags, elevation consistency through the forecast pipeline, and Westside evening heat.
