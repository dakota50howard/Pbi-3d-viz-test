import powerbi from "powerbi-visuals-api";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { FormattingSettingsService } from "powerbi-visuals-utils-formattingmodel";
import { VisualFormattingSettingsModel } from "./settings";
import "../style/visual.less";

import IVisual = powerbi.extensibility.visual.IVisual;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import ISelectionId = powerbi.visuals.ISelectionId;
import ISelectionManager = powerbi.extensibility.ISelectionManager;
import ITooltipService = powerbi.extensibility.ITooltipService;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import DataView = powerbi.DataView;

interface Tick { pos: number; label: string; }
interface GroupLabel { sprite: THREE.Sprite; }
interface Scale { low: number; med: number; high: number; crit: number; }
type ViewKind = "plan" | "front" | "side" | "iso";

interface Cell {
    value: number | null;
    px: number; py: number; pz: number;
    zIdx: number;
    len: number | null; wid: number | null; hei: number | null;
    bw: number; bd: number; bh: number;
    cats: string[];
    groups: string[];
    tip: { displayName: string; value: string }[];
    row: number;
    id?: ISelectionId;
}

const fmtNum = (n: number): string => String(Math.round(n * 1000) / 1000);

export class Visual implements IVisual {
    private host: IVisualHost;
    private selection: ISelectionManager;
    private tooltips: ITooltipService;
    private fmtService = new FormattingSettingsService();
    private settings!: VisualFormattingSettingsModel;

    private root: HTMLElement;
    private emptyMsg: HTMLElement;
    private legendEl: HTMLElement;
    private panelEl: HTMLElement;
    private viewEl: HTMLElement;
    private statusEl?: HTMLElement;
    private groupColors = new Map<string, THREE.Color>();
    private autoColors = new Map<string, THREE.Color>();
    private styleOverride: boolean | null = null; // viewer's Cards / Colors choice
    private lastStyleSetting: boolean | null = null;
    private table?: powerbi.DataViewTable;
    private truncated = false;
    private emptyText = "Add X, Y and Value fields to see the 3D heatmap.";
    private renderer: THREE.WebGLRenderer;
    private scene = new THREE.Scene();
    private camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    private controls: OrbitControls;
    private raycaster = new THREE.Raycaster();

    private mesh?: THREE.InstancedMesh;
    private floor?: THREE.Mesh;
    private labelSprites: THREE.Sprite[] = [];
    private cells: Cell[] = [];
    private valueName = "Value";
    private metricName = "";
    private active: Scale = { low: 0, med: 5, high: 10, crit: 15 };

    private ticks: { x: Tick[]; y: Tick[]; z: Tick[] } = { x: [], y: [], z: [] };
    private axisNames: string[] = ["", "", ""];
    private zLabels: string[] = [];
    private lvlFrom = 0;
    private lvlTo = 0;
    private prevLevels = -1;
    private ext = { x: 0, y: 0, z: 0 };

    private catNames: string[] = ["", "", ""];
    private catOptions: string[][] = [[], [], []];
    private catSel: string[] = ["", "", ""];
    private catExact: boolean[] = [false, false, false];
    private hideMode = false;

    private groupNames: string[] = ["", "", ""];
    private labelPick = 0; // which grouping is labelled, -1 = off
    private groupLabels: GroupLabel[] = [];

    private cubeSize = 0.85;
    private lvl = 1.4;
    private lastDims = "";
    private downPos = { x: 0, y: 0 };
    private hoverQueued = false;

