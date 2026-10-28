// Legion Fill: inpaint / outpaint in Photoshop via ComfyUI (FLUX.1 Fill) on Legion.
// ExtendScript (Photoshop CS6+, macOS). No Creative Cloud or plugin install needed:
// put this file in <Photoshop>/Presets/Scripts and bind a key in Edit > Keyboard Shortcuts.

#target photoshop

// @@core-begin  (no Photoshop dependencies; also loaded by the node tests)

var LF = {};

LF.MODELS = {
  unet: "flux1-fill-dev.safetensors",
  clip1: "clip_l.safetensors",
  clip2: "t5xxl_fp16.safetensors",
  vae: "ae.safetensors"
};

LF.DEFAULTS = {
  server: "", mode: "inpaint", prompt: "", batch: 1, seed: -1, steps: 24, guidance: 30,
  mp: 1.0, context: 40, feather: 12, overlap: 32, fp8: false,
  mLeft: 0, mTop: 0, mRight: 512, mBottom: 0
};

// ---------- JSON (ExtendScript has none) ----------

LF.stringify = function (v) {
  if (v === null || v === undefined) return "null";
  var t = typeof v;
  if (t === "number") return isFinite(v) ? String(v) : "null";
  if (t === "boolean") return v ? "true" : "false";
  if (t === "string") {
    var out = '"';
    for (var i = 0; i < v.length; i++) {
      var c = v.charAt(i), code = v.charCodeAt(i);
      if (c === '"') out += '\\"';
      else if (c === "\\") out += "\\\\";
      else if (code < 0x20 || code > 0x7e) {
        var h = code.toString(16);
        while (h.length < 4) h = "0" + h;
        out += "\\u" + h;
      } else out += c;
    }
    return out + '"';
  }
  var parts = [];
  if (v instanceof Array) {
    for (var j = 0; j < v.length; j++) parts.push(LF.stringify(v[j]));
    return "[" + parts.join(",") + "]";
  }
  for (var k in v) {
    if (v.hasOwnProperty(k) && v[k] !== undefined) parts.push(LF.stringify(k) + ":" + LF.stringify(v[k]));
  }
  return "{" + parts.join(",") + "}";
};

// Input comes only from our own settings file and the ComfyUI server.
LF.parse = function (s) {
  return eval("(" + s + ")");
};

LF.trim = function (s) {
  return String(s).replace(/^\s+|\s+$/g, "");
};

// ---------- graph (same as js/workflow.js) ----------

LF.snap16 = function (v) {
  return Math.max(256, Math.round(v / 16) * 16);
};

LF.workingSize = function (w, h, megapixels) {
  var s = Math.sqrt((megapixels * 1e6) / (w * h));
  return { width: LF.snap16(w * s), height: LF.snap16(h * s) };
};

LF.buildFluxFill = function (o) {
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: LF.MODELS.unet, weight_dtype: o.weightDtype || "default" } },
    "2": { class_type: "DualCLIPLoader", inputs: { clip_name1: LF.MODELS.clip1, clip_name2: LF.MODELS.clip2, type: "flux" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: LF.MODELS.vae } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: o.prompt || "", clip: ["2", 0] } },
    "5": { class_type: "FluxGuidance", inputs: { conditioning: ["4", 0], guidance: o.guidance } },
    "6": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } },
    "7": { class_type: "LoadImage", inputs: { image: o.image } },
    "8": { class_type: "ImageScale", inputs: { image: ["7", 0], upscale_method: "lanczos", width: o.workW, height: o.workH, crop: "disabled" } },
    "9": { class_type: "LoadImage", inputs: { image: o.mask } },
    "10": { class_type: "ImageScale", inputs: { image: ["9", 0], upscale_method: "bilinear", width: o.workW, height: o.workH, crop: "disabled" } },
    "11": { class_type: "ImageToMask", inputs: { image: ["10", 0], channel: "red" } },
    "12": { class_type: "GrowMask", inputs: { mask: ["11", 0], expand: o.growMask | 0, tapered_corners: true } },
    "13": { class_type: "DifferentialDiffusion", inputs: { model: ["1", 0] } },
    "14": {
      class_type: "InpaintModelConditioning",
      inputs: { positive: ["5", 0], negative: ["6", 0], vae: ["3", 0], pixels: ["8", 0], mask: ["12", 0], noise_mask: true }
    },
    "15": { class_type: "RepeatLatentBatch", inputs: { samples: ["14", 2], amount: Math.max(1, o.batch | 0) } },
    "16": {
      class_type: "KSampler",
      inputs: {
        model: ["13", 0], seed: o.seed, steps: o.steps, cfg: 1, sampler_name: "euler", scheduler: "normal",
        positive: ["14", 0], negative: ["14", 1], latent_image: ["15", 0], denoise: 1
      }
    },
    "17": { class_type: "VAEDecode", inputs: { samples: ["16", 0], vae: ["3", 0] } },
    "18": { class_type: "ImageScale", inputs: { image: ["17", 0], upscale_method: "lanczos", width: o.outW, height: o.outH, crop: "disabled" } },
    "19": { class_type: "SaveImage", inputs: { images: ["18", 0], filename_prefix: o.prefix || "photoshop/fill" } }
  };
};

