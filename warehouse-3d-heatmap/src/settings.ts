import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";

const { SimpleCard, Model, NumUpDown, ColorPicker, ToggleSwitch } = formattingSettings;

class ScaleCard extends SimpleCard {
    name = "scale";
    displayName = "Color scale";

    low = new NumUpDown({ name: "low", displayName: "Low (minimum)", value: 0 });
    medium = new NumUpDown({ name: "medium", displayName: "Medium", value: 50 });
    high = new NumUpDown({ name: "high", displayName: "High", value: 100 });
    critical = new NumUpDown({ name: "critical", displayName: "Critical", value: 150 });

    lowColor = new ColorPicker({ name: "lowColor", displayName: "Low color", value: { value: "#22A850" } });
    mediumColor = new ColorPicker({ name: "mediumColor", displayName: "Medium color", value: { value: "#F5D90A" } });
    highColor = new ColorPicker({ name: "highColor", displayName: "High color", value: { value: "#F26B3A" } });
    criticalColor = new ColorPicker({ name: "criticalColor", displayName: "Critical color", value: { value: "#D61F2C" } });

    slices = [this.low, this.medium, this.high, this.critical,
        this.lowColor, this.mediumColor, this.highColor, this.criticalColor];
}

class LayoutCard extends SimpleCard {
    name = "layout";
    displayName = "Layout";

    cubeSize = new NumUpDown({ name: "cubeSize", displayName: "Cube size (0.2 - 1)", value: 0.85 });
    levelSpacing = new NumUpDown({ name: "levelSpacing", displayName: "Level spacing", value: 1.4 });
    showFloor = new ToggleSwitch({ name: "showFloor", displayName: "Show floor", value: true });
    showLegend = new ToggleSwitch({ name: "showLegend", displayName: "Show legend", value: true });

    slices = [this.cubeSize, this.levelSpacing, this.showFloor, this.showLegend];
}

export class VisualFormattingSettingsModel extends Model {
    scaleCard = new ScaleCard();
    layoutCard = new LayoutCard();
    cards = [this.scaleCard, this.layoutCard];
}
