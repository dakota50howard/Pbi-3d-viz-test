# VF 3D Heatmap (Power BI custom visual)

Bins are drawn as boxes at X / Y / Z positions, sized by length / width / height and colored by a metric.

## Build
```
npm install
npm run package    # creates dist/*.pbiviz
```

## Fields
X, Y, Z (level), Value (measure), Metric name (measure, optional), Bin length / width / height (optional),
Category Filter 1-3, Grouping 1-3 (for 3D group labels), Tooltips.

## Color scale
One set of Low / Medium / High / Critical thresholds (Low is never below 0), or auto-scale to the data.
The optional "Metric name" well only sets the legend title.

## In-visual controls
Filters (search + Dim/Hide), View (Plan / Front / Side / Reset), Levels shown (From / To sliders).

## Group labels
Put a column such as Zone, Aisle or SKU type in a Grouping well. A label floats above each group showing its name and
(optionally) how many bins are at or above the Critical threshold. Choose which grouping is shown from the View card.
In edit mode, drag a label to move it; positions are saved with the report. The Group labels card has nudge settings,
a count on/off switch, label size and "only label groups with critical bins".