// ---------- ComfyUI over curl ----------
// LF.exec(cmd) -> exit code and LF.readText / LF.writeText are bound per host
// (Photoshop below, node in tests).

LF.CURL = "/usr/bin/curl";

LF.q = function (s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
};

LF.Comfy = function (base, tmpDir) {
  this.base = base.replace(/\/+$/, "");
  this.tmp = tmpDir;
  this.clientId = "ps-legion-jsx-" + Math.floor(Math.random() * 1e9);
};

/** Run curl; returns the response body as text. Throws with curl's stderr on failure. */
LF.Comfy.prototype.curl = function (args, maxTime) {
  var out = this.tmp + "/lf_resp.txt", err = this.tmp + "/lf_err.txt", st = this.tmp + "/lf_status.txt";
  LF.writeText(out, "");
  LF.writeText(st, "");
  var cmd = LF.CURL + " -sS --max-time " + (maxTime || 30) + " " + args +
    " -o " + LF.q(out) + " -w '%{http_code}' > " + LF.q(st) + " 2> " + LF.q(err);
  var code = LF.exec(cmd);
  var body = LF.readText(out);
  if (code !== 0) {
    throw new Error("Нет связи с " + this.base + " (curl " + code + "): " + LF.trim(LF.readText(err)));
  }
  var http = parseInt(LF.readText(st), 10);
  if (!(http >= 200 && http < 300)) {
    var detail = body;
    try {
      var j = LF.parse(body);
      if (j.node_errors) for (var k in j.node_errors) { detail = "ошибка в графе: " + LF.stringify(j.node_errors); break; }
      if (detail === body && j.error) detail = j.error.message || LF.stringify(j.error);
    } catch (e) {}
    throw new Error("ComfyUI HTTP " + http + ": " + String(detail).substr(0, 300));
  }
  return body;
};

LF.Comfy.prototype.systemStats = function () {
  return LF.parse(this.curl(LF.q(this.base + "/system_stats"), 8));
};

LF.Comfy.prototype.upload = function (path) {
  var res = LF.parse(this.curl(
    "-F " + LF.q("image=@" + path + ";type=image/png") + " -F overwrite=true " + LF.q(this.base + "/upload/image"), 120));
  return res.subfolder ? res.subfolder + "/" + res.name : res.name;
};

LF.Comfy.prototype.queue = function (workflow) {
  var wf = this.tmp + "/lf_workflow.json";
  LF.writeText(wf, LF.stringify({ prompt: workflow, client_id: this.clientId }));
  var res = LF.parse(this.curl(
    "-H 'Content-Type: application/json' --data-binary " + LF.q("@" + wf) + " " + LF.q(this.base + "/prompt"), 30));
  if (res.node_errors) for (var k in res.node_errors) throw new Error("Ошибка в графе: " + LF.stringify(res.node_errors).substr(0, 300));
  return res.prompt_id;
};

