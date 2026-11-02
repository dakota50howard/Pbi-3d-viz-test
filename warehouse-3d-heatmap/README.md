# Warehouse 3D Heatmap (Power BI custom visual)

Each data row becomes a cube at an X / Y / Z position, colored by a measure
(e.g. inventory) using a 4-stop gradient (Low / Medium / High / Critical).

## Build
```
npm install
npm start          # dev server, use with "Developer visual" in Power BI Service
npm run package    # produces dist/*.pbiviz to import into Power BI
```
If the toolchain complains about versions, run `pbiviz new MyVisual`, then copy
`src/`, `style/`, `capabilities.json` and `assets/icon.png` over the generated project
and `npm i three @types/three`.

## Fields
- **X (column)**, **Y (row)**: floor grid position
- **Z (level)**: vertical stacking (optional)
- **Value**: measure that drives color
- **Tooltips**: extra fields shown on hover

## Format pane
- Color scale: thresholds and colors for Low / Medium / High / Critical
- Layout: cube size, level spacing, floor, legend

Controls: drag to orbit, wheel to zoom, right-drag to pan, click a cube to cross-filter (Ctrl+click for multi-select).
