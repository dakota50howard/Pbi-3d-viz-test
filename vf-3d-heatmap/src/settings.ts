import powerbi from "powerbi-visuals-api";
import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";

const { SimpleCard, Model, NumUpDown, ColorPicker, ToggleSwitch } = formattingSettings;

class ScaleCard extends SimpleCard {
    name = "scale";
    displayName = "Color scale";

    low = new NumUpDown({ name: "low", displayName: "Low (minimum, 0 or more)", value: 0,
        options: { minValue: { value: 0, type: powerbi.visuals.ValidatorType.Min } } });
    medium = new NumUpDown({ name: "medium", displayName: "Medium", value: 5 });
    high = new NumUpDown({ name: "high", displayName: "High", value: 10 });
    critical = new NumUpDown({ name: "critical", displayName: "Critical", value: 15 });
    auto = new ToggleSwitch({ name: "auto", displayName: "Auto-scale to data", value: false });

    lowColor = new ColorPicker({ name: "lowColor", displayName: "Low color", value: { value: "#22A850" } });
    mediumColor = new ColorPicker({ name: "mediumColor", displayName: "Medium color", value: { value: "#F5D90A" } });
    highColor = new ColorPicker({ name: "highColor", displayName: "High color", value: { value: "#F26B3A" } });
    criticalColor = new ColorPicker({ name: "criticalColor", displayName: "Critical color", value: { value: "#D61F2C" } });

    slices = [this.low, this.medium, this.high, this.critical, this.auto,
        this.lowColor, this.mediumColor, this.highColor, this.criticalColor];
}

class LabelsCard extends SimpleCard {
    name = "labels";
    displayName = "Group labels";

    showLabels = new ToggleSwitch({ name: "showLabels", displayName: "Show group labels", value: true });
    showCount = new ToggleSwitch({ name: "showCount", displayName: "Show critical bin count", value: true });
    onlyCritical = new ToggleSwitch({ name: "onlyCritical", displayName: "Only label groups with critical bins", value: false });
    labelSize = new NumUpDown({ name: "labelSize", displayName: "Label size (1 = default)", value: 1 });
    alongGroup = new NumUpDown({ name: "alongGroup", displayName: "Position along group (0 start, 50 middle, 100 end)", value: 50 });
    stagger = new NumUpDown({ name: "stagger", displayName: "Stagger neighbours (0 = off)", value: 1 });
    nudgeUp = new NumUpDown({ name: "nudgeUp", displayName: "Raise labels (cube units)", value: 1.5 });
    nudgeX = new NumUpDown({ name: "nudgeX", displayName: "Move labels along X", value: 0 });
    nudgeY = new NumUpDown({ name: "nudgeY", displayName: "Move labels along Y", value: 0 });

    slices = [this.showLabels, this.showCount, this.onlyCritical, this.labelSize, this.alongGroup, this.stagger, this.nudgeUp, this.nudgeX, this.nudgeY];
}

class LayoutCard extends SimpleCard {
    name = "layout";
    displayName = "Layout";

    cubeSize = new NumUpDown({ name: "cubeSize", displayName: "Largest bin size (0.2 - 1)", value: 0.85 });
    levelSpacing = new NumUpDown({ name: "levelSpacing", displayName: "Level spacing", value: 1.4 });
    showFloor = new ToggleSwitch({ name: "showFloor", displayName: "Show floor", value: true });
    showLegend = new ToggleSwitch({ name: "showLegend", displayName: "Show legend", value: true });
    showAxisLabels = new ToggleSwitch({ name: "showAxisLabels", displayName: "Show axis labels", value: true });
    tipOnly = new ToggleSwitch({ name: "tipOnly", displayName: "Tooltips: only show fields from the Tooltips well", value: false });

    useBinDims = new ToggleSwitch({ name: "useBinDims", displayName: "Use bin length / width / height", value: true });
    dimScale = new NumUpDown({ name: "dimScale", displayName: "Bin size scale (0 = auto)", value: 0 });

    trueCoords = new ToggleSwitch({ name: "trueCoords", displayName: "Use true coordinate spacing", value: true });
    xScale = new NumUpDown({ name: "xScale", displayName: "X scale (0 = auto)", value: 0 });
    yScale = new NumUpDown({ name: "yScale", displayName: "Y scale (0 = auto)", value: 0 });
    zScale = new NumUpDown({ name: "zScale", displayName: "Z scale (0 = auto)", value: 0 });

    slices = [this.cubeSize, this.levelSpacing, this.showFloor, this.showLegend, this.showAxisLabels, this.tipOnly,
        this.useBinDims, this.dimScale, this.trueCoords, this.xScale, this.yScale, this.zScale];
}

export class VisualFormattingSettingsModel extends Model {
    scaleCard = new ScaleCard();
    labelsCard = new LabelsCard();
    layoutCard = new LayoutCard();
    cards = [this.scaleCard, this.labelsCard, this.layoutCard];
}