/** One poll. Returns null while running, else the list of output images. */
LF.Comfy.prototype.poll = function (promptId) {
  var hist = LF.parse(this.curl(LF.q(this.base + "/history/" + promptId), 15));
  var job = hist[promptId];
  if (!job) return null;
  var st = job.status || {};
  if (st.status_str === "error") {
    var msgs = st.messages || [], text = "ошибка выполнения";
    for (var i = 0; i < msgs.length; i++) if (msgs[i][0] === "execution_error") text = msgs[i][1].exception_message;
    throw new Error("ComfyUI: " + text);
  }
  if (!st.completed && !job.outputs) return null;
  var images = [];
  for (var n in job.outputs) {
    var imgs = job.outputs[n].images || [];
    for (var j = 0; j < imgs.length; j++) if (imgs[j].type === "output") images.push(imgs[j]);
  }
  return images.length || st.completed ? images : null;
};

LF.Comfy.prototype.download = function (img, path) {
  var url = this.base + "/view?filename=" + encodeURIComponent(img.filename) +
    "&subfolder=" + encodeURIComponent(img.subfolder || "") + "&type=" + img.type;
  var err = this.tmp + "/lf_err.txt";
  var code = LF.exec(LF.CURL + " -sS --fail --max-time 120 -o " + LF.q(path) + " " + LF.q(url) + " 2> " + LF.q(err));
  if (code !== 0) throw new Error("Не удалось скачать " + img.filename + ": " + LF.readText(err));
};

LF.Comfy.prototype.cancel = function (promptId) {
  var body = this.tmp + "/lf_cancel.json";
  LF.writeText(body, LF.stringify({ "delete": [promptId] }));
  LF.exec(LF.CURL + " -s --max-time 5 -X POST " + LF.q(this.base + "/interrupt") + " > /dev/null 2>&1");
  LF.exec(LF.CURL + " -s --max-time 5 -H 'Content-Type: application/json' --data-binary " + LF.q("@" + body) +
    " " + LF.q(this.base + "/queue") + " > /dev/null 2>&1");
};

// @@core-end

// ---------- host bindings ----------

LF.exec = function (cmd) {
  return app.system(cmd);
};

LF.readText = function (path) {
  var f = new File(path);
  if (!f.exists) return "";
  f.encoding = "UTF-8";
  f.open("r");
  var s = f.read();
  f.close();
  return s;
};

LF.writeText = function (path, text) {
  var f = new File(path);
  f.encoding = "UTF-8";
  f.open("w");
  f.write(text);
  f.close();
};

// ---------- settings ----------

LF.settingsFile = function () {
  var dir = new Folder(Folder.userData + "/LegionFill");
  if (!dir.exists) dir.create();
  return dir.fsName + "/settings.json";
};

LF.loadSettings = function () {
  var s = {}, d = LF.DEFAULTS;
  try { s = LF.parse(LF.readText(LF.settingsFile()) || "{}"); } catch (e) {}
  for (var k in d) if (s[k] === undefined) s[k] = d[k];
  return s;
};

LF.saveSettings = function (s) {
  try { LF.writeText(LF.settingsFile(), LF.stringify(s)); } catch (e) {}
};

// ---------- Photoshop helpers ----------

function cTID(s) { return charIDToTypeID(s); }
function sTID(s) { return stringIDToTypeID(s); }
function px(v) { return v.as("px"); }

LF.saveSelectionToChannel = function (name) {
  var d = new ActionDescriptor(), r = new ActionReference();
  r.putProperty(cTID("Chnl"), cTID("fsel"));
  d.putReference(cTID("null"), r);
  d.putString(cTID("Nm  "), name);
  executeAction(cTID("Dplc"), d, DialogModes.NO);
};

LF.deleteChannel = function (doc, name) {
  try { doc.channels.getByName(name).remove(); } catch (e) {}
};

LF.selectionBounds = function (doc) {
  try {
    var b = doc.selection.bounds;
    var r = { left: Math.round(px(b[0])), top: Math.round(px(b[1])), right: Math.round(px(b[2])), bottom: Math.round(px(b[3])) };
    return r.right > r.left && r.bottom > r.top ? r : null;
  } catch (e) {
    return null;
  }
};

LF.selectRect = function (doc, r) {
  doc.selection.select([[r.left, r.top], [r.right, r.top], [r.right, r.bottom], [r.left, r.bottom]]);
};

