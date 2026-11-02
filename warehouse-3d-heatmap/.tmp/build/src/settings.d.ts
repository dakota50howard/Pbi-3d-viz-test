import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";
declare const SimpleCard: typeof formattingSettings.SimpleCard, Model: typeof formattingSettings.Model;
declare class ScaleCard extends SimpleCard {
    name: string;
    displayName: string;
    low: formattingSettings.NumUpDown;
    medium: formattingSettings.NumUpDown;
    high: formattingSettings.NumUpDown;
    critical: formattingSettings.NumUpDown;
    lowColor: formattingSettings.ColorPicker;
    mediumColor: formattingSettings.ColorPicker;
    highColor: formattingSettings.ColorPicker;
    criticalColor: formattingSettings.ColorPicker;
    slices: (formattingSettings.NumUpDown | formattingSettings.ColorPicker)[];
}
declare class LayoutCard extends SimpleCard {
    name: string;
    displayName: string;
    cubeSize: formattingSettings.NumUpDown;
    levelSpacing: formattingSettings.NumUpDown;
    showFloor: formattingSettings.ToggleSwitch;
    showLegend: formattingSettings.ToggleSwitch;
    slices: (formattingSettings.NumUpDown | formattingSettings.ToggleSwitch)[];
}
export declare class VisualFormattingSettingsModel extends Model {
    scaleCard: ScaleCard;
    layoutCard: LayoutCard;
    cards: (ScaleCard | LayoutCard)[];
}
export {};
