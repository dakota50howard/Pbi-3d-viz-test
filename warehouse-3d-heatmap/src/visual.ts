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

interface Cell {
    value: number | null;
    xi: number; yi: number; zi: number;
    tip: { displayName: string; value: string }[];
    id: ISelectionId;
}

export class Visual implements IVisual {
    private host: IVisualHost;
    private selection: ISelectionManager;
    private tooltips: ITooltipService;
    private fmtService = new FormattingSettingsService();
    private settings!: VisualFormattingSettingsModel;

    private root: HTMLElement;
    private emptyMsg: HTMLElement;
    private legendEl: HTMLElement;
    private renderer: THREE.WebGLRenderer;
    private scene = new THREE.Scene();
    private camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    private controls: OrbitControls;
    private raycaster = new THREE.Raycaster();

    private mesh?: THREE.InstancedMesh;
    private floor?: THREE.Mesh;
    private cells: Cell[] = [];
    private valueName = "Value";
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
        this.renderer.setSize(width, height);
        this.camera.aspect = width / Math.max(height, 1);
        this.camera.updateProjectionMatrix();

        this.cells = this.parse(dv);
        this.emptyMsg.style.display = this.cells.length ? "none" : "flex";
        this.build();
        this.buildLegend();
        this.draw();
    }

    public getFormattingModel(): powerbi.visuals.FormattingModel {
        return this.fmtService.buildFormattingModel(this.settings);
    }

    // ---------- data ----------
    private parse(dv?: DataView): Cell[] {
        const table = dv?.table;
        if (!table || !table.rows?.length) return [];

        const cols = table.columns;
        const idx = (role: string) => cols.findIndex((c) => c.roles && c.roles[role]);
        const xC = idx("x"), yC = idx("y"), zC = idx("z"), vC = idx("value");
        const tipCols = cols.map((c, i) => (c.roles?.tooltips ? i : -1)).filter((i) => i >= 0);
        if (xC < 0 || yC < 0) return [];
        this.valueName = vC >= 0 ? cols[vC].displayName : "Value";

        const rank = (col: number) => {
            if (col < 0) return new Map<string, number>([["", 0]]);
            const uniq = Array.from(new Set(table.rows.map((r) => r[col] as any)));
            uniq.sort((a: any, b: any) => {
                if (typeof a === "number" && typeof b === "number") return a - b;
                if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
                return String(a).localeCompare(String(b), undefined, { numeric: true });
            });
            return new Map(uniq.map((v, i) => [String(v), i] as [string, number]));
        };
        const xr = rank(xC), yr = rank(yC), zr = rank(zC);

        const fmt = (v: any) => (v == null ? "" : String(v));
        return table.rows.map((r, i) => ({
            value: vC >= 0 && r[vC] != null ? Number(r[vC]) : null,
            xi: xr.get(String(r[xC])) ?? 0,
            yi: yr.get(String(r[yC])) ?? 0,
            zi: zC >= 0 ? zr.get(String(r[zC])) ?? 0 : 0,
            tip: [
                { displayName: cols[xC].displayName, value: fmt(r[xC]) },
                { displayName: cols[yC].displayName, value: fmt(r[yC]) },
                ...(zC >= 0 ? [{ displayName: cols[zC].displayName, value: fmt(r[zC]) }] : []),
                ...(vC >= 0 ? [{ displayName: cols[vC].displayName, value: fmt(r[vC]) }] : []),
                ...tipCols.map((c) => ({ displayName: cols[c].displayName, value: fmt(r[c]) })),
            ],
            id: this.host.createSelectionIdBuilder().withTable(table, i).createSelectionId(),
        }));
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
        if (!this.cells.length) return;

        const lay = this.settings.layoutCard;
        const size = Math.min(1, Math.max(0.2, lay.cubeSize.value));
        const lvl = Math.max(1, lay.levelSpacing.value);

        let nx = 0, ny = 0, nz = 0;
        for (const c of this.cells) { nx = Math.max(nx, c.xi + 1); ny = Math.max(ny, c.yi + 1); nz = Math.max(nz, c.zi + 1); }

        this.mesh = new THREE.InstancedMesh(
            new THREE.BoxGeometry(1, 1, 1),
            new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 }),
            this.cells.length
        );
        const m = new THREE.Matrix4();
        const scale = new THREE.Vector3(size, size, size);
        const q = new THREE.Quaternion();
        this.cells.forEach((c, i) => {
            m.compose(new THREE.Vector3(c.xi, c.zi * lvl, c.yi), q, scale);
            this.mesh!.setMatrixAt(i, m);
        });
        this.mesh.instanceMatrix.needsUpdate = true;
        this.scene.add(this.mesh);

        if (lay.showFloor.value) {
            this.floor = new THREE.Mesh(
                new THREE.PlaneGeometry(nx + 3, ny + 3),
                new THREE.MeshBasicMaterial({ color: 0xcfd2d6, transparent: true, opacity: 0.55, side: THREE.DoubleSide })
            );
            this.floor.rotation.x = -Math.PI / 2;
            this.floor.position.set((nx - 1) / 2, -size / 2 - 0.05, (ny - 1) / 2);
            this.scene.add(this.floor);
        }

        this.applyColors();

        // re-frame the camera only when the grid shape changes
        const dims = `${nx}x${ny}x${nz}`;
        if (dims !== this.lastDims) {
            this.lastDims = dims;
            const cx = (nx - 1) / 2, cy = ((nz - 1) * lvl) / 2, cz = (ny - 1) / 2;
            const span = Math.max(nx, ny, nz * lvl);
            this.controls.target.set(cx, cy, cz);
            this.camera.position.set(cx + span * 0.35, cy + span * 1.05, cz + span * 1.0);
            this.camera.far = span * 20;
            this.camera.updateProjectionMatrix();
            this.controls.update();
        }
    }

    // ---------- color ----------
    private colorFor(v: number | null): THREE.Color {
        const s = this.settings.scaleCard;
        const stops = [
            { v: s.low.value, c: new THREE.Color(s.lowColor.value.value) },
            { v: s.medium.value, c: new THREE.Color(s.mediumColor.value.value) },
            { v: s.high.value, c: new THREE.Color(s.highColor.value.value) },
            { v: s.critical.value, c: new THREE.Color(s.criticalColor.value.value) },
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
            if (picked.length && !picked.some((p) => p.equals(c.id))) col.lerp(dim, 0.8);
            this.mesh!.setColorAt(i, col);
        });
        if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }

    private buildLegend(): void {
        const lay = this.settings.layoutCard;
        this.legendEl.style.display = lay.showLegend.value && this.cells.length ? "block" : "none";
        this.legendEl.replaceChildren();
        const s = this.settings.scaleCard;
        const stops: [string, number, string][] = [
            ["Low · minimum", s.low.value, s.lowColor.value.value],
            ["Medium", s.medium.value, s.mediumColor.value.value],
            ["High", s.high.value, s.highColor.value.value],
            ["Critical", s.critical.value, s.criticalColor.value.value],
        ];
        const add = (parent: HTMLElement, cls: string, text?: string) => {
            const d = document.createElement("div");
            d.className = cls;
            if (text !== undefined) d.textContent = text;
            parent.appendChild(d);
            return d;
        };
        add(this.legendEl, "hm-title", this.valueName);
        const range = (s.critical.value - s.low.value) || 1;
        const bar = add(this.legendEl, "hm-bar");
        bar.style.background = "linear-gradient(to right," +
            stops.map(([, v, c]) => `${c} ${(((v - s.low.value) / range) * 100).toFixed(1)}%`).join(",") + ")";
        const ends = add(this.legendEl, "hm-ends");
        add(ends, "", String(s.low.value));
        add(ends, "", String(s.critical.value));

        const details = add(this.legendEl, "hm-details");
        for (const [label, v, c] of stops) {
            const row = add(details, "hm-row");
            const left = add(row, "");
            const sw = document.createElement("span");
            sw.className = "hm-swatch";
            sw.style.background = c;
            left.appendChild(sw);
            left.appendChild(document.createTextNode(label));
            add(row, "", String(v));
        }
    }

    // ---------- interaction ----------
    private pick(e: PointerEvent): number | null {
        if (!this.mesh) return null;
        const r = this.renderer.domElement.getBoundingClientRect();
        const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
        this.raycaster.setFromCamera(ndc, this.camera);
        const hit = this.raycaster.intersectObject(this.mesh)[0];
        return hit?.instanceId ?? null;
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
        this.controls.dispose();
        this.renderer.dispose();
    }
}
