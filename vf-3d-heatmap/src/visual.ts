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
interface PSeg { x0: number; x1: number; z0: number; z1: number; elev: number; alongX: boolean; v: number; half: number; }
interface PGrid {
    gs: number; ox: number; oz: number; w: number; h: number;
    blocked: Uint8Array; segs: PSeg[];
    stamp: Int32Array; done: Int32Array; g: Float32Array; from: Int32Array; dir: Int8Array; cur: number;
}
interface PathStop { ci: number; n: number; stand: [number, number]; elev: number; }
interface PathRoute { carton: string; color: THREE.Color; stops: PathStop[]; lines: { a: THREE.Vector3; b: THREE.Vector3 }[]; dist: number; missing: number; }
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
    aisle: string;
    loc: string;
    rack?: number;
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
    private rackMeshes: THREE.InstancedMesh[] = [];

    // pick paths
    private pathEl: HTMLElement;
    private pickData = new Map<string, { seq: number; loc: string }[]>();
    private cartonIds: string[] = [];
    private selectedCartons: string[] = [];
    private routes: PathRoute[] = [];
    private pickedCells = new Set<number>();
    private pathMesh?: THREE.InstancedMesh;
    private pathSprites: THREE.Sprite[] = [];
    private pathDimOverride: boolean | null = null;
    private lastPathDimSetting: boolean | null = null;
    private locIndex = new Map<string, number>();
    private grid?: PGrid;
    private rackOverride: "off" | "frame" | "shelves" | null = null; // viewer's racking choice
    private lastRackKey = "";
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

        this.pathEl = document.createElement("div");
        this.pathEl.className = "hm-paths";
        this.root.appendChild(this.pathEl);

        const el = this.renderer.domElement;
        el.addEventListener("pointerdown", (e) => { this.downPos = { x: e.clientX, y: e.clientY }; });
        el.addEventListener("pointerup", (e) => this.onClick(e));
        el.addEventListener("pointermove", (e) => this.onHover(e));
        el.addEventListener("pointerleave", () => this.tooltips.hide({ immediately: true, isTouchEvent: false }));

        this.selection.registerOnSelectCallback(() => { this.applyColors(); this.draw(); });
    }

    public update(options: VisualUpdateOptions): void {
        // The visual can receive two data views: the bins, and (optionally) the pick steps. Tell them apart by their roles.
        const dvs = options.dataViews ?? [];
        const isPick = (d: DataView) => !!d.table?.columns?.some((c) => c.roles && (c.roles.pickCarton || c.roles.pickLoc || c.roles.pickSeq));
        const dv = dvs.find((d) => !isPick(d));
        const pdv = dvs.find(isPick);
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
        if (dv?.metadata?.segment || pdv?.metadata?.segment) {
            if (loaded < MAX_ROWS && this.host.fetchMoreData(true)) {
                this.emptyMsg.textContent = `Loading bins... ${loaded.toLocaleString()} so far`;
                this.emptyMsg.style.display = "flex";
                return;
            }
            this.truncated = loaded >= MAX_ROWS;
        }
        this.emptyMsg.textContent = this.emptyText;

        this.cells = this.parse(dv);
        this.grid = undefined;
        this.parsePicks(pdv);
        const dimSet = this.settings.pathsCard.dimOthers.value;
        if (this.lastPathDimSetting !== null && dimSet !== this.lastPathDimSetting) this.pathDimOverride = null;
        this.lastPathDimSetting = dimSet;
        const def = this.settings.labelsCard.colorGroups.value;
        if (this.lastStyleSetting !== null && def !== this.lastStyleSetting) this.styleOverride = null;
        this.lastStyleSetting = def;
        const rk = this.settings.rackCard;
        const rackKey = `${rk.showRacking.value}|${rk.showShelves.value}`;
        if (this.lastRackKey !== "" && rackKey !== this.lastRackKey) this.rackOverride = null;
        this.lastRackKey = rackKey;
        this.resolveScale();
        this.parseGroupColors();
        this.buildAutoColors();
        this.emptyMsg.style.display = this.cells.length ? "none" : "flex";
        this.build();
        this.buildFilterPanel();
        this.buildViewPanel();
        this.buildLegend();
        this.rebuildPaths();
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
        const aC = idx("aisle");
        const locC = idx("location");
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
                aisle: aC >= 0 && r[aC] != null ? String(r[aC]) : "",
                loc: locC >= 0 && r[locC] != null ? String(r[locC]).trim() : "",
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
        this.clearRacking();
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
        this.buildRacking();
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
        const pathDim = this.pickedCells.size > 0 && (this.pathDimOverride ?? this.settings.pathsCard.dimOthers.value);
        this.cells.forEach((c, i) => {
            const col = (byGroup ? this.groupColorFor(c) : null) ?? this.colorFor(c.value);
            if ((picked.length && !picked.some((p) => p.equals(this.idFor(c)))) || !this.matches(c)) col.lerp(dim, 0.8);
            else if (pathDim && !this.pickedCells.has(i)) col.lerp(dim, 0.8);
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
        this.buildRacking();
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

        const rt = document.createElement("div");
        rt.className = "hm-ltitle";
        rt.textContent = "Racking";
        this.viewEl.appendChild(rt);
        const rs = document.createElement("div");
        rs.className = "hm-views hm-style";
        const mkRack = (text: string, mode: "off" | "frame" | "shelves") => {
            const b = document.createElement("button");
            b.textContent = text;
            b.className = this.rackMode() === mode ? "on" : "";
            b.addEventListener("click", () => {
                this.rackOverride = mode;
                rs.querySelectorAll("button").forEach((x) => x.classList.remove("on"));
                b.classList.add("on");
                this.buildRacking();
                this.draw();
            });
            rs.appendChild(b);
        };
        mkRack("Off", "off");
        mkRack("Frame", "frame");
        mkRack("Shelves", "shelves");
        this.viewEl.appendChild(rs);

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

    // Group bins into rows (by the Aisle well, else by whichever line holds more bins), work out which way each row runs,
    // and cut it into separate racks wherever there is a wide gap (a walkway).
    private rackSegments(vis: Cell[]): { cells: Cell[]; alongX: boolean }[] {
        const rk = this.settings.rackCard;
        const rows = new Map<string, Cell[]>();
        const addTo = (k: string, c: Cell) => { const l = rows.get(k); if (l) l.push(c); else rows.set(k, [c]); };
        if (vis.some((c) => c.aisle !== "")) {
            for (const c of vis) addTo("a:" + c.aisle, c);
        } else {
            const nx = new Map<string, number>(), ny = new Map<string, number>();
            for (const c of vis) {
                const kx = c.px.toFixed(2), ky = c.py.toFixed(2);
                nx.set(kx, (nx.get(kx) ?? 0) + 1);
                ny.set(ky, (ny.get(ky) ?? 0) + 1);
            }
            for (const c of vis) {
                const kx = c.px.toFixed(2), ky = c.py.toFixed(2);
                if ((nx.get(kx) ?? 0) >= (ny.get(ky) ?? 0)) addTo("x:" + kx, c); else addTo("y:" + ky, c);
            }
        }

        const gapMax = Math.max(1.5, rk.walkGap.value);
        const segments: { cells: Cell[]; alongX: boolean }[] = [];
        rows.forEach((list) => {
            let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
            for (const c of list) {
                x0 = Math.min(x0, c.px); x1 = Math.max(x1, c.px);
                y0 = Math.min(y0, c.py); y1 = Math.max(y1, c.py);
            }
            const alongX = x1 - x0 > y1 - y0;
            const key = (c: Cell) => (alongX ? c.px : c.py);
            const sorted = list.slice().sort((a, b) => key(a) - key(b));
            let cur: Cell[] = [];
            let last = -Infinity;
            for (const c of sorted) {
                const u = key(c);
                if (cur.length && u - last > gapMax) { segments.push({ cells: cur, alongX }); cur = []; }
                cur.push(c);
                last = u;
            }
            if (cur.length) segments.push({ cells: cur, alongX });
        });

        return segments;
    }

    // ---------- racking ----------
    private rackMode(): "off" | "frame" | "shelves" {
        if (this.rackOverride) return this.rackOverride;
        const rk = this.settings.rackCard;
        if (!rk.showRacking.value) return "off";
        return rk.showShelves.value ? "shelves" : "frame";
    }

    private clearRacking(): void {
        for (const m of this.rackMeshes) {
            this.scene.remove(m);
            m.geometry.dispose();
            (m.material as THREE.Material).dispose();
        }
        this.rackMeshes = [];
    }

    // Racking: each row of bins gets uprights at its bay breaks plus a beam (and optional shelf) at every level.
    // Rows can run along X or Y, and a row is split into separate racks wherever there is a wide gap (a walkway).
    private buildRacking(): void {
        this.clearRacking();
        const mode = this.rackMode();
        if (mode === "off" || !this.cells.length) return;
        const rk = this.settings.rackCard;
        const segments = this.rackSegments(this.cells.filter((c) => this.inLevel(c)));

        const posts: number[][] = []; // [x, yBottom, z, height]
        const beams: number[][] = []; // [x, y, z, sizeX, sizeZ]
        const decks: number[][] = []; // [x, y, z, sizeX, sizeZ]
        const T = 0.11;               // post / beam thickness
        const D = 0.06;               // shelf thickness
        const bayLen = Math.max(0, rk.bayLength.value);

        // 3) build each rack
        for (const { cells: list, alongX } of segments) {
            let sv = 0, u0 = Infinity, u1 = -Infinity, cross = 0;
            const lvls = new Map<number, number>(); // level position -> tallest bin on it
            const us = new Set<number>();
            for (const c of list) {
                const u = alongX ? c.px : c.py;
                const along = alongX ? c.bw : c.bd;
                sv += alongX ? c.py : c.px;
                u0 = Math.min(u0, u - along / 2);
                u1 = Math.max(u1, u + along / 2);
                cross = Math.max(cross, alongX ? c.bd : c.bw);
                us.add(u);
                lvls.set(c.pz, Math.max(lvls.get(c.pz) ?? 0, c.bh));
            }
            const v = sv / list.length;
            const half = cross / 2 + 0.07;
            const start = u0 - 0.05, end = u1 + 0.05;
            const len = end - start, uc = (start + end) / 2;
            const at = (u: number, off: number): [number, number] => (alongX ? [u, v + off] : [v + off, u]);

            // post positions along the rack
            const zs: number[] = [start];
            if (bayLen > 0) {
                for (let z = start + bayLen; z < end - 0.01; z += bayLen) zs.push(z);
            } else {
                const sorted = Array.from(us).sort((a, b) => a - b);
                for (let i = 1; i < sorted.length; i++) {
                    if (sorted[i] - sorted[i - 1] > 1.5) zs.push((sorted[i] + sorted[i - 1]) / 2);
                }
            }
            zs.push(end);

            const levelPos = Array.from(lvls.keys()).sort((a, b) => a - b);
            const bottomY = levelPos[0] * this.lvl - this.cubeSize / 2 - D;
            const topPos = levelPos[levelPos.length - 1];
            const topY = topPos * this.lvl - this.cubeSize / 2 + (lvls.get(topPos) ?? this.cubeSize) + 0.15;

            for (const u of zs) {
                for (const off of [-half, half]) {
                    const [x, z] = at(u, off);
                    posts.push([x, bottomY, z, topY - bottomY]);
                }
            }
            for (const lp of levelPos) {
                const y = lp * this.lvl - this.cubeSize / 2 - D / 2;
                for (const off of [-half, half]) {
                    const [x, z] = at(uc, off);
                    beams.push([x, y, z, alongX ? len : T, alongX ? T : len]);
                }
                if (mode === "shelves") {
                    const [x, z] = at(uc, 0);
                    decks.push([x, y, z, alongX ? len : half * 2, alongX ? half * 2 : len]);
                }
            }
        }

        const make = (n: number, color: string, opacity: number): THREE.InstancedMesh | null => {
            if (!n) return null;
            const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.25 });
            if (opacity < 1) { mat.transparent = true; mat.opacity = opacity; mat.depthWrite = false; }
            const m = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, n);
            m.raycast = () => { /* racking never blocks hover or clicks */ };
            m.frustumCulled = false;
            this.scene.add(m);
            this.rackMeshes.push(m);
            return m;
        };
        const mat4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), sc = new THREE.Vector3();
        const put = (m: THREE.InstancedMesh, i: number, px: number, py: number, pz: number, w: number, h: number, d: number) => {
            pos.set(px, py, pz);
            sc.set(w, h, d);
            m.setMatrixAt(i, mat4.compose(pos, q, sc));
        };

        const pm = make(posts.length, rk.uprightColor.value.value, 1);
        posts.forEach((p, i) => put(pm!, i, p[0], p[1] + p[3] / 2, p[2], T, p[3], T));
        const bm = make(beams.length, rk.beamColor.value.value, 1);
        beams.forEach((b, i) => put(bm!, i, b[0], b[1], b[2], b[3], T * 0.9, b[4]));
        const dm = make(decks.length, rk.shelfColor.value.value, Math.min(1, Math.max(0.05, rk.shelfOpacity.value)));
        decks.forEach((d, i) => put(dm!, i, d[0], d[1], d[2], d[3], 0.05, d[4]));
        for (const m of this.rackMeshes) m.instanceMatrix.needsUpdate = true;
    }

    // ---------- pick paths ----------
    private parsePicks(pdv?: DataView): void {
        this.pickData = new Map();
        this.cartonIds = [];
        const t = pdv?.table;
        if (!t?.rows?.length) { this.selectedCartons = []; return; }
        const cols = t.columns;
        const ci = cols.findIndex((c) => c.roles?.pickCarton);
        const si = cols.findIndex((c) => c.roles?.pickSeq);
        const li = cols.findIndex((c) => c.roles?.pickLoc);
        if (ci < 0 || li < 0) { this.selectedCartons = []; return; }
        t.rows.forEach((r, n) => {
            if (r[ci] == null || r[li] == null) return;
            const carton = String(r[ci]).trim();
            const loc = String(r[li]).trim();
            let seq = n;
            if (si >= 0 && r[si] != null) {
                const v: any = r[si];
                const num = v instanceof Date ? v.getTime() : Number(v);
                if (isFinite(num)) seq = num;
            }
            let l = this.pickData.get(carton);
            if (!l) { l = []; this.pickData.set(carton, l); }
            l.push({ seq, loc });
        });
        this.pickData.forEach((l) => l.sort((a, b) => a.seq - b.seq));
        this.cartonIds = Array.from(this.pickData.keys()).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        this.selectedCartons = this.selectedCartons.filter((c) => this.pickData.has(c));
    }

    // Walkable floor: every rack is an obstacle on a grid, so paths follow the aisles and never cut through racking.
    private ensureGrid(): PGrid {
        if (this.grid) return this.grid;
        const ps: PSeg[] = [];
        for (const { cells: list, alongX } of this.rackSegments(this.cells)) {
            let sv = 0, u0 = Infinity, u1 = -Infinity, cross = 0, minPz = Infinity;
            for (const c of list) {
                const u = alongX ? c.px : c.py;
                const along = alongX ? c.bw : c.bd;
                sv += alongX ? c.py : c.px;
                u0 = Math.min(u0, u - along / 2);
                u1 = Math.max(u1, u + along / 2);
                cross = Math.max(cross, alongX ? c.bd : c.bw);
                minPz = Math.min(minPz, c.pz);
                c.rack = ps.length;
            }
            const v = sv / list.length, half = cross / 2 + 0.07;
            const start = u0 - 0.05, end = u1 + 0.05;
            const elev = minPz * this.lvl - this.cubeSize / 2;
            ps.push(alongX
                ? { x0: start, x1: end, z0: v - half, z1: v + half, elev, alongX, v, half }
                : { x0: v - half, x1: v + half, z0: start, z1: end, elev, alongX, v, half });
        }
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const q of ps) {
            minX = Math.min(minX, q.x0); maxX = Math.max(maxX, q.x1);
            minZ = Math.min(minZ, q.z0); maxZ = Math.max(maxZ, q.z1);
        }
        if (!ps.length) { minX = 0; maxX = 1; minZ = 0; maxZ = 1; }
        minX -= 4; minZ -= 4; maxX += 4; maxZ += 4;
        const gs = Math.max(0.5, Math.max(maxX - minX, maxZ - minZ) / 700);
        const w = Math.ceil((maxX - minX) / gs) + 1, h = Math.ceil((maxZ - minZ) / gs) + 1;
        const blocked = new Uint8Array(w * h);
        for (const q of ps) {
            const ix0 = Math.max(0, Math.round((q.x0 - minX) / gs)), ix1 = Math.min(w - 1, Math.round((q.x1 - minX) / gs));
            const iz0 = Math.max(0, Math.round((q.z0 - minZ) / gs)), iz1 = Math.min(h - 1, Math.round((q.z1 - minZ) / gs));
            for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) blocked[iz * w + ix] = 1;
        }
        this.grid = {
            gs, ox: minX, oz: minZ, w, h, blocked, segs: ps,
            stamp: new Int32Array(w * h), done: new Int32Array(w * h), g: new Float32Array(w * h),
            from: new Int32Array(w * h), dir: new Int8Array(w * h), cur: 0,
        };
        return this.grid;
    }

    private node(G: PGrid, x: number, z: number): number {
        const ix = Math.min(G.w - 1, Math.max(0, Math.round((x - G.ox) / G.gs)));
        const iz = Math.min(G.h - 1, Math.max(0, Math.round((z - G.oz) / G.gs)));
        return iz * G.w + ix;
    }

    private nodeXY(G: PGrid, id: number): [number, number] {
        return [G.ox + (id % G.w) * G.gs, G.oz + Math.floor(id / G.w) * G.gs];
    }

    // Where the picker stands: in the aisle, level with the bin, on the side nearest the previous stop.
    private standPoint(c: Cell, prev?: [number, number]): [number, number] {
        const G = this.ensureGrid();
        const seg = c.rack != null ? G.segs[c.rack] : undefined;
        if (seg) {
            const off = seg.half + G.gs * 0.75;
            const cand: [number, number][] = seg.alongX
                ? [[c.px, seg.v - off], [c.px, seg.v + off]]
                : [[seg.v - off, c.py], [seg.v + off, c.py]];
            const ok = cand.filter(([x, z]) => !G.blocked[this.node(G, x, z)]);
            if (ok.length) {
                if (prev && ok.length > 1) {
                    const d = (p: [number, number]) => Math.abs(p[0] - prev[0]) + Math.abs(p[1] - prev[1]);
                    ok.sort((a, b) => d(a) - d(b));
                }
                return this.nodeXY(G, this.node(G, ok[0][0], ok[0][1]));
            }
        }
        // fallback: the nearest free spot, searching outwards in rings
        const home = this.node(G, c.px, c.py);
        const hx = home % G.w, hz = Math.floor(home / G.w);
        for (let r = 1; r < 80; r++) {
            let best = -1, bd = Infinity;
            for (let dz = -r; dz <= r; dz++) {
                for (let dx = -r; dx <= r; dx++) {
                    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
                    const x = hx + dx, z = hz + dz;
                    if (x < 0 || z < 0 || x >= G.w || z >= G.h || G.blocked[z * G.w + x]) continue;
                    const d = dx * dx + dz * dz;
                    if (d < bd) { bd = d; best = z * G.w + x; }
                }
            }
            if (best >= 0) return this.nodeXY(G, best);
        }
        return [c.px, c.py];
    }

    // A* over the walkable grid (4-way, like walking along aisles), with a small penalty for turning.
    private aStar(s: number, t: number): number[] | null {
        const G = this.grid!;
        if (s === t) return [s];
        const { w, h, blocked } = G;
        const cur = ++G.cur;
        const ids: number[] = [], fs: number[] = [];
        const push = (id: number, f: number) => {
            let i = ids.length;
            ids.push(id); fs.push(f);
            while (i > 0) {
                const par = (i - 1) >> 1;
                if (fs[par] <= fs[i]) break;
                [ids[par], ids[i]] = [ids[i], ids[par]];
                [fs[par], fs[i]] = [fs[i], fs[par]];
                i = par;
            }
        };
        const pop = (): number => {
            const top = ids[0];
            const lastId = ids.pop()!, lastF = fs.pop()!;
            if (ids.length) {
                ids[0] = lastId; fs[0] = lastF;
                let i = 0;
                for (;;) {
                    const l = 2 * i + 1, r = l + 1;
                    let m = i;
                    if (l < ids.length && fs[l] < fs[m]) m = l;
                    if (r < ids.length && fs[r] < fs[m]) m = r;
                    if (m === i) break;
                    [ids[m], ids[i]] = [ids[i], ids[m]];
                    [fs[m], fs[i]] = [fs[i], fs[m]];
                    i = m;
                }
            }
            return top;
        };
        const tx = t % w, tz = Math.floor(t / w);
        const DX = [1, -1, 0, 0], DZ = [0, 0, 1, -1];
        G.stamp[s] = cur; G.g[s] = 0; G.from[s] = -1; G.dir[s] = -1;
        push(s, Math.abs(s % w - tx) + Math.abs(Math.floor(s / w) - tz));
        let guard = 0;
        while (ids.length && guard++ < 600000) {
            const id = pop();
            if (G.done[id] === cur) continue;
            G.done[id] = cur;
            if (id === t) {
                const out: number[] = [];
                for (let n = t; n !== -1; n = G.from[n]) out.push(n);
                return out.reverse();
            }
            const x = id % w, z = Math.floor(id / w);
            for (let d = 0; d < 4; d++) {
                const nx = x + DX[d], nz = z + DZ[d];
                if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
                const nid = nz * w + nx;
                if (blocked[nid] && nid !== t) continue;
                const ng = G.g[id] + 1 + (G.dir[id] >= 0 && G.dir[id] !== d ? 0.25 : 0);
                if (G.stamp[nid] !== cur || ng < G.g[nid]) {
                    G.stamp[nid] = cur; G.g[nid] = ng; G.from[nid] = id; G.dir[nid] = d;
                    push(nid, ng + Math.abs(nx - tx) + Math.abs(nz - tz));
                }
            }
        }
        return null;
    }

    // World points from one stand point to the next, keeping only the corners.
    private routeBetween(a: [number, number], b: [number, number]): [number, number][] {
        const G = this.ensureGrid();
        const path = this.aStar(this.node(G, a[0], a[1]), this.node(G, b[0], b[1]));
        if (!path) return [a, b]; // no walkable route found: draw a straight line
        const pts = path.map((id) => this.nodeXY(G, id));
        const out: [number, number][] = [pts[0]];
        for (let i = 1; i < pts.length - 1; i++) {
            const p = pts[i - 1], q = pts[i], r = pts[i + 1];
            if (Math.abs((q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0])) > 1e-6) out.push(q);
        }
        out.push(pts[pts.length - 1]);
        return out;
    }

    private computePaths(): void {
        this.routes = [];
        this.pickedCells = new Set();
        const pc = this.settings.pathsCard;
        if (!pc.showPaths.value || !this.selectedCartons.length || !this.cells.length) return;
        this.locIndex = new Map();
        this.cells.forEach((c, i) => { if (c.loc && !this.locIndex.has(c.loc)) this.locIndex.set(c.loc, i); });
        if (!this.locIndex.size) return;
        const G = this.ensureGrid();
        const palette = ["#E63946", "#2A7DE1", "#2A9D8F", "#F4A261", "#8E44AD", "#E91E63", "#00897B", "#6D4C41"];
        const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

        this.selectedCartons.forEach((carton, k) => {
            const color = new THREE.Color(palette[k % palette.length]);
            const stops: PathStop[] = [];
            let missing = 0;
            let prev: [number, number] | undefined;
            for (const st of this.pickData.get(carton) ?? []) {
                const ci = this.locIndex.get(st.loc);
                if (ci == null) { missing++; continue; }
                const c = this.cells[ci];
                const stand = this.standPoint(c, prev);
                prev = stand;
                const seg = c.rack != null ? G.segs[c.rack] : undefined;
                stops.push({ ci, n: stops.length + 1, stand, elev: seg ? seg.elev : c.pz * this.lvl - this.cubeSize / 2 });
                this.pickedCells.add(ci);
            }
            const lines: { a: THREE.Vector3; b: THREE.Vector3 }[] = [];
            let dist = 0;
            const lift = 0.12;
            stops.forEach((a, i) => {
                const c = this.cells[a.ci];
                const binY = c.pz * this.lvl - this.cubeSize / 2 + c.bh / 2;
                lines.push({ a: V(a.stand[0], a.elev + lift, a.stand[1]), b: V(a.stand[0], binY, a.stand[1]) }); // reach up to the bin
                lines.push({ a: V(a.stand[0], binY, a.stand[1]), b: V(c.px, binY, c.py) });
                if (i + 1 < stops.length) {
                    const b = stops[i + 1];
                    const pts = this.routeBetween(a.stand, b.stand);
                    for (let j = 0; j + 1 < pts.length; j++) {
                        lines.push({ a: V(pts[j][0], a.elev + lift, pts[j][1]), b: V(pts[j + 1][0], a.elev + lift, pts[j + 1][1]) });
                        dist += Math.abs(pts[j + 1][0] - pts[j][0]) + Math.abs(pts[j + 1][1] - pts[j][1]);
                    }
                    if (Math.abs(b.elev - a.elev) > 0.01) {
                        lines.push({ a: V(b.stand[0], a.elev + lift, b.stand[1]), b: V(b.stand[0], b.elev + lift, b.stand[1]) });
                    }
                }
            });
            this.routes.push({ carton, color, stops, lines, dist, missing });
        });
    }

    private clearPaths(): void {
        if (this.pathMesh) {
            this.scene.remove(this.pathMesh);
            this.pathMesh.geometry.dispose();
            (this.pathMesh.material as THREE.Material).dispose();
            this.pathMesh = undefined;
        }
        for (const sp of this.pathSprites) {
            this.scene.remove(sp);
            sp.material.map?.dispose();
            sp.material.dispose();
        }
        this.pathSprites = [];
    }

    private makeBadge(text: string, color: THREE.Color): THREE.Sprite {
        const cv = document.createElement("canvas");
        cv.width = 64; cv.height = 64;
        const ctx = cv.getContext("2d")!;
        ctx.beginPath();
        ctx.arc(32, 32, 28, 0, Math.PI * 2);
        ctx.fillStyle = "#" + color.getHexString();
        ctx.fill();
        ctx.lineWidth = 5;
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = `700 ${text.length > 2 ? 24 : 30}px "Segoe UI", sans-serif`;
        ctx.fillText(text, 32, 34);
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthTest: false }));
        sp.renderOrder = 12;
        return sp;
    }

    private buildPaths(): void {
        this.clearPaths();
        const all = this.routes.flatMap((r) => r.lines.map((l) => ({ l, color: r.color })));
        if (!all.length) return;
        const t = Math.max(0.03, this.settings.pathsCard.lineSize.value);
        const mesh = new THREE.InstancedMesh(
            new THREE.BoxGeometry(1, 1, 1),
            new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95, depthTest: false }),
            all.length
        );
        const m = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), sc = new THREE.Vector3();
        const dir = new THREE.Vector3(), xAxis = new THREE.Vector3(1, 0, 0);
        all.forEach(({ l, color }, i) => {
            dir.subVectors(l.b, l.a);
            const len = dir.length();
            if (len > 1e-6) q.setFromUnitVectors(xAxis, dir.clone().normalize()); else q.identity();
            pos.addVectors(l.a, l.b).multiplyScalar(0.5);
            sc.set(len + t, t, t);
            mesh.setMatrixAt(i, m.compose(pos, q, sc));
            mesh.setColorAt(i, color);
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.renderOrder = 11;
        mesh.frustumCulled = false;
        mesh.raycast = () => { /* paths never block hover or clicks */ };
        this.scene.add(mesh);
        this.pathMesh = mesh;

        for (const r of this.routes) {
            if (r.stops.length > 80) continue;
            for (const st of r.stops) {
                const c = this.cells[st.ci];
                const sp = this.makeBadge(String(st.n), r.color);
                sp.scale.set(0.95, 0.95, 1);
                sp.position.set(c.px, c.pz * this.lvl - this.cubeSize / 2 + c.bh + 0.55, c.py);
                this.scene.add(sp);
                this.pathSprites.push(sp);
            }
        }
    }

    private rebuildPaths(): void {
        this.computePaths();
        this.buildPaths();
        this.buildPathPanel();
        this.applyColors();
    }

    private refreshPaths(): void {
        this.rebuildPaths();
        this.draw();
    }

    private addCarton(id: string): void {
        if (!this.pickData.has(id) || this.selectedCartons.includes(id)) return;
        const max = Math.max(1, Math.min(8, Math.round(this.settings.pathsCard.maxCartons.value)));
        this.selectedCartons.push(id);
        while (this.selectedCartons.length > max) this.selectedCartons.shift();
        this.refreshPaths();
    }

    private buildPathPanel(): void {
        const el = this.pathEl;
        el.replaceChildren();
        const pc = this.settings.pathsCard;
        const show = pc.showPaths.value && this.cartonIds.length > 0 && this.cells.length > 0;
        el.style.display = show ? "block" : "none";
        if (!show) return;

        const mk = (tag: string, cls: string, text?: string, parent: HTMLElement = el) => {
            const d = document.createElement(tag);
            d.className = cls;
            if (text !== undefined) d.textContent = text;
            parent.appendChild(d);
            return d;
        };
        mk("div", "hm-ptitle", "Pick paths");

        const wrap = mk("div", "hm-psearch");
        const input = document.createElement("input");
        input.type = "text";
        input.placeholder = `Add a carton (${this.cartonIds.length.toLocaleString()} available)`;
        wrap.appendChild(input);
        const list = mk("div", "hm-plist", undefined, wrap);
        const hitsFor = () => {
            const t = input.value.trim().toLowerCase();
            return this.cartonIds.filter((v) => !this.selectedCartons.includes(v) && (t === "" || v.toLowerCase().includes(t)));
        };
        const refresh = () => {
            list.replaceChildren();
            const hits = hitsFor();
            hits.slice(0, 8).forEach((v) => {
                const item = mk("div", "", v, list);
                item.addEventListener("mousedown", (e) => { e.preventDefault(); this.addCarton(v); });
            });
            if (hits.length > 8) mk("div", "hm-more", `${(hits.length - 8).toLocaleString()} more, keep typing`, list);
            list.style.display = hits.length ? "block" : "none";
        };
        input.addEventListener("input", refresh);
        input.addEventListener("focus", refresh);
        input.addEventListener("blur", () => { list.style.display = "none"; });
        input.addEventListener("keydown", (e) => {
            if (e.key !== "Enter") return;
            const t = input.value.trim().toLowerCase();
            const exact = this.cartonIds.find((v) => v.toLowerCase() === t);
            const hits = hitsFor();
            if (exact) this.addCarton(exact); else if (hits.length === 1) this.addCarton(hits[0]);
        });

        const u = pc.unitsPerCell.value, label = pc.distanceUnit.value || "cells";
        for (const r of this.routes) {
            const row = mk("div", "hm-chip");
            const sw = mk("span", "hm-swatch", undefined, row);
            sw.style.background = "#" + r.color.getHexString();
            const body = mk("div", "hm-chipbody", undefined, row);
            mk("div", "hm-chipname", r.carton, body);
            let info = `${r.stops.length} stops · ${Math.round(r.dist * u).toLocaleString()} ${label}`;
            if (r.missing) info += ` · ${r.missing} location${r.missing > 1 ? "s" : ""} not found`;
            mk("div", "hm-chipinfo", info, body);
            const x = mk("button", "hm-chipx", "×", row);
            x.title = "Remove";
            x.addEventListener("click", () => {
                this.selectedCartons = this.selectedCartons.filter((c) => c !== r.carton);
                this.refreshPaths();
            });
        }

        if (this.selectedCartons.length) {
            const foot = mk("div", "hm-pfoot");
            const lab = document.createElement("label");
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = this.pathDimOverride ?? pc.dimOthers.value;
            cb.addEventListener("change", () => { this.pathDimOverride = cb.checked; this.applyColors(); this.draw(); });
            lab.appendChild(cb);
            lab.appendChild(document.createTextNode(" Dim other bins"));
            foot.appendChild(lab);
            const clr = mk("button", "hm-btn", "Clear", foot);
            clr.addEventListener("click", () => { this.selectedCartons = []; this.refreshPaths(); });
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
        this.clearPaths();
        this.clearRacking();
        this.clearLabels();
        this.clearGroupLabels();
        this.controls.dispose();
        this.renderer.dispose();
    }
}
