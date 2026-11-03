import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";

const { SimpleCard, Model, NumUpDown, ColorPicker, ToggleSwitch, TextInput } = formattingSettings;

class ScaleCard extends SimpleCard {
    name = "scale";
    displayName = "Color scale (default)";

    low = new NumUpDown({ name: "low", displayName: "Low (minimum)", value: 0 });
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

// One color profile per metric. It is used when the "Metric name" field matches its name.
class ProfileCard extends SimpleCard {
    declare name: string;
    declare displayName: string;
    metricName!: formattingSettings.TextInput;
    low!: formattingSettings.NumUpDown;
    medium!: formattingSettings.NumUpDown;
    high!: formattingSettings.NumUpDown;
    critical!: formattingSettings.NumUpDown;
    auto!: formattingSettings.ToggleSwitch;
    declare slices: formattingSettings.Slice[];

    constructor(n: number, metric: string, lo: number, med: number, hi: number, crit: number) {
        super();
        this.name = "profile" + n;
        this.displayName = "Profile " + n + " thresholds";
        this.metricName = new TextInput({ name: "metricName", displayName: "Metric name", value: metric, placeholder: "e.g. To Be Picked" });
        this.low = new NumUpDown({ name: "low", displayName: "Low (minimum)", value: lo });
        this.medium = new NumUpDown({ name: "medium", displayName: "Medium", value: med });
        this.high = new NumUpDown({ name: "high", displayName: "High", value: hi });
        this.critical = new NumUpDown({ name: "critical", displayName: "Critical", value: crit });
        this.auto = new ToggleSwitch({ name: "auto", displayName: "Auto-scale to data", value: false });
        this.slices = [this.metricName, this.low, this.medium, this.high, this.critical, this.auto];
    }
}

class LayoutCard extends SimpleCard {
    name = "layout";
    displayName = "Layout";

    cubeSize = new NumUpDown({ name: "cubeSize", displayName: "Largest bin size (0.2 - 1)", value: 0.85 });
    levelSpacing = new NumUpDown({ name: "levelSpacing", displayName: "Level spacing", value: 1.4 });
    showFloor = new ToggleSwitch({ name: "showFloor", displayName: "Show floor", value: true });
    showLegend = new ToggleSwitch({ name: "showLegend", displayName: "Show legend", value: true });
    showAxisLabels = new ToggleSwitch({ name: "showAxisLabels", displayName: "Show axis labels", value: true });

    useBinDims = new ToggleSwitch({ name: "useBinDims", displayName: "Use bin length / width / height", value: true });
    dimScale = new NumUpDown({ name: "dimScale", displayName: "Bin size scale (0 = auto)", value: 0 });

    trueCoords = new ToggleSwitch({ name: "trueCoords", displayName: "Use true coordinate spacing", value: true });
    xScale = new NumUpDown({ name: "xScale", displayName: "X scale (0 = auto)", value: 0 });
    yScale = new NumUpDown({ name: "yScale", displayName: "Y scale (0 = auto)", value: 0 });
    zScale = new NumUpDown({ name: "zScale", displayName: "Z scale (0 = auto)", value: 0 });

    slices = [this.cubeSize, this.levelSpacing, this.showFloor, this.showLegend, this.showAxisLabels,
        this.useBinDims, this.dimScale, this.trueCoords, this.xScale, this.yScale, this.zScale];
}

export class VisualFormattingSettingsModel extends Model {
    scaleCard = new ScaleCard();
    profile1 = new ProfileCard(1, "Total Units", 0, 5, 10, 15);
    profile2 = new ProfileCard(2, "To Be Picked", 0, 5, 10, 15);
    profile3 = new ProfileCard(3, "To Be Filled", 0, 5, 10, 15);
    layoutCard = new LayoutCard();
    cards = [this.scaleCard, this.profile1, this.profile2, this.profile3, this.layoutCard];
}
