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
The Group labels card has position-along-group and stagger settings (to reduce clutter), nudge settings, a count on/off
switch, label size and "only label groups with critical bins".

## Walk mode (hidden)
A very faint dot sits in the bottom-right corner of the visual (it brightens when you hover it). Click it to walk the
warehouse: W A S D to move, mouse to look (or hold the mouse button and drag if the host blocks pointer lock), Esc to exit.
You cannot walk through bins; levels above head height can be walked under. A dot crosshair shows tooltips for what you look at.