    constructor(options: VisualConstructorOptions) {
        this.host = options.host;
        this.selection = this.host.createSelectionManager();
        this.tooltips = this.host.tooltipService;

        this.root = document.createElement("div");
        this.root.className = "heatmap3d";
        options.element.appendChild(this.root);

        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.root.appendChild(this.renderer.domElement);

        this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f98, 1.1));
        const sun = new THREE.DirectionalLight(0xffffff, 1.4);
        sun.position.set(40, 80, 30);
        this.scene.add(sun);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = false;
        this.controls.addEventListener("change", () => this.draw());

        this.emptyMsg = document.createElement("div");
        this.emptyMsg.className = "hm-empty";
        this.emptyMsg.textContent = this.emptyText;
        this.root.appendChild(this.emptyMsg);

        this.legendEl = document.createElement("div");
        this.legendEl.className = "hm-legend";
        this.root.appendChild(this.legendEl);

        this.panelEl = document.createElement("div");
        this.panelEl.className = "hm-panel";
        this.root.appendChild(this.panelEl);

        this.viewEl = document.createElement("div");
        this.viewEl.className = "hm-view";
        this.root.appendChild(this.viewEl);

        const el = this.renderer.domElement;
        el.addEventListener("pointerdown", (e) => { this.downPos = { x: e.clientX, y: e.clientY }; });
        el.addEventListener("pointerup", (e) => this.onClick(e));
        el.addEventListener("pointermove", (e) => this.onHover(e));
        el.addEventListener("pointerleave", () => this.tooltips.hide({ immediately: true, isTouchEvent: false }));

        this.selection.registerOnSelectCallback(() => { this.applyColors(); this.draw(); });
    }

    public update(options: VisualUpdateOptions): void {
        const dv = options.dataViews?.[0];
        this.settings = this.fmtService.populateFormattingSettingsModel(VisualFormattingSettingsModel, dv);

        const { width, height } = options.viewport;

        // Panel text size: your setting, scaled with the visual's size so panels stay readable and fit.
        const tx = this.settings.textCard;
        const base = Math.min(36, Math.max(7, tx.uiSize.value));
        const auto = tx.autoPanels.value ? Math.min(1.6, Math.max(0.7, Math.min(width / 900, height / 520))) : 1;
        this.root.style.setProperty("--hm-fs", (base * auto).toFixed(2) + "px");
        this.renderer.setSize(width, height);
        this.camera.aspect = width / Math.max(height, 1);
        this.camera.updateProjectionMatrix();

        // Power BI hands over 30,000 rows at a time. Keep asking for more until everything is loaded (or the cap is hit).
        const MAX_ROWS = 100000;
        const loaded = dv?.table?.rows?.length ?? 0;
        this.truncated = false;
        if (dv?.metadata?.segment) {
            if (loaded < MAX_ROWS && this.host.fetchMoreData(true)) {
                this.emptyMsg.textContent = `Loading bins... ${loaded.toLocaleString()} so far`;
                this.emptyMsg.style.display = "flex";
                return;
            }
            this.truncated = loaded >= MAX_ROWS;
        }
        this.emptyMsg.textContent = this.emptyText;

        this.cells = this.parse(dv);
        const def = this.settings.labelsCard.colorGroups.value;
        if (this.lastStyleSetting !== null && def !== this.lastStyleSetting) this.styleOverride = null;
        this.lastStyleSetting = def;
        this.resolveScale();
        this.parseGroupColors();
        this.buildAutoColors();
        this.emptyMsg.style.display = this.cells.length ? "none" : "flex";
        this.build();
        this.buildFilterPanel();
        this.buildViewPanel();
        this.buildLegend();
        this.draw();
    }

    public getFormattingModel(): powerbi.visuals.FormattingModel {
        return this.fmtService.buildFormattingModel(this.settings);
    }

    // ---------- data ----------
    private idFor(c: Cell): ISelectionId {
        if (!c.id) c.id = this.host.createSelectionIdBuilder().withTable(this.table!, c.row).createSelectionId();
        return c.id;
    }

    private parse(dv?: DataView): Cell[] {
        const table = dv?.table;
        this.table = table;
        this.catNames = ["", "", ""];
        this.catOptions = [[], [], []];
        this.groupNames = ["", "", ""];
        this.metricName = "";
        this.ticks = { x: [], y: [], z: [] };
        this.axisNames = ["", "", ""];
        this.zLabels = [];
        if (!table || !table.rows?.length) return [];

        const cols = table.columns;
        const idx = (role: string) => cols.findIndex((c) => c.roles && c.roles[role]);
        const xC = idx("x"), yC = idx("y"), zC = idx("z"), vC = idx("value");
        const mC = idx("metric"), lC = idx("length"), wC = idx("width"), hC = idx("height");
        const tipCols = cols.map((c, i) => (c.roles?.tooltips ? i : -1)).filter((i) => i >= 0);
        const fC = ["filter1", "filter2", "filter3"].map(idx);

        this.catNames = fC.map((c) => (c >= 0 ? cols[c].displayName : ""));
        this.catOptions = fC.map((c) =>
            c < 0 ? [] : Array.from(new Set(table.rows.map((r) => (r[c] == null ? "" : String(r[c])))))
                .filter((v) => v !== "")
                .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
        this.catSel = this.catSel.map((v, k) => (this.catExact[k] && !this.catOptions[k].includes(v) ? "" : v));
        const gC = ["group1", "group2", "group3"].map(idx);
        this.groupNames = gC.map((c) => (c >= 0 ? cols[c].displayName : ""));
        if (xC < 0 || yC < 0) return [];

        this.valueName = vC >= 0 ? cols[vC].displayName : "Value";
        const firstMetric = mC >= 0 ? table.rows.find((r) => r[mC] != null) : undefined;
        this.metricName = firstMetric ? String(firstMetric[mC]) : "";
        this.axisNames = [cols[xC].displayName, cols[yC].displayName, zC >= 0 ? cols[zC].displayName : ""];

        const lay = this.settings.layoutCard;

        // Map a coordinate to world units. Numeric fields keep their real spacing
        // (smallest gap between neighbours = 1 cell, unless a manual scale is set).
        const axis = (col: number, userScale: number): { f: (v: any) => number; ticks: Tick[] } => {
            if (col < 0) return { f: () => 0, ticks: [] };
            const uniq = Array.from(new Set(table.rows.map((r) => r[col] as any)));
            const numeric = lay.trueCoords.value && uniq.every((v) => typeof v === "number" && isFinite(v));
            if (numeric) {
                const nums = (uniq as number[]).sort((a, b) => a - b);
                let minGap = Infinity;
                for (let i = 1; i < nums.length; i++) {
                    const g = nums[i] - nums[i - 1];
                    if (g > 1e-9 && g < minGap) minGap = g;
                }
                const range = nums[nums.length - 1] - nums[0];
                let scale = userScale > 0 ? userScale : (isFinite(minGap) ? 1 / minGap : 1);
                if (range * scale > 800) scale = 800 / range; // keep the scene a usable size
                const min = nums[0];
                const f = (v: any) => (Number(v) - min) * scale;
                return { f, ticks: nums.map((n) => ({ pos: f(n), label: fmtNum(n) })) };
            }
            uniq.sort((a: any, b: any) => {
                if (typeof a === "number" && typeof b === "number") return a - b;
                if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
                return String(a).localeCompare(String(b), undefined, { numeric: true });
            });
            const m = new Map(uniq.map((v, i) => [String(v), i] as [string, number]));
            return { f: (v) => m.get(String(v)) ?? 0, ticks: uniq.map((v, i) => ({ pos: i, label: String(v) })) };
        };
        const ax = axis(xC, lay.xScale.value), ay = axis(yC, lay.yScale.value), az = axis(zC, lay.zScale.value);
        this.ticks = { x: ax.ticks, y: ay.ticks, z: az.ticks };
        this.zLabels = az.ticks.map((t) => t.label);

        const nLv = az.ticks.length;
        if (nLv !== this.prevLevels) { this.lvlFrom = 0; this.lvlTo = Math.max(0, nLv - 1); this.prevLevels = nLv; }
        this.lvlFrom = Math.min(this.lvlFrom, Math.max(0, nLv - 1));
        this.lvlTo = Math.min(this.lvlTo, Math.max(0, nLv - 1));
        const zPos = new Map(az.ticks.map((t, i) => [t.pos, i] as [number, number]));

        const fmt = (v: any) => (v == null ? "" : String(v));
        const num = (col: number, r: any[]): number | null => {
            if (col < 0 || r[col] == null) return null;
            const n = Number(r[col]);
            return isFinite(n) && n > 0 ? n : null;
        };
        const valueLabel = this.metricName || (vC >= 0 ? cols[vC].displayName : "Value");
        // Tooltip toggle: only show fields from the Tooltips well (needs at least one field there).
        const onlyTipWell = this.settings.layoutCard.tipOnly.value && tipCols.length > 0;

        return table.rows.map((r, i) => {
            const pz = zC >= 0 ? az.f(r[zC]) : 0;
            return {
                value: vC >= 0 && r[vC] != null ? Number(r[vC]) : null,
                px: ax.f(r[xC]),
                py: ay.f(r[yC]),
                pz,
                zIdx: zC >= 0 ? zPos.get(pz) ?? 0 : 0,
                len: num(lC, r), wid: num(wC, r), hei: num(hC, r),
                bw: 1, bd: 1, bh: 1,
                cats: fC.map((c) => (c >= 0 && r[c] != null ? String(r[c]) : "")),
                groups: gC.map((c) => (c >= 0 && r[c] != null ? String(r[c]) : "")),
                tip: onlyTipWell
                    ? tipCols.map((c) => ({ displayName: cols[c].displayName, value: fmt(r[c]) }))
                    : [
                        { displayName: cols[xC].displayName, value: fmt(r[xC]) },
                        { displayName: cols[yC].displayName, value: fmt(r[yC]) },
                        ...(zC >= 0 ? [{ displayName: cols[zC].displayName, value: fmt(r[zC]) }] : []),
                        ...(vC >= 0 ? [{ displayName: valueLabel, value: fmt(r[vC]) }] : []),
                        ...fC.filter((c) => c >= 0).map((c) => ({ displayName: cols[c].displayName, value: fmt(r[c]) })),
                        ...gC.filter((c) => c >= 0).map((c) => ({ displayName: cols[c].displayName, value: fmt(r[c]) })),
                        ...tipCols.map((c) => ({ displayName: cols[c].displayName, value: fmt(r[c]) })),
                    ],
                row: i,
            } as Cell;
        });
    }

    // Thresholds come from the Color scale card (or auto-scale). The minimum is never below 0.
    private resolveScale(): void {
        const sc = this.settings.scaleCard;
        let low = sc.low.value, med = sc.medium.value, high = sc.high.value, crit = sc.critical.value;
        if (sc.auto.value) {
            // Whole numbers, and zero-value bins are left out of the maths so they don't drag the scale down.
            const all = this.cells.map((c) => c.value).filter((v): v is number => v != null);
            const pos = all.filter((v) => v > 0).sort((a, b) => a - b);
            if (pos.length) {
                const p95 = pos[Math.min(pos.length - 1, Math.floor(pos.length * 0.95))];
                low = Math.max(1, Math.floor(pos[0]));
                crit = Math.max(low + 3, Math.ceil(p95));
                med = low + Math.max(1, Math.round((crit - low) / 3));
                high = Math.max(med + 1, low + Math.round((2 * (crit - low)) / 3));
                crit = Math.max(high + 1, crit);
            }
        }
        low = Math.max(1, low); // 0 is the Empty level
        med = Math.max(low, med);
        high = Math.max(med, high);
        crit = Math.max(high, crit);
        this.active = { low, med, high, crit };
    }

    // ---------- scene ----------
    private build(): void {
        if (this.mesh) {
            this.scene.remove(this.mesh);
            this.mesh.geometry.dispose();
            (this.mesh.material as THREE.Material).dispose();
            this.mesh = undefined;
        }
        if (this.floor) {
            this.scene.remove(this.floor);
            this.floor.geometry.dispose();
            (this.floor.material as THREE.Material).dispose();
            this.floor = undefined;
        }
        this.clearLabels();
        this.clearGroupLabels();
        if (!this.cells.length) return;

        const lay = this.settings.layoutCard;
        const size = Math.min(1, Math.max(0.2, lay.cubeSize.value));
        const lvl = Math.max(1, lay.levelSpacing.value);
        this.cubeSize = size;
        this.lvl = lvl;

        let mx = 0, my = 0, mz = 0;
        for (const c of this.cells) { mx = Math.max(mx, c.px); my = Math.max(my, c.py); mz = Math.max(mz, c.pz); }
        this.ext = { x: mx, y: my, z: mz * lvl };

        // Bin sizes: relative to each other, the largest dimension in the data fills `size`
        const useDims = lay.useBinDims.value && this.cells.some((c) => c.len != null || c.wid != null || c.hei != null);
        let k = 1;
        if (useDims) {
            let md = 0;
            for (const c of this.cells) md = Math.max(md, c.len ?? 0, c.wid ?? 0, c.hei ?? 0);
            k = lay.dimScale.value > 0 ? lay.dimScale.value : (md > 0 ? size / md : 1);
        }
        for (const c of this.cells) {
            c.bw = useDims && c.len != null ? c.len * k : size;
            c.bd = useDims && c.wid != null ? c.wid * k : size;
            c.bh = useDims && c.hei != null ? c.hei * k : size;
        }

        this.mesh = new THREE.InstancedMesh(
            new THREE.BoxGeometry(1, 1, 1),
            new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 }),
            this.cells.length
        );
        this.scene.add(this.mesh);
        this.applyVisibility();

        if (lay.showFloor.value) {
            this.floor = new THREE.Mesh(
                new THREE.PlaneGeometry(mx + 4, my + 4),
                new THREE.MeshBasicMaterial({ color: 0xcfd2d6, transparent: true, opacity: 0.55, side: THREE.DoubleSide })
            );
            this.floor.rotation.x = -Math.PI / 2;
            this.floor.position.set(mx / 2, -size / 2 - 0.05, my / 2);
            this.scene.add(this.floor);
        }

        if (lay.showAxisLabels.value) this.buildLabels();
        this.buildGroupLabels();
        this.applyColors();

        const dims = `${mx.toFixed(1)}x${my.toFixed(1)}x${mz.toFixed(1)}`;
        if (dims !== this.lastDims) {
            this.lastDims = dims;
            this.setView("iso");
        }
    }

    // ---------- axis labels ----------
    private clearLabels(): void {
        for (const sp of this.labelSprites) {
            this.scene.remove(sp);
            sp.material.map?.dispose();
            sp.material.dispose();
        }
        this.labelSprites = [];
    }

    private makeLabel(text: string, h: number, strong: boolean): THREE.Sprite {
        const cv = document.createElement("canvas");
        cv.width = 256;
        cv.height = 64;
        const ctx = cv.getContext("2d")!;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        let fs = strong ? 40 : 34;
        const setFont = () => { ctx.font = `${strong ? 700 : 600} ${fs}px "Segoe UI", sans-serif`; };
        setFont();
        while (ctx.measureText(text).width > 236 && fs > 12) { fs -= 2; setFont(); }
        ctx.lineWidth = 6;
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.strokeText(text, 128, 34);
        ctx.fillStyle = strong ? "#1f4e8c" : "#4a5160";
        ctx.fillText(text, 128, 34);
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), transparent: true }));
        sp.scale.set(h * 4, h, 1);
        return sp;
    }

    private buildLabels(): void {
        const { x: ex, y: ey, z: ez } = this.ext;
        const floorY = -this.cubeSize / 2;
        const span = Math.max(ex, ey, ez, 10);
        const h = Math.max(0.8, span * 0.028) * Math.min(4, Math.max(0.3, this.settings.textCard.axisSize.value));
        const gap = h * 2.6;
        const thin = (ticks: Tick[], minGap: number) => {
            const out: Tick[] = [];
            let last = -Infinity;
            for (const t of ticks) if (t.pos - last >= minGap) { out.push(t); last = t.pos; }
            return out;
        };
        const add = (text: string, x: number, y: number, z: number, strong = false) => {
            const sp = this.makeLabel(text, strong ? h * 1.15 : h, strong);
            sp.position.set(x, y, z);
            this.scene.add(sp);
            this.labelSprites.push(sp);
        };
        const off = -1.6;
        thin(this.ticks.x, gap).forEach((t) => add(t.label, t.pos, floorY, off));
        thin(this.ticks.y, h * 1.6).forEach((t) => add(t.label, off, floorY, t.pos));
        this.ticks.z.forEach((t) => add(t.label, off, t.pos * this.lvl, off));
        if (this.axisNames[0]) add(this.axisNames[0], ex / 2, floorY, off * 2.3, true);
        if (this.axisNames[1]) add(this.axisNames[1], off * 2.3, floorY, ey / 2, true);
        if (this.axisNames[2]) add(this.axisNames[2], off, ez + this.lvl, off, true);
    }

    // ---------- camera views ----------
    private setView(kind: ViewKind): void {
        if (!this.cells.length) return;
        const { x, y, z } = this.ext;
        const cx = x / 2, cy = z / 2, cz = y / 2;
        const t = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
        const fit = (w: number, h: number) =>
            (Math.max(h, w / this.camera.aspect) / (2 * t)) * 1.2 + 2;
        const span = Math.max(x + 1, y + 1, z + 1);
        let d = span;
        this.controls.target.set(cx, cy, cz);
        if (kind === "plan") {
            d = fit(x + 4, y + 4);
            this.camera.position.set(cx, cy + z / 2 + d, cz + 0.01);
        } else if (kind === "front") {
            d = fit(x + 4, z + 4);
            this.camera.position.set(cx, cy, cz + y / 2 + d);
        } else if (kind === "side") {
            d = fit(y + 4, z + 4);
            this.camera.position.set(cx + x / 2 + d, cy, cz);
        } else {
            this.camera.position.set(cx + span * 0.35, cy + span * 1.05, cz + span * 1.0);
        }
        this.camera.far = Math.max(span * 20, d * 6);
        this.camera.updateProjectionMatrix();
        this.controls.update();
        this.draw();
    }

    // ---------- color ----------
    private colorFor(v: number | null): THREE.Color {
        const s = this.settings.scaleCard;
        const a = this.active;
        const stops = [
            { v: a.low, c: new THREE.Color(s.lowColor.value.value) },
            { v: a.med, c: new THREE.Color(s.mediumColor.value.value) },
            { v: a.high, c: new THREE.Color(s.highColor.value.value) },
            { v: a.crit, c: new THREE.Color(s.criticalColor.value.value) },
        ];
        if (v == null) return new THREE.Color(0x9aa0a6);
        if (v === 0 && s.showEmpty.value) return new THREE.Color(s.emptyColor.value.value); // empty bins
        if (v <= stops[0].v) return stops[0].c.clone();
        for (let i = 1; i < stops.length; i++) {
            if (v <= stops[i].v) {
                const span = stops[i].v - stops[i - 1].v || 1;
                return stops[i - 1].c.clone().lerp(stops[i].c, (v - stops[i - 1].v) / span);
            }
        }
        return stops[3].c.clone();
    }

    // ---------- color the whole group ----------
    private useColors(): boolean {
        return this.styleOverride ?? this.settings.labelsCard.colorGroups.value;
    }

    private colorByGroup(): boolean {
        return this.useColors() && this.effectiveLabelField() >= 0;
    }

    private parseGroupColors(): void {
        this.groupColors.clear();
        const raw = this.settings.labelsCard.groupColorList.value || "";
        for (const part of raw.split(/[;\n]+/)) {
            const eq = part.lastIndexOf("=");
            if (eq < 1) continue;
            const name = part.slice(0, eq).trim().toLowerCase();
            let col = part.slice(eq + 1).trim().toLowerCase();
            if (!name || !col) continue;
            if (/^[0-9a-f]{3}$|^[0-9a-f]{6}$/.test(col)) col = "#" + col;
            if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(col)) this.groupColors.set(name, new THREE.Color(col));
            else if (THREE.Color.NAMES[col] !== undefined) this.groupColors.set(name, new THREE.Color(THREE.Color.NAMES[col]));
        }
    }

    // Automatic colors for groups you haven't listed. Assigned by each group's place in the sorted list of ALL groups,
    // so listing a group by hand never shifts the other groups' colors.
    private buildAutoColors(): void {
        this.autoColors.clear();
        const gi = this.effectiveLabelField();
        if (gi < 0 || !this.settings.labelsCard.autoColors.value) return;
        const palette = ["#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F", "#EDC948", "#B07AA1", "#FF9DA7",
            "#9C755F", "#86BCB6", "#D37295", "#499894", "#8CD17D", "#B6992D", "#FABFD2", "#79706E",
            "#A0CBE8", "#FFBE7D", "#D4A6C8", "#BAB0AC"];
        const names = Array.from(new Set(this.cells.map((c) => c.groups[gi]).filter((g) => !!g)))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        names.forEach((n, i) => {
            const key = n.trim().toLowerCase();
            if (this.groupColors.has(key)) return;
            const col = i < palette.length
                ? new THREE.Color(palette[i])
                : new THREE.Color().setHSL(((i * 0.618034) % 1), 0.6, 0.5);
            this.autoColors.set(key, col);
        });
    }

    private groupColorFor(c: Cell): THREE.Color | null {
        const gi = this.effectiveLabelField();
        const g = gi >= 0 ? c.groups[gi] : "";
        const key = g ? g.trim().toLowerCase() : "";
        const hit = this.groupColors.get(key) ?? this.autoColors.get(key);
        return hit ? hit.clone() : null; // no color for this bin: fall back to the heat scale
    }

    private applyColors(): void {
        if (!this.mesh) return;
        const picked = this.selection.getSelectionIds() as ISelectionId[];
        const dim = new THREE.Color(0xd5d8dc);
        const byGroup = this.colorByGroup();
        this.cells.forEach((c, i) => {
            const col = (byGroup ? this.groupColorFor(c) : null) ?? this.colorFor(c.value);
            if ((picked.length && !picked.some((p) => p.equals(this.idFor(c)))) || !this.matches(c)) col.lerp(dim, 0.8);
            this.mesh!.setColorAt(i, col);
        });
        if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }

    private buildLegend(): void {
        const lay = this.settings.layoutCard;
        this.legendEl.style.display = lay.showLegend.value && this.cells.length ? "block" : "none";
        this.legendEl.replaceChildren();
        const s = this.settings.scaleCard;
        const a = this.active;
        const stops: [string, number, string][] = [
            ["Low", a.low, s.lowColor.value.value],
            ["Medium", a.med, s.mediumColor.value.value],
            ["High", a.high, s.highColor.value.value],
            ["Critical", a.crit, s.criticalColor.value.value],
        ];
        const add = (parent: HTMLElement, cls: string, text?: string) => {
            const d = document.createElement("div");
            d.className = cls;
            if (text !== undefined) d.textContent = text;
            parent.appendChild(d);
            return d;
        };
        if (this.colorByGroup()) {
            const gi = this.effectiveLabelField();
            add(this.legendEl, "hm-title", this.groupNames[gi] || "Groups");
            const seen = new Map<string, number>();
            for (const c of this.cells) {
                const g = c.groups[gi];
                if (g) seen.set(g, (seen.get(g) ?? 0) + 1);
            }
            const names = Array.from(seen.keys()).sort((p, q) => p.localeCompare(q, undefined, { numeric: true }));
            const box = add(this.legendEl, "hm-details");
            names.slice(0, 16).forEach((n) => {
                const row = add(box, "hm-row");
                const left = add(row, "");
                const sw = document.createElement("span");
                sw.className = "hm-swatch";
                const key = n.trim().toLowerCase();
                const gc = this.groupColors.get(key) ?? this.autoColors.get(key);
                sw.style.background = gc ? "#" + gc.getHexString() : "linear-gradient(90deg,#22A850,#F5D90A,#D61F2C)";
                left.appendChild(sw);
                left.appendChild(document.createTextNode(n));
            });
            if (names.length > 16) add(box, "hm-ends", `+${names.length - 16} more groups`);
            return;
        }
        add(this.legendEl, "hm-title", this.metricName || this.valueName);
        const range = (a.crit - a.low) || 1;
        const bar = add(this.legendEl, "hm-bar");
        bar.style.background = "linear-gradient(to right," +
            stops.map(([, v, c]) => `${c} ${(((v - a.low) / range) * 100).toFixed(1)}%`).join(",") + ")";
        const ends = add(this.legendEl, "hm-ends");
        add(ends, "", fmtNum(a.low));
        add(ends, "", fmtNum(a.crit));

        if (this.truncated) add(this.legendEl, "hm-ends", `Showing the first ${this.cells.length.toLocaleString()} bins (limit reached)`);

        const details = add(this.legendEl, "hm-details");
        if (s.showEmpty.value) {
            const row = add(details, "hm-row");
            const left = add(row, "");
            const sw = document.createElement("span");
            sw.className = "hm-swatch";
            sw.style.background = s.emptyColor.value.value;
            left.appendChild(sw);
            left.appendChild(document.createTextNode("Empty"));
            add(row, "", "0");
        }
        for (const [label, v, c] of stops) {
            const row = add(details, "hm-row");
            const left = add(row, "");
            const sw = document.createElement("span");
            sw.className = "hm-swatch";
            sw.style.background = c;
            left.appendChild(sw);
            left.appendChild(document.createTextNode(label));
            add(row, "", fmtNum(v));
        }
    }

    // ---------- filters, levels ----------
    private matches(c: Cell): boolean {
        return this.catSel.every((t, k) =>
            t === "" || (this.catExact[k] ? c.cats[k] === t : c.cats[k].toLowerCase().includes(t.toLowerCase())));
    }

    private inLevel(c: Cell): boolean {
        return c.zIdx >= this.lvlFrom && c.zIdx <= this.lvlTo;
    }

    private isHidden(c: Cell): boolean {
        return !this.inLevel(c) || (this.hideMode && !this.matches(c));
    }

    private applyVisibility(): void {
        if (!this.mesh) return;
        const m = new THREE.Matrix4();
        const q = new THREE.Quaternion();
        const pos = new THREE.Vector3();
        const sc = new THREE.Vector3();
        this.cells.forEach((c, i) => {
            pos.set(c.px, c.pz * this.lvl - this.cubeSize / 2 + c.bh / 2, c.py);
            if (this.isHidden(c)) sc.set(0.0001, 0.0001, 0.0001);
            else sc.set(c.bw, c.bh, c.bd);
            m.compose(pos, q, sc);
            this.mesh!.setMatrixAt(i, m);
        });
        this.mesh.instanceMatrix.needsUpdate = true;
        this.mesh.boundingSphere = null; // recompute for picking
    }

    private updateStatus(): void {
        if (!this.statusEl) return;
        if (!this.catSel.some((t) => t !== "")) { this.statusEl.textContent = ""; return; }
        const n = this.cells.filter((c) => this.matches(c)).length;
        this.statusEl.textContent = `${n} of ${this.cells.length} bins match`;
    }

    private onFilterChange(): void {
        this.updateStatus();
        this.buildGroupLabels();
        this.applyVisibility();
        this.applyColors();
        this.draw();
    }

    private buildFilterPanel(): void {
        this.panelEl.replaceChildren();
        this.statusEl = undefined;
        const active = this.catNames.some((n) => n !== "");
        this.panelEl.style.display = active && this.cells.length ? "block" : "none";
        if (!active) return;

        const title = document.createElement("div");
        title.className = "hm-ptitle";
        title.textContent = "Filters";
        this.panelEl.appendChild(title);

        const seg = document.createElement("div");
        seg.className = "hm-seg";
        const label = document.createElement("span");
        label.textContent = "Non-matching";
        seg.appendChild(label);
        const group = document.createElement("div");
        const mk = (text: string, hide: boolean) => {
            const b = document.createElement("button");
            b.textContent = text;
            b.className = this.hideMode === hide ? "on" : "";
            b.addEventListener("click", () => {
                this.hideMode = hide;
                group.querySelectorAll("button").forEach((x) => x.classList.remove("on"));
                b.classList.add("on");
                this.onFilterChange();
            });
            group.appendChild(b);
        };
        mk("Dim", false);
        mk("Hide", true);
        seg.appendChild(group);
        this.panelEl.appendChild(seg);

        this.catNames.forEach((name, k) => {
            if (!name) return;
            const wrap = document.createElement("div");
            wrap.className = "hm-search";
            const input = document.createElement("input");
            input.type = "text";
            input.placeholder = "Search " + name;
            input.value = this.catSel[k];
            const clear = document.createElement("button");
            clear.className = "hm-clear";
            clear.textContent = "×";
            clear.title = "Clear";
            const list = document.createElement("div");
            list.className = "hm-list";

            const refreshList = () => {
                list.replaceChildren();
                const t = input.value.trim().toLowerCase();
                const hits = this.catOptions[k].filter((v) => t === "" || v.toLowerCase().includes(t));
                hits.slice(0, 8).forEach((v) => {
                    const item = document.createElement("div");
                    item.textContent = v;
                    item.addEventListener("mousedown", (e) => {
                        e.preventDefault();
                        input.value = v;
                        this.catSel[k] = v;
                        this.catExact[k] = true;
                        list.style.display = "none";
                        this.onFilterChange();
                    });
                    list.appendChild(item);
                });
                if (hits.length > 8) {
                    const more = document.createElement("div");
                    more.className = "hm-more";
                    more.textContent = `${hits.length - 8} more, keep typing`;
                    list.appendChild(more);
                }
                list.style.display = hits.length ? "block" : "none";
            };
            input.addEventListener("input", () => {
                this.catSel[k] = input.value.trim();
                this.catExact[k] = false;
                refreshList();
                this.onFilterChange();
            });
            input.addEventListener("focus", refreshList);
            input.addEventListener("blur", () => { list.style.display = "none"; });
            clear.addEventListener("click", () => {
                input.value = "";
                this.catSel[k] = "";
                this.catExact[k] = false;
                list.style.display = "none";
                this.onFilterChange();
            });
            wrap.appendChild(input);
            wrap.appendChild(clear);
            wrap.appendChild(list);
            this.panelEl.appendChild(wrap);
        });

        this.statusEl = document.createElement("div");
        this.statusEl.className = "hm-status";
        this.panelEl.appendChild(this.statusEl);
        this.updateStatus();
    }

    private buildViewPanel(): void {
        this.viewEl.replaceChildren();
        this.viewEl.style.display = this.cells.length ? "block" : "none";
        if (!this.cells.length) return;

        const title = document.createElement("div");
        title.className = "hm-ptitle";
        title.textContent = "View";
        this.viewEl.appendChild(title);

        const row = document.createElement("div");
        row.className = "hm-views";
        const views: [string, ViewKind][] = [["Plan", "plan"], ["Front", "front"], ["Side", "side"], ["Reset", "iso"]];
        for (const [text, kind] of views) {
            const b = document.createElement("button");
            b.textContent = text;
            b.addEventListener("click", () => this.setView(kind));
            row.appendChild(b);
        }
        this.viewEl.appendChild(row);

        if (this.zLabels.length > 1) {
            const lt = document.createElement("div");
            lt.className = "hm-ltitle";
            lt.textContent = "Levels shown";
            this.viewEl.appendChild(lt);

            const slider = (name: string, get: () => number, set: (v: number) => void) => {
                const wrap = document.createElement("div");
                wrap.className = "hm-lvl";
                const n = document.createElement("span");
                n.textContent = name;
                const input = document.createElement("input");
                input.type = "range";
                input.min = "0";
                input.max = String(this.zLabels.length - 1);
                input.step = "1";
                input.value = String(get());
                const out = document.createElement("span");
                out.className = "hm-lvlout";
                out.textContent = this.zLabels[get()];
                input.addEventListener("input", () => {
                    set(Number(input.value));
                    input.value = String(get());
                    out.textContent = this.zLabels[get()];
                    this.onFilterChange();
                });
                wrap.appendChild(n);
                wrap.appendChild(input);
                wrap.appendChild(out);
                this.viewEl.appendChild(wrap);
            };
            slider("From", () => this.lvlFrom, (v) => { this.lvlFrom = Math.min(v, this.lvlTo); });
            slider("To", () => this.lvlTo, (v) => { this.lvlTo = Math.max(v, this.lvlFrom); });
        }

        const names = this.groupNames.map((n, i) => ({ n, i })).filter((g) => g.n !== "");
        if (names.length) {
            const gt = document.createElement("div");
            gt.className = "hm-ltitle";
            gt.textContent = "Group labels";
            this.viewEl.appendChild(gt);

            const opts = [{ n: "Off", i: -1 }, ...names];
            const cur = this.effectiveLabelField();
            const wrap = document.createElement("div");
            wrap.className = "hm-opts";
            for (const o of opts) {
                const bt = document.createElement("button");
                bt.textContent = o.n;
                bt.className = o.i === cur ? "on" : "";
                bt.addEventListener("click", () => {
                    this.labelPick = o.i;
                    wrap.querySelectorAll("button").forEach((x) => x.classList.remove("on"));
                    bt.classList.add("on");
                    this.buildAutoColors();
                    this.buildGroupLabels();
                    this.applyColors();
                    this.buildLegend();
                    this.draw();
                });
                wrap.appendChild(bt);
            }
            this.viewEl.appendChild(wrap);

            // Cards / Colors switch, so viewers can pick how groups are shown.
            const st = document.createElement("div");
            st.className = "hm-views hm-style";
            const mkStyle = (text: string, colors: boolean) => {
                const b = document.createElement("button");
                b.textContent = text;
                b.className = this.useColors() === colors ? "on" : "";
                b.addEventListener("click", () => {
                    this.styleOverride = colors;
                    st.querySelectorAll("button").forEach((x) => x.classList.remove("on"));
                    b.classList.add("on");
                    this.buildGroupLabels();
                    this.applyColors();
                    this.buildLegend();
                    this.draw();
                });
                st.appendChild(b);
            };
            mkStyle("Cards", false);
            mkStyle("Colors", true);
            this.viewEl.appendChild(st);
        }
    }

    // ---------- group labels ----------
    private effectiveLabelField(): number {
        if (this.labelPick === -1) return -1;
        if (this.labelPick >= 0 && this.groupNames[this.labelPick]) return this.labelPick;
        return this.groupNames.findIndex((n) => n !== "");
    }

    private clearGroupLabels(): void {
        for (const l of this.groupLabels) {
            this.scene.remove(l.sprite);
            l.sprite.material.map?.dispose();
            l.sprite.material.dispose();
        }
        this.groupLabels = [];
    }

    private makeGroupLabel(name: string, sub: string | null, hot: boolean, k: number): THREE.Sprite {
        const pad = 16, f1 = 40, f2 = 30, b = 3, r = 14;
        const probe = document.createElement("canvas").getContext("2d")!;
        probe.font = `700 ${f1}px "Segoe UI", sans-serif`;
        let w = probe.measureText(name).width;
        if (sub) {
            probe.font = `600 ${f2}px "Segoe UI", sans-serif`;
            w = Math.max(w, probe.measureText(sub).width);
        }
        const cw = Math.min(900, Math.ceil(w + pad * 2 + 8));
        const ch = sub ? f1 + f2 + pad * 2 + 10 : f1 + pad * 2;
        const cv = document.createElement("canvas");
        cv.width = cw;
        cv.height = ch;
        const ctx = cv.getContext("2d")!;
        ctx.beginPath();
        ctx.moveTo(b + r, b);
        ctx.arcTo(cw - b, b, cw - b, ch - b, r);
        ctx.arcTo(cw - b, ch - b, b, ch - b, r);
        ctx.arcTo(b, ch - b, b, b, r);
        ctx.arcTo(b, b, cw - b, b, r);
        ctx.closePath();
        ctx.fillStyle = "rgba(255,255,255,0.95)";
        ctx.fill();
        ctx.lineWidth = b * 2;
        ctx.strokeStyle = hot ? "#D61F2C" : "#3b6fb6";
        ctx.stroke();
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = `700 ${f1}px "Segoe UI", sans-serif`;
        ctx.fillStyle = "#1f2937";
        ctx.fillText(name, cw / 2, pad + f1 / 2 + 2, cw - pad * 2);
        if (sub) {
            ctx.font = `600 ${f2}px "Segoe UI", sans-serif`;
            ctx.fillStyle = hot ? "#D61F2C" : "#6b7280";
            ctx.fillText(sub, cw / 2, pad + f1 + 10 + f2 / 2, cw - pad * 2);
        }
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthTest: false }));
        sp.scale.set(cw * k, ch * k, 1);
        sp.renderOrder = 10;
        return sp;
    }

    private buildGroupLabels(): void {
        this.clearGroupLabels();
        const lab = this.settings.labelsCard;
        const gi = this.effectiveLabelField();
        if (!lab.showLabels.value || gi < 0 || !this.cells.length || this.useColors()) return;

        type Agg = { sx: number; sy: number; n: number; top: number; crit: number; minX: number; maxX: number; minY: number; maxY: number };
        const crit = this.active.crit;
        const groups = new Map<string, Agg>();
        for (const c of this.cells) {
            const g = c.groups[gi];
            if (!g || !this.inLevel(c) || !this.matches(c)) continue;
            let a = groups.get(g);
            if (!a) {
                a = { sx: 0, sy: 0, n: 0, top: -Infinity, crit: 0, minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
                groups.set(g, a);
            }
            a.sx += c.px;
            a.sy += c.py;
            a.n++;
            a.top = Math.max(a.top, c.pz * this.lvl - this.cubeSize / 2 + c.bh);
            a.minX = Math.min(a.minX, c.px); a.maxX = Math.max(a.maxX, c.px);
            a.minY = Math.min(a.minY, c.py); a.maxY = Math.max(a.maxY, c.py);
            if (c.value != null && c.value >= crit) a.crit++;
        }

        let list = Array.from(groups.entries());
        if (lab.onlyCritical.value) list = list.filter(([, a]) => a.crit > 0);
        list.sort((a, b) => b[1].crit - a[1].crit || a[0].localeCompare(b[0], undefined, { numeric: true }));
        list = list.slice(0, 200); // keep the scene light

        // Do the groups run along X or along Y? Neighbouring groups sit side by side across the other axis.
        let spanX = 0, spanY = 0;
        for (const [, a] of list) { spanX += a.maxX - a.minX; spanY += a.maxY - a.minY; }
        const alongX = spanX >= spanY;
        const perp = (a: Agg) => (alongX ? a.sy / a.n : a.sx / a.n);
        list.sort((p, q) => perp(p[1]) - perp(q[1]));

        const t = Math.min(100, Math.max(0, lab.alongGroup.value)) / 100;
        const stagger = Math.max(0, lab.stagger.value);
        // Sideways stagger: capped so labels never drift far from the group they describe.
        const cap = Math.max(5, Math.max(this.ext.x, this.ext.y) * 0.25);
        const sx = Math.max(-cap, Math.min(cap, lab.staggerX.value));
        const sz = Math.max(-cap, Math.min(cap, lab.staggerY.value));
        const span = Math.max(this.ext.x, this.ext.y, this.ext.z, 10);
        const k = (Math.max(0.8, span * 0.045) * Math.max(0.2, lab.labelSize.value)) / 80;
        list.forEach(([name, a], i) => {
            const sp = this.makeGroupLabel(name, lab.showCount.value ? `${a.crit} critical` : null, a.crit > 0, k);
            const tier = i % 3; // alternate three heights so neighbours do not overlap
            const side = tier - 1; // -1, 0, +1: neighbours alternate left / centre / right
            const x = (alongX ? a.minX + t * (a.maxX - a.minX) : a.sx / a.n) + lab.nudgeX.value + side * sx;
            const z = (alongX ? a.sy / a.n : a.minY + t * (a.maxY - a.minY)) + lab.nudgeY.value + side * sz;
            const y = a.top + lab.nudgeUp.value + sp.scale.y / 2 + tier * stagger * sp.scale.y;
            sp.position.set(x, y, z);
            this.scene.add(sp);
            this.groupLabels.push({ sprite: sp });
        });
    }

    // ---------- interaction ----------
    private pick(e: PointerEvent): number | null {
        if (!this.mesh) return null;
        const r = this.renderer.domElement.getBoundingClientRect();
        const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
        this.raycaster.setFromCamera(ndc, this.camera);
        const hit = this.raycaster.intersectObject(this.mesh)[0];
        const id = hit?.instanceId ?? null;
        if (id != null && this.isHidden(this.cells[id])) return null;
        return id;
    }

    private onHover(e: PointerEvent): void {
        if (e.buttons || this.hoverQueued) return;
        this.hoverQueued = true;
        requestAnimationFrame(() => {
            this.hoverQueued = false;
            const i = this.pick(e);
            if (i == null) { this.tooltips.hide({ immediately: true, isTouchEvent: false }); return; }
            const c = this.cells[i];
            this.tooltips.show({
                coordinates: [e.clientX, e.clientY],
                isTouchEvent: false,
                dataItems: c.tip,
                identities: [this.idFor(c)],
            });
        });
    }

    private onClick(e: PointerEvent): void {
        if (Math.hypot(e.clientX - this.downPos.x, e.clientY - this.downPos.y) > 4) return; // was a drag
        const i = this.pick(e);
        if (i == null) this.selection.clear();
        else this.selection.select(this.idFor(this.cells[i]), e.ctrlKey || e.metaKey);
        this.applyColors();
        this.draw();
    }

    private draw(): void {
        this.renderer.render(this.scene, this.camera);
    }

    public destroy(): void {
        this.clearLabels();
        this.clearGroupLabels();
        this.controls.dispose();
        this.renderer.dispose();
    }
}
