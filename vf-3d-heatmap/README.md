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

## Color scale
One set of Low / Medium / High / Critical thresholds (Low is never below 0), or auto-scale to the data.
The optional "Metric name" well only sets the legend title.

## In-visual controls
Filters (search + Dim/Hide), View (Plan / Front / Side / Reset), Levels shown (From / To sliders).