/** Extend the canvas and select the new area plus `overlap` px of the original. */
LF.prepareOutpaint = function (doc, m, overlap) {
  var W = Math.round(px(doc.width)), H = Math.round(px(doc.height));
  if (m.left || m.top) doc.resizeCanvas(UnitValue(W + m.left, "px"), UnitValue(H + m.top, "px"), AnchorPosition.BOTTOMRIGHT);
  if (m.right || m.bottom) {
    doc.resizeCanvas(UnitValue(W + m.left + m.right, "px"), UnitValue(H + m.top + m.bottom, "px"), AnchorPosition.TOPLEFT);
  }
  LF.selectRect(doc, {
    left: m.left + (m.left ? overlap : 0),
    top: m.top + (m.top ? overlap : 0),
    right: m.left + W - (m.right ? overlap : 0),
    bottom: m.top + H - (m.bottom ? overlap : 0)
  });
  doc.selection.invert();
};

LF.contextRegion = function (doc, sel, contextPct, minPad) {
  var pad = Math.max(minPad, Math.round(Math.max(sel.right - sel.left, sel.bottom - sel.top) * contextPct / 100));
  return {
    left: Math.max(0, sel.left - pad),
    top: Math.max(0, sel.top - pad),
    right: Math.min(Math.round(px(doc.width)), sel.right + pad),
    bottom: Math.min(Math.round(px(doc.height)), sel.bottom + pad)
  };
};

LF.solid = function (r, g, b) {
  var c = new SolidColor();
  c.rgb.red = r; c.rgb.green = g; c.rgb.blue = b;
  return c;
};

/**
 * Export the region (flattened) and the selection mask as PNGs, scaled to `size` if given.
 * Works on a temporary duplicate, so the user's document is untouched.
 */
LF.exportRegion = function (doc, region, size, channelName, imagePath, maskPath) {
  var dup = doc.duplicate("legion_fill_tmp");
  try {
    if (dup.mode !== DocumentMode.RGB) dup.changeMode(ChangeMode.RGB);
    if (dup.bitsPerChannel !== BitsPerChannelType.EIGHT) dup.bitsPerChannel = BitsPerChannelType.EIGHT;
    dup.flatten();
    dup.crop([UnitValue(region.left, "px"), UnitValue(region.top, "px"), UnitValue(region.right, "px"), UnitValue(region.bottom, "px")]);
    if (size) dup.resizeImage(UnitValue(size.width, "px"), UnitValue(size.height, "px"), null, ResampleMethod.BICUBIC);

    var png = new PNGSaveOptions();
    dup.saveAs(new File(imagePath), png, true, Extension.LOWERCASE);

    // Mask: white where the selection is, black elsewhere (soft edges kept).
    dup.selection.selectAll();
    dup.selection.fill(LF.solid(0, 0, 0));
    dup.selection.load(dup.channels.getByName(channelName));
    dup.selection.fill(LF.solid(255, 255, 255));
    dup.selection.deselect();
    dup.saveAs(new File(maskPath), png, true, Extension.LOWERCASE);
  } finally {
    dup.close(SaveOptions.DONOTSAVECHANGES);
  }
};

LF.maskFromSelection = function () {
  var d = new ActionDescriptor(), r = new ActionReference();
  d.putClass(cTID("Nw  "), cTID("Chnl"));
  r.putEnumerated(cTID("Chnl"), cTID("Chnl"), cTID("Msk "));
  d.putReference(cTID("At  "), r);
  d.putEnumerated(cTID("Usng"), cTID("UsrM"), cTID("RvlS"));
  executeAction(cTID("Mk  "), d, DialogModes.NO);
};

/** Bring a result PNG into `doc` as a masked layer at the region's top-left. */
LF.placeResult = function (doc, path, region, name, channelName, featherPx) {
  var res = app.open(new File(path));
  var layer;
  try {
    var src = res.activeLayer;
    if (src.isBackgroundLayer) src.isBackgroundLayer = false;
    layer = src.duplicate(doc, ElementPlacement.PLACEATBEGINNING);
  } finally {
    res.close(SaveOptions.DONOTSAVECHANGES);
    app.activeDocument = doc;
  }
  layer.name = name;
  doc.activeLayer = layer;
  var b = layer.bounds;
  var dx = region.left - Math.round(px(b[0])), dy = region.top - Math.round(px(b[1]));
  if (dx || dy) layer.translate(UnitValue(dx, "px"), UnitValue(dy, "px"));

  doc.selection.load(doc.channels.getByName(channelName));
  if (featherPx > 0) {
    doc.selection.expand(UnitValue(Math.round(featherPx / 2), "px"));
    doc.selection.feather(UnitValue(featherPx, "px"));
  }
  LF.maskFromSelection();
  return layer;
};

