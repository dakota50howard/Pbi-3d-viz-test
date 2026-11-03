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
interface GroupLabel { key: string; sprite: THREE.Sprite; base: THREE.Vector3; }
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
    id: ISelectionId;
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
    private labelOffsets: Record<string, { x: number; z: number }> = {};
    private canEdit = false;
    private drag?: { label: GroupLabel; start: THREE.Vector3; from: { x: number; z: number } };

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
        this.emptyMsg.textContent = "Add X, Y and Value fields to see the 3D heatmap.";
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

        this.root.addEventListener("pointerdown", (e) => this.onLabelDown(e), true);
        this.root.addEventListener("pointermove", (e) => this.onLabelMove(e), true);
        this.root.addEventListener("pointerup", (e) => this.onLabelUp(e), true);

        this.selection.registerOnSelectCallback(() => { this.applyColors(); this.draw(); });
    }

    public update(options: VisualUpdateOptions): void {
        const dv = options.dataViews?.[0];
        this.settings = this.fmtService.populateFormattingSettingsModel(VisualFormattingSettingsModel, dv);
        this.canEdit = ((options.viewMode as number) ?? 0) >= 1; // 1 = edit mode
        this.loadOffsets(dv);

        const { width, height } = options.viewport;
        this.renderer.setSize(width, height);
        this.camera.aspect = width / Math.max(height, 1);
        this.camera.updateProjectionMatrix();

        this.cells = this.parse(dv);
        this.resolveScale();
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
    private parse(dv?: DataView): Cell[] {
        const table = dv?.table;
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
                tip: [
                    { displayName: cols[xC].displayName, value: fmt(r[xC]) },
                    { displayName: cols[yC].displayName, value: fmt(r[yC]) },
                    ...(zC >= 0 ? [{ displayName: cols[zC].displayName, value: fmt(r[zC]) }] : []),
                    ...(vC >= 0 ? [{ displayName: valueLabel, value: fmt(r[vC]) }] : []),
                    ...fC.filter((c) => c >= 0).map((c) => ({ displayName: cols[c].displayName, value: fmt(r[c]) })),
                    ...gC.filter((c) => c >= 0).map((c) => ({ displayName: cols[c].displayName, value: fmt(r[c]) })),
                    ...tipCols.map((c) => ({ displayName: cols[c].displayName, value: fmt(r[c]) })),
                ],
                id: this.host.createSelectionIdBuilder().withTable(table, i).createSelectionId(),
            } as Cell;
        });
    }

    // Thresholds come from the Color scale card (or auto-scale). The minimum is never below 0.
    private resolveScale(): void {
        const sc = this.settings.scaleCard;
        let low = sc.low.value, med = sc.medium.value, high = sc.high.value, crit = sc.critical.value;
        if (sc.auto.value) {
            const vals = this.cells.map((c) => c.value).filter((v): v is number => v != null).sort((a, b) => a - b);
            if (vals.length) {
                const lo = vals[0];
                let hi = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.95))];
                if (hi <= lo) hi = lo + 1;
                low = lo; med = lo + (hi - lo) / 3; high = lo + (2 * (hi - lo)) / 3; crit = hi;
            }
        }
        low = Math.max(0, low);
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
        const h = Math.max(0.8, span * 0.028);
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
        if (v <= stops[0].v) return stops[0].c.clone();
        for (let i = 1; i < stops.length; i++) {
            if (v <= stops[i].v) {
                const span = stops[i].v - stops[i - 1].v || 1;
                return stops[i - 1].c.clone().lerp(stops[i].c, (v - stops[i - 1].v) / span);
            }
        }
        return stops[3].c.clone();
    }

    private applyColors(): void {
        if (!this.mesh) return;
        const picked = this.selection.getSelectionIds() as ISelectionId[];
        const dim = new THREE.Color(0xd5d8dc);
        this.cells.forEach((c, i) => {
            const col = this.colorFor(c.value);
            if ((picked.length && !picked.some((p) => p.equals(c.id))) || !this.matches(c)) col.lerp(dim, 0.8);
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
            ["Low · minimum", a.low, s.lowColor.value.value],
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
        add(this.legendEl, "hm-title", this.metricName || this.valueName);
        const range = (a.crit - a.low) || 1;
        const bar = add(this.legendEl, "hm-bar");
        bar.style.background = "linear-gradient(to right," +
            stops.map(([, v, c]) => `${c} ${(((v - a.low) / range) * 100).toFixed(1)}%`).join(",") + ")";
        const ends = add(this.legendEl, "hm-ends");
        add(ends, "", fmtNum(a.low));
        add(ends, "", fmtNum(a.crit));

        const details = add(this.legendEl, "hm-details");
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

            const sel = document.createElement("select");
            sel.className = "hm-select";
            const off = document.createElement("option");
            off.value = "-1";
            off.textContent = "Off";
            sel.appendChild(off);
            for (const g of names) {
                const o = document.createElement("option");
                o.value = String(g.i);
                o.textContent = g.n;
                sel.appendChild(o);
            }
            sel.value = String(this.effectiveLabelField());
            sel.addEventListener("change", () => {
                this.labelPick = Number(sel.value);
                this.buildGroupLabels();
                this.draw();
            });
            this.viewEl.appendChild(sel);

            if (this.canEdit) {
                const hint = document.createElement("div");
                hint.className = "hm-hint";
                hint.textContent = "Drag a label to move it. Positions save with the report.";
                this.viewEl.appendChild(hint);
                const reset = document.createElement("button");
                reset.className = "hm-btn";
                reset.textContent = "Reset label positions";
                reset.addEventListener("click", () => {
                    this.labelOffsets = {};
                    this.persistOffsets();
                    this.buildGroupLabels();
                    this.draw();
                });
                this.viewEl.appendChild(reset);
            }
        }
    }

    // ---------- group labels ----------
    private effectiveLabelField(): number {
        if (this.labelPick === -1) return -1;
        if (this.labelPick >= 0 && this.groupNames[this.labelPick]) return this.labelPick;
        return this.groupNames.findIndex((n) => n !== "");
    }

    private loadOffsets(dv?: DataView): void {
        try {
            const raw = (dv?.metadata?.objects as any)?.labelData?.positions;
            this.labelOffsets = typeof raw === "string" && raw ? JSON.parse(raw) : {};
        } catch {
            this.labelOffsets = {};
        }
    }

    private persistOffsets(): void {
        this.host.persistProperties({
            merge: [{ objectName: "labelData", selector: null as any, properties: { positions: JSON.stringify(this.labelOffsets) } }],
        });
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
        if (!lab.showLabels.value || gi < 0 || !this.cells.length) return;

        const crit = this.active.crit;
        const groups = new Map<string, { sx: number; sy: number; n: number; top: number; crit: number }>();
        for (const c of this.cells) {
            const g = c.groups[gi];
            if (!g || !this.inLevel(c) || !this.matches(c)) continue;
            let a = groups.get(g);
            if (!a) { a = { sx: 0, sy: 0, n: 0, top: -Infinity, crit: 0 }; groups.set(g, a); }
            a.sx += c.px;
            a.sy += c.py;
            a.n++;
            a.top = Math.max(a.top, c.pz * this.lvl - this.cubeSize / 2 + c.bh);
            if (c.value != null && c.value >= crit) a.crit++;
        }

        let list = Array.from(groups.entries());
        if (lab.onlyCritical.value) list = list.filter(([, a]) => a.crit > 0);
        list.sort((a, b) => b[1].crit - a[1].crit || a[0].localeCompare(b[0], undefined, { numeric: true }));
        list = list.slice(0, 200); // keep the scene light

        const span = Math.max(this.ext.x, this.ext.y, this.ext.z, 10);
        const k = (Math.max(0.8, span * 0.045) * Math.max(0.2, lab.labelSize.value)) / 80;
        for (const [name, a] of list) {
            const sp = this.makeGroupLabel(name, lab.showCount.value ? `${a.crit} critical` : null, a.crit > 0, k);
            const base = new THREE.Vector3(
                a.sx / a.n + lab.nudgeX.value,
                a.top + lab.nudgeUp.value + sp.scale.y / 2,
                a.sy / a.n + lab.nudgeY.value
            );
            const key = this.groupNames[gi] + "|" + name;
            const off = this.labelOffsets[key] ?? { x: 0, z: 0 };
            sp.position.set(base.x + off.x, base.y, base.z + off.z);
            this.scene.add(sp);
            this.groupLabels.push({ key, sprite: sp, base });
        }
    }

    private pickLabel(e: PointerEvent): GroupLabel | null {
        if (!this.groupLabels.length) return null;
        const r = this.renderer.domElement.getBoundingClientRect();
        const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
        this.raycaster.setFromCamera(ndc, this.camera);
        const hit = this.raycaster.intersectObjects(this.groupLabels.map((l) => l.sprite))[0];
        return hit ? this.groupLabels.find((l) => l.sprite === hit.object) ?? null : null;
    }

    private planePoint(e: PointerEvent, y: number): THREE.Vector3 | null {
        const r = this.renderer.domElement.getBoundingClientRect();
        const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
        this.raycaster.setFromCamera(ndc, this.camera);
        const out = new THREE.Vector3();
        return this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), out) ? out : null;
    }

    private onLabelDown(e: PointerEvent): void {
        if (!this.canEdit || e.button !== 0 || e.target !== this.renderer.domElement) return;
        const label = this.pickLabel(e);
        if (!label) return;
        const start = this.planePoint(e, label.sprite.position.y);
        if (!start) return;
        this.drag = { label, start, from: { ...(this.labelOffsets[label.key] ?? { x: 0, z: 0 }) } };
        this.renderer.domElement.setPointerCapture(e.pointerId);
        this.tooltips.hide({ immediately: true, isTouchEvent: false });
        e.stopPropagation(); // keep the camera from orbiting
        e.preventDefault();
    }

    private onLabelMove(e: PointerEvent): void {
        if (this.drag) {
            e.stopPropagation();
            const d = this.drag;
            const p = this.planePoint(e, d.label.sprite.position.y);
            if (p) {
                const off = { x: d.from.x + (p.x - d.start.x), z: d.from.z + (p.z - d.start.z) };
                this.labelOffsets[d.label.key] = off;
                d.label.sprite.position.set(d.label.base.x + off.x, d.label.base.y, d.label.base.z + off.z);
                this.draw();
            }
            return;
        }
        if (this.canEdit && e.target === this.renderer.domElement && !e.buttons) {
            this.renderer.domElement.style.cursor = this.pickLabel(e) ? "grab" : "";
        }
    }

    private onLabelUp(e: PointerEvent): void {
        if (!this.drag) return;
        e.stopPropagation();
        const key = this.drag.label.key;
        const off = this.labelOffsets[key];
        if (off) this.labelOffsets[key] = { x: Math.round(off.x * 100) / 100, z: Math.round(off.z * 100) / 100 };
        this.drag = undefined;
        try { this.renderer.domElement.releasePointerCapture(e.pointerId); } catch { /* already released */ }
        this.persistOffsets();
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
                identities: [c.id],
            });
        });
    }

    private onClick(e: PointerEvent): void {
        if (Math.hypot(e.clientX - this.downPos.x, e.clientY - this.downPos.y) > 4) return; // was a drag
        const i = this.pick(e);
        if (i == null) this.selection.clear();
        else this.selection.select(this.cells[i].id, e.ctrlKey || e.metaKey);
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
