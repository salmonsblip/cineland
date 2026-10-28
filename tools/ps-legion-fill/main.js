const { app, core } = require("photoshop");
const { encodePNG } = require("./js/png.js");
const { buildFluxFill, workingSize } = require("./js/workflow.js");
const { ComfyClient } = require("./js/comfy.js");
const ps = require("./js/ps.js");

const $ = (id) => document.getElementById(id);
const FIELDS = ["server", "prompt", "steps", "guidance", "batch", "seed", "mp", "context", "feather", "mLeft", "mTop", "mRight", "mBottom", "overlap"];
const STORE_KEY = "legionFill.settings";

let busy = false;
let cancelled = false;
let client = null;

// ---------- settings ----------

function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(STORE_KEY) || "{}"); } catch (e) {}
  for (const f of FIELDS) if (s[f] !== undefined) $(f).value = s[f];
  if (s.mode) $("mode").selected = s.mode;
  $("fp8").checked = !!s.fp8;
  syncMode();
}

function saveSettings() {
  const s = { mode: mode(), fp8: $("fp8").checked };
  for (const f of FIELDS) s[f] = $(f).value;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) {}
}

const mode = () => $("mode").selected || "inpaint";
const num = (id, def) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : def; };
const int = (id, def, min, max) => Math.min(max, Math.max(min, Math.round(num(id, def))));

function syncMode() {
  $("outpaintBox").classList.toggle("hidden", mode() !== "outpaint");
}

// ---------- status ----------

function status(text, isError) {
  $("status").textContent = text;
  $("status").className = isError ? "err" : "";
}

function progress(v, max) {
  const bar = $("bar");
  if (v === null) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  bar.max = max; bar.value = v;
}

function setBusy(b) {
  busy = b;
  $("run").disabled = b;
  $("cancel").disabled = !b;
  $("ping").disabled = b;
}