// ---------- UI ----------

LF.num = function (text, def, min, max) {
  var v = parseFloat(String(text).replace(",", "."));
  if (isNaN(v)) v = def;
  return Math.min(max, Math.max(min, v));
};

/** Prompt dialog. Returns updated settings or null when cancelled. */
LF.dialog = function (s, hasSelection) {
  var w = new Window("dialog", "Legion Fill · FLUX Fill на Legion");
  w.orientation = "column";
  w.alignChildren = "fill";

  var mode = w.add("group");
  var rIn = mode.add("radiobutton", undefined, "Инпейнт (выделение)");
  var rOut = mode.add("radiobutton", undefined, "Аутпейнт (расширить холст)");
  rIn.value = s.mode !== "outpaint";
  rOut.value = !rIn.value;

  w.add("statictext", undefined, "Что должно появиться (пусто — дорисовать по контексту):");
  var prompt = w.add("edittext", undefined, s.prompt);
  prompt.characters = 52;
  prompt.active = true;

  var margins = w.add("panel", undefined, "Добавить по краям, px");
  margins.orientation = "row";
  var mf = {};
  var labels = [["mLeft", "слева"], ["mTop", "сверху"], ["mRight", "справа"], ["mBottom", "снизу"]];
  for (var i = 0; i < labels.length; i++) {
    margins.add("statictext", undefined, labels[i][1]);
    mf[labels[i][0]] = margins.add("edittext", undefined, String(s[labels[i][0]]));
    mf[labels[i][0]].characters = 5;
  }

  var row = w.add("group");
  row.add("statictext", undefined, "Варианты:");
  var batch = row.add("dropdownlist", undefined, ["1", "2", "3", "4"]);
  batch.selection = Math.max(0, Math.min(3, (s.batch | 0) - 1));
  row.add("statictext", undefined, "Сид (-1 = случайный):");
  var seed = row.add("edittext", undefined, String(s.seed));
  seed.characters = 11;

  var more = w.add("panel", undefined, "Настройки");
  more.alignChildren = "left";
  var srv = more.add("group");
  srv.add("statictext", undefined, "Сервер ComfyUI:");
  var server = srv.add("edittext", undefined, s.server || "http://192.168.1.50:8188");
  server.characters = 30;
  var test = srv.add("button", undefined, "Проверить");

  var adv = more.add("group");
  var fields = {};
  var spec = [["steps", "Шаги"], ["guidance", "Guidance"], ["mp", "Мпикс"], ["context", "Контекст %"], ["feather", "Растушёвка"], ["overlap", "Нахлёст"]];
  for (var j = 0; j < spec.length; j++) {
    adv.add("statictext", undefined, spec[j][1]);
    fields[spec[j][0]] = adv.add("edittext", undefined, String(s[spec[j][0]]));
    fields[spec[j][0]].characters = 4;
  }
  var fp8 = more.add("checkbox", undefined, "FP8-веса (быстрее, меньше VRAM, чуть ниже качество)");
  fp8.value = !!s.fp8;

  var btns = w.add("group");
  btns.alignment = "right";
  btns.add("button", undefined, "Отмена", { name: "cancel" });
  var ok = btns.add("button", undefined, "Сгенерировать", { name: "ok" });

  function sync() {
    margins.enabled = rOut.value;
    ok.enabled = rOut.value || hasSelection;
    ok.text = !rOut.value && !hasSelection ? "Нет выделения" : "Сгенерировать";
  }
  rIn.onClick = rOut.onClick = sync;
  sync();

  test.onClick = function () {
    try {
      var st = new LF.Comfy(LF.trim(server.text), Folder.temp.fsName).systemStats();
      var dev = (st.devices && st.devices[0]) || {};
      alert("Связь есть.\nComfyUI " + (st.system.comfyui_version || "") + "\n" + (dev.name || "") +
        "\nVRAM свободно: " + ((dev.vram_free || 0) / 1073741824).toFixed(1) + " ГБ");
    } catch (e) {
      alert("Нет связи: " + e.message + "\n\nComfyUI на Legion должен быть запущен с --listen 0.0.0.0", "Legion Fill", true);
    }
  };

  if (w.show() !== 1) return null;

  s.mode = rOut.value ? "outpaint" : "inpaint";
  s.prompt = prompt.text;
  s.server = LF.trim(server.text);
  if (s.server && !/^https?:\/\//.test(s.server)) s.server = "http://" + s.server;
  s.batch = batch.selection.index + 1;
  s.seed = Math.round(LF.num(seed.text, -1, -1, 4294967295));
  s.steps = Math.round(LF.num(fields.steps.text, 24, 1, 100));
  s.guidance = LF.num(fields.guidance.text, 30, 0, 100);
  s.mp = LF.num(fields.mp.text, 1, 0.25, 2.5);
  s.context = LF.num(fields.context.text, 40, 0, 300);
  s.feather = Math.round(LF.num(fields.feather.text, 12, 0, 500));
  s.overlap = Math.round(LF.num(fields.overlap.text, 32, 0, 1024));
  s.fp8 = fp8.value;
  for (var k in mf) s[k] = Math.round(LF.num(mf[k].text, 0, 0, 8192));
  return s;
};

LF.progress = function () {
  var w = new Window("palette", "Legion Fill");
  w.orientation = "column";
  w.alignChildren = "fill";
  w.msg = w.add("statictext", undefined, "", { multiline: true });
  w.msg.preferredSize = [340, 36];
  w.bar = w.add("progressbar", undefined, 0, 100);
  var stop = w.add("button", undefined, "Стоп (Esc)");
  w.cancelled = false;
  stop.onClick = function () { w.cancelled = true; };
  w.show();
  return w;
};

LF.say = function (w, text, pct) {
  w.msg.text = text;
  if (pct !== undefined) w.bar.value = pct;
  w.update();
};

LF.isCancelled = function (w) {
  try { if (ScriptUI.environment.keyboardState.keyName === "Escape") w.cancelled = true; } catch (e) {}
  return w.cancelled;
};

LF.wait = function (w, ms) {
  for (var t = 0; t < ms && !LF.isCancelled(w); t += 100) {
    $.sleep(100);
    w.update();
  }
};

// ---------- main ----------

/** Runs inside doc.suspendHistory, so the whole operation is one undo step. */
LF.main = function () {
  var c = LF.ctx, doc = c.doc, s = c.s;
  var tmp = Folder.temp.fsName;
  var stamp = new Date().getTime();
  var channel = "LegionFill_" + stamp;
  var channelMade = false, origSize = null, win = null, temps = [];

  try {
    if (s.mode === "outpaint") {
      if (!(s.mLeft || s.mTop || s.mRight || s.mBottom)) throw new Error("Укажите, на сколько пикселей расширить холст");
      origSize = { w: Math.round(px(doc.width)), h: Math.round(px(doc.height)) };
      LF.prepareOutpaint(doc, { left: s.mLeft, top: s.mTop, right: s.mRight, bottom: s.mBottom }, s.overlap);
    }
    var sel = LF.selectionBounds(doc);
    if (!sel) throw new Error("Сначала выделите область для перерисовки");

    LF.saveSelectionToChannel(channel);
    channelMade = true;

    var region = LF.contextRegion(doc, sel, s.context, 32);
    var rw = region.right - region.left, rh = region.bottom - region.top;
    var work = LF.workingSize(rw, rh, s.mp);
    var size = work.width * work.height < rw * rh ? work : null; // small regions are upscaled in ComfyUI

    win = LF.progress();
    LF.say(win, "Готовлю область " + rw + "×" + rh + "…", 2);
    var imgPath = tmp + "/ps_" + stamp + "_image.png", maskPath = tmp + "/ps_" + stamp + "_mask.png";
    temps.push(imgPath, maskPath);
    LF.exportRegion(doc, region, size, channel, imgPath, maskPath);
    app.activeDocument = doc;

    if (!s.server) throw new Error("Укажите адрес ComfyUI на Legion в настройках");
    var comfy = new LF.Comfy(s.server, tmp);
    LF.say(win, "Отправляю на Legion…", 5);
    var imageName = comfy.upload(imgPath);
    var maskName = comfy.upload(maskPath);

    var id = comfy.queue(LF.buildFluxFill({
      image: imageName, mask: maskName, prompt: s.prompt, seed: c.seed, steps: s.steps, guidance: s.guidance,
      workW: work.width, workH: work.height, outW: rw, outH: rh, growMask: 8, batch: s.batch,
      weightDtype: s.fp8 ? "fp8_e4m3fn" : "default", prefix: "photoshop/fill"
    }));

    // No HTTP progress endpoint in ComfyUI: show elapsed time against a rough estimate.
    var t0 = new Date().getTime(), estimate = 15 + s.steps * 2.5 * s.batch * work.width * work.height / 1e6;
    var images = null;
    while (!images) {
      if (LF.isCancelled(win)) { comfy.cancel(id); throw new Error("Отменено"); }
      var secs = Math.round((new Date().getTime() - t0) / 1000);
      LF.say(win, "Генерация " + work.width + "×" + work.height + ", " + s.steps + " шагов · " + secs + " с\nсид " + c.seed + " · Esc — стоп",
        Math.min(95, 5 + 90 * secs / estimate));
      images = comfy.poll(id);
      if (!images) LF.wait(win, 1500);
    }
    if (!images.length) throw new Error("ComfyUI не вернул изображений");

    var layers = [];
    for (var i = 0; i < images.length; i++) {
      LF.say(win, "Забираю результат " + (i + 1) + "/" + images.length + "…", 97);
      var out = tmp + "/lf_result_" + stamp + "_" + i + ".png";
      temps.push(out);
      comfy.download(images[i], out);
      var tag = images.length > 1 ? " · v" + (i + 1) : "";
      layers.push(LF.placeResult(doc, out, region, "Legion Fill · " + c.seed + tag, channel, s.feather));
    }
    for (var v = 0; v < layers.length - 1; v++) layers[v].visible = false;

    // Leave the original selection active for a quick re-run.
    doc.selection.load(doc.channels.getByName(channel));
    c.result = { seed: c.seed, count: layers.length, secs: Math.round((new Date().getTime() - t0) / 1000), files: images };
  } catch (e) {
    c.error = e;
    if (origSize) {
      try {
        doc.selection.deselect();
        doc.crop([UnitValue(s.mLeft, "px"), UnitValue(s.mTop, "px"),
          UnitValue(s.mLeft + origSize.w, "px"), UnitValue(s.mTop + origSize.h, "px")]);
      } catch (e2) {}
    }
  } finally {
    if (channelMade) LF.deleteChannel(doc, channel);
    if (win) win.close();
    for (var t = 0; t < temps.length; t++) try { new File(temps[t]).remove(); } catch (e3) {}
  }
};

LF.run = function () {
  if (!app.documents.length) return alert("Откройте документ", "Legion Fill");
  var doc = app.activeDocument;
  var s = LF.dialog(LF.loadSettings(), !!LF.selectionBounds(doc));
  if (!s) return;
  LF.saveSettings(s);

  LF.ctx = { doc: doc, s: s, seed: s.seed < 0 ? Math.floor(Math.random() * 4294967295) : s.seed, error: null, result: null };
  var units = app.preferences.rulerUnits, dialogs = app.displayDialogs;
  app.preferences.rulerUnits = Units.PIXELS;
  app.displayDialogs = DialogModes.NO;
  try {
    doc.suspendHistory("Legion Fill", "LF.main()");
  } catch (e) {
    LF.ctx.error = LF.ctx.error || e;
  } finally {
    app.preferences.rulerUnits = units;
    app.displayDialogs = dialogs;
  }

  var err = LF.ctx.error;
  if (err && err.message !== "Отменено") alert("Legion Fill: " + (err.message || err) + (err.line ? " (строка " + err.line + ")" : ""), "Legion Fill", true);
};

LF.run();
