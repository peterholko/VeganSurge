// Markup (drawing) manager. Drawings are stored in DATA coordinates
// (timestamp + price) so they stay anchored through pan/zoom and reloads.
// Rendered on the dedicated #markup canvas after every chart render.

const TOOL_DEFS = [
  { id: "trend", icon: "╱", title: "Trend line" },
  { id: "hline", icon: "─", title: "Horizontal line" },
  { id: "vline", icon: "│", title: "Vertical line" },
  { id: "rect", icon: "▭", title: "Rectangle" },
  { id: "ellipse", icon: "◯", title: "Ellipse" },
  { id: "free", icon: "〰", title: "Freehand" },
];

export class Markup {
  constructor(chart, canvas) {
    this.chart = chart;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.tool = null; // active drawing tool id, null = off
    this.visible = true;
    this.color = "#e8590c";
    this.symbol = null;
    this.shapes = [];
    this.redo = [];
    this.pending = null; // shape being drawn
    chart.afterRender = () => this.draw();
    this._bind();
  }

  setSymbol(symbol) {
    if (symbol === this.symbol) return;
    this.symbol = symbol;
    try {
      this.shapes = JSON.parse(localStorage.getItem("vs.markup." + symbol)) || [];
    } catch {
      this.shapes = [];
    }
    this.redo = [];
    this.draw();
  }

  save() {
    if (!this.symbol) return;
    localStorage.setItem("vs.markup." + this.symbol, JSON.stringify(this.shapes));
  }

  setTool(id) {
    this.tool = id;
    this.canvas.style.pointerEvents = id ? "auto" : "none";
    // the #overlay canvas sits above #markup in the DOM and would swallow
    // every pointer event — lift the markup canvas while a tool is active
    this.canvas.style.zIndex = id ? "4" : "";
    this.canvas.style.cursor = id ? "crosshair" : "default";
  }

  undo() {
    if (this.shapes.length) {
      this.redo.push(this.shapes.pop());
      this.save();
      this.draw();
    }
  }
  redoOne() {
    if (this.redo.length) {
      this.shapes.push(this.redo.pop());
      this.save();
      this.draw();
    }
  }
  clear() {
    if (!this.shapes.length) return;
    this.redo = this.shapes.reverse();
    this.shapes = [];
    this.save();
    this.draw();
  }
  setVisible(on) {
    this.visible = on;
    this.draw();
  }

  // ---- coordinate mapping (data <-> screen) ----
  toXY(pt) {
    const c = this.chart;
    return { x: c.indexToX(c._indexOfTime(pt.t) + (pt.fi || 0)), y: c.priceToY(pt.p) };
  }
  fromXY(x, y) {
    const c = this.chart;
    const idx = c.xToIndex(x);
    const i = Math.max(0, Math.min(c.n - 1, Math.round(idx)));
    return { t: c.bars.t[i], fi: idx - Math.round(idx), p: c.yToPrice(y) };
  }

  _bind() {
    const el = this.canvas;
    el.style.pointerEvents = "none";
    el.addEventListener("pointerdown", (e) => {
      if (!this.tool || !this.chart.bars) return;
      const r = el.getBoundingClientRect();
      const pt = this.fromXY(e.clientX - r.left, e.clientY - r.top);
      this.pending =
        this.tool === "free"
          ? { type: "free", color: this.color, pts: [pt] }
          : { type: this.tool, color: this.color, a: pt, b: pt };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointermove", (e) => {
      if (!this.pending) return;
      const r = el.getBoundingClientRect();
      const pt = this.fromXY(e.clientX - r.left, e.clientY - r.top);
      if (this.pending.type === "free") this.pending.pts.push(pt);
      else this.pending.b = pt;
      this.draw();
    });
    el.addEventListener("pointerup", (e) => {
      if (!this.pending) return;
      const s = this.pending;
      this.pending = null;
      // discard zero-size shapes (a stray click with no drag draws nothing
      // but would silently clutter the undo stack)
      const isClick = s.type === "free" ? s.pts.length < 2 : s.a.t === s.b.t && s.a.p === s.b.p;
      if (!isClick || s.type === "hline" || s.type === "vline") {
        this.shapes.push(s);
        this.redo = [];
        this.save();
      }
      this.draw();
      el.releasePointerCapture(e.pointerId);
    });
  }

  draw() {
    const c = this.chart;
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== c.canvas.width || this.canvas.height !== c.canvas.height) {
      this.canvas.width = c.canvas.width;
      this.canvas.height = c.canvas.height;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, c.w, c.h);
    if (!this.visible || !c.bars) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, c.pricePane.w, c.dateAxisY);
    ctx.clip();
    for (const s of [...this.shapes, this.pending].filter(Boolean)) this._drawShape(ctx, s);
    ctx.restore();
  }

  _drawShape(ctx, s) {
    const c = this.chart;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = ctx.lineCap = "round";
    ctx.beginPath();
    if (s.type === "free") {
      s.pts.forEach((p, i) => {
        const { x, y } = this.toXY(p);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
    } else {
      const A = this.toXY(s.a), B = this.toXY(s.b);
      if (s.type === "trend") {
        ctx.moveTo(A.x, A.y);
        ctx.lineTo(B.x, B.y);
      } else if (s.type === "hline") {
        ctx.moveTo(0, A.y);
        ctx.lineTo(c.pricePane.w, A.y);
      } else if (s.type === "vline") {
        ctx.moveTo(A.x, c.pricePane.y);
        ctx.lineTo(A.x, c.dateAxisY);
      } else if (s.type === "rect") {
        ctx.rect(Math.min(A.x, B.x), Math.min(A.y, B.y), Math.abs(B.x - A.x), Math.abs(B.y - A.y));
      } else if (s.type === "ellipse") {
        ctx.ellipse((A.x + B.x) / 2, (A.y + B.y) / 2, Math.abs(B.x - A.x) / 2 || 1, Math.abs(B.y - A.y) / 2 || 1, 0, 0, Math.PI * 2);
      }
    }
    ctx.stroke();
  }
}

export { TOOL_DEFS };