function serverUrl() {
  let u = ($("server").value || "").trim();
  if (!u) throw new Error("Укажите адрес ComfyUI на Legion, например http://192.168.1.50:8188");
  if (!/^https?:\/\//.test(u)) u = "http://" + u;
  return u;
}

// ---------- actions ----------

async function ping() {
  try {
    const c = new ComfyClient(serverUrl());
    const st = await c.systemStats();
    const dev = (st.devices && st.devices[0]) || {};
    const gb = (b) => (b / 1024 ** 3).toFixed(1);
    status(`OK · ComfyUI ${st.system.comfyui_version || ""}\n${dev.name || ""}\nVRAM свободно ${gb(dev.vram_free || 0)} / ${gb(dev.vram_total || 0)} ГБ`);
  } catch (e) {
    status("Нет связи: " + e.message + "\nComfyUI должен быть запущен с --listen 0.0.0.0", true);
  }
}

async function run() {
  if (busy) return;
  const doc = app.activeDocument;
  if (!doc) return status("Нет открытого документа", true);

  saveSettings();
  cancelled = false;
  setBusy(true);
  progress(null);

  const isOut = mode() === "outpaint";
  const opts = {
    prompt: ($("prompt").value || "").trim(),
    steps: int("steps", 24, 1, 100),
    guidance: num("guidance", 30),
    batch: int("batch", 1, 1, 4),
    seed: int("seed", -1, -1, 2 ** 32 - 1),
    mp: Math.min(2.5, Math.max(0.25, num("mp", 1))),
    context: Math.max(0, num("context", 40)),
    feather: int("feather", 12, 0, 500),
    margins: { left: int("mLeft", 0, 0, 8192), top: int("mTop", 0, 0, 8192), right: int("mRight", 0, 0, 8192), bottom: int("mBottom", 0, 0, 8192) },
    overlap: int("overlap", 32, 0, 1024),
  };
  if (opts.seed < 0) opts.seed = Math.floor(Math.random() * 2 ** 32);
  if (isOut && !(opts.margins.left || opts.margins.top || opts.margins.right || opts.margins.bottom)) {
    setBusy(false);
    return status("Укажите, на сколько пикселей расширить холст", true);
  }

  const channel = "LegionFill_" + Date.now();
  let channelMade = false;

  try {
    client = new ComfyClient(serverUrl());

    // 1. Read pixels + mask (modal, quick).
    status(isOut ? "Расширяю холст…" : "Читаю выделение…");
    const prep = await core.executeAsModal(async (ctx) => {
      const susp = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: "Legion Fill: подготовка" });
      try {
        if (isOut) await ps.prepareOutpaint(doc, opts.margins, opts.overlap);
        const sel = await ps.getSelectionBounds(doc);
        if (!sel) throw new Error("Сначала выделите область для перерисовки");

        await ps.saveSelectionToChannel(channel);
        channelMade = true;

        const region = ps.contextRegion(doc, sel, opts.context, 32);
        const rw = region.right - region.left, rh = region.bottom - region.top;
        const work = workingSize(rw, rh, opts.mp);
        // imaging.getPixels only downsamples; small regions are read 1:1 and upscaled in ComfyUI.
        const size = work.width * work.height < rw * rh ? work : undefined;

        const img = await ps.readComposite(doc, region, size);
        const mask = await ps.readSelectionMask(doc, region, size);
        return { region, work, img, mask };
      } finally {
        await ctx.hostControl.resumeHistory(susp);
      }
    }, { commandName: "Legion Fill: подготовка" });

    const { region, work } = prep;
    const outW = region.right - region.left, outH = region.bottom - region.top;

    // 2. Upload and queue on Legion.
    status("Отправляю на Legion…");
    const stamp = Date.now();
    const imageName = await client.uploadImage(encodePNG(prep.img.pixels, prep.img.width, prep.img.height, 3), `ps_${stamp}_image.png`);
    const maskName = await client.uploadImage(encodePNG(prep.mask.pixels, prep.mask.width, prep.mask.height, 1), `ps_${stamp}_mask.png`);
    if (cancelled) throw new Error("Отменено");

    const workflow = buildFluxFill({
      image: imageName, mask: maskName, prompt: opts.prompt, seed: opts.seed, steps: opts.steps,
      guidance: opts.guidance, workW: work.width, workH: work.height, outW, outH,
      growMask: 8, batch: opts.batch, weightDtype: $("fp8").checked ? "fp8_e4m3fn" : "default",
      prefix: "photoshop/fill",
    });
    const promptId = await client.queue(workflow);

    // 3. Wait.
    const t0 = Date.now();
    status(`Генерация ${work.width}×${work.height}, ${opts.steps} шагов, сид ${opts.seed}…`);
    const stopWatch = client.watchProgress(promptId, (v, max) => {
      progress(v, max);
      status(`Генерация ${work.width}×${work.height} · шаг ${v}/${max} · ${Math.round((Date.now() - t0) / 1000)} с\nсид ${opts.seed}`);
    });
    let images;
    try {
      images = await client.waitForImages(promptId, { isCancelled: () => cancelled });
    } finally {
      stopWatch();
    }
    if (!images.length) throw new Error("ComfyUI не вернул изображений");

    // 4. Download and place as masked layers.
    status("Забираю результат…");
    const pngs = [];
    for (const im of images) pngs.push(await client.fetchImage(im));

    await core.executeAsModal(async (ctx) => {
      const susp = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: "Legion Fill" });
      try {
        for (let i = 0; i < pngs.length; i++) {
          const tag = pngs.length > 1 ? ` · v${i + 1}` : "";
          await ps.placeResult(doc, pngs[i], region, {
            layerName: `Legion Fill · ${opts.seed}${tag}`,
            channelName: channel,
            featherPx: opts.feather,
            visible: i === pngs.length - 1,
          });
        }
        // Leave the original selection active for a quick re-run.
        await ps.loadChannelAsSelection(channel);
        await ps.deleteChannel(channel);
        channelMade = false;
      } finally {
        await ctx.hostControl.resumeHistory(susp);
      }
    }, { commandName: "Legion Fill: результат" });

    const secs = Math.round((Date.now() - t0) / 1000);
    status(`Готово за ${secs} с · сид ${opts.seed} · ${pngs.length} слой(ёв)\n${images.map((i) => i.filename).join(", ")}`);
  } catch (e) {
    console.error(e);
    status((e && e.message) || String(e), true);
  } finally {
    if (channelMade) {
      try { await core.executeAsModal(() => ps.deleteChannel(channel), { commandName: "Legion Fill: очистка" }); } catch (e) {}
    }
    progress(null);
    setBusy(false);
  }
}

function cancel() {
  cancelled = true;
  if (client) client.interrupt();
  status("Останавливаю…");
}

// ---------- wiring ----------

$("run").addEventListener("click", run);
$("cancel").addEventListener("click", cancel);
$("ping").addEventListener("click", ping);
$("mode").addEventListener("change", () => { syncMode(); saveSettings(); });
for (const f of FIELDS) $(f).addEventListener("change", saveSettings);
$("fp8").addEventListener("change", saveSettings);
loadSettings();
