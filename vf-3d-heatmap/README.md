# VF 3D Heatmap (Power BI custom visual)

Bins are drawn as boxes at X / Y / Z positions, sized by length / width / height and colored by a metric.

## Build
```
npm install
npm run package    # creates dist/*.pbiviz
```

## Fields
X, Y, Z (level), Value (measure), Metric name (measure, optional), Bin length / width / height (optional),
Category Filter 1-3, Tooltips.

## Color profiles
Add a measure such as `Metric Name = SELECTEDVALUE('Metric Selector'[Metric], "Total Units")` to the
"Metric name" well. Profile 1-3 in the format pane apply their thresholds when their name matches it exactly.
No match = default Color scale. Each can auto-scale to the data instead.

## In-visual controls
Filters (search + Dim/Hide), View (Plan / Front / Side / Reset), Levels shown (From / To sliders).
