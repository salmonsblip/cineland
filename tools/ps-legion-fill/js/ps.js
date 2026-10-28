// Photoshop side: selection, canvas, pixel export and result placement.
// Every function here must run inside core.executeAsModal.

const { app, action, imaging } = require("photoshop");
const { storage } = require("uxp");

const px = (v) => ({ _unit: "pixelsUnit", _value: v });
const play = (descs) => action.batchPlay(descs, {});

/** Selection bounds in pixels, or null when nothing is selected. */
async function getSelectionBounds(doc) {
  const [res] = await play([
    { _obj: "get", _target: [{ _property: "selection" }, { _ref: "document", _id: doc.id }] },
  ]);
  const s = res && res.selection;
  if (!s || s.top === undefined) return null;
  const v = (x) => Math.round(typeof x === "object" ? x._value : x);
  const r = { left: v(s.left), top: v(s.top), right: v(s.right), bottom: v(s.bottom) };
  return r.right > r.left && r.bottom > r.top ? r : null;
}

function selectRect(r) {
  return play([{
    _obj: "set",
    _target: [{ _ref: "channel", _property: "selection" }],
    to: { _obj: "rectangle", top: px(r.top), left: px(r.left), bottom: px(r.bottom), right: px(r.right) },
  }]);
}

function deselect() {
  return play([{ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _enum: "ordinal", _value: "none" } }]);
}

async function saveSelectionToChannel(name) {
  await play([{ _obj: "duplicate", _target: [{ _ref: "channel", _property: "selection" }], name }]);
}

async function loadChannelAsSelection(name) {
  await play([{
    _obj: "set",
    _target: [{ _ref: "channel", _property: "selection" }],
    to: { _ref: "channel", _name: name },
  }]);
}

async function deleteChannel(name) {
  try { await play([{ _obj: "delete", _target: [{ _ref: "channel", _name: name }] }]); } catch (e) {}
}

/** Grow + feather the current selection (for a soft layer-mask edge). */
async function softenSelection(featherPx) {
  if (featherPx <= 0) return;
  await play([
    { _obj: "expand", by: px(Math.round(featherPx / 2)), selectionModifyEffectAtCanvasBounds: true },
    { _obj: "feather", radius: px(featherPx), selectionModifyEffectAtCanvasBounds: true },
  ]);
}

function canvasSize(width, height, horizontal, vertical) {
  return play([{
    _obj: "canvasSize",
    width: px(width),
    height: px(height),
    horizontal: { _enum: "horizontalLocation", _value: horizontal },
    vertical: { _enum: "verticalLocation", _value: vertical },
  }]);
}

/**
 * Extend the canvas by the given margins and select the new area,
 * reaching `overlap` px into the original image so the seam gets repainted.
 */
async function prepareOutpaint(doc, m, overlap) {
  const W = doc.width, H = doc.height;
  if (m.left || m.top) await canvasSize(W + m.left, H + m.top, "right", "bottom");
  if (m.right || m.bottom) await canvasSize(W + m.left + m.right, H + m.top + m.bottom, "left", "top");

  const inner = {
    left: m.left + (m.left ? overlap : 0),
    top: m.top + (m.top ? overlap : 0),
    right: m.left + W - (m.right ? overlap : 0),
    bottom: m.top + H - (m.bottom ? overlap : 0),
  };
  await selectRect(inner);
  await play([{ _obj: "inverse" }]);
}

/** Region around `sel` with context padding, clamped to the document. */
function contextRegion(doc, sel, contextPct, minPad) {
  const pad = Math.max(minPad, Math.round(Math.max(sel.right - sel.left, sel.bottom - sel.top) * contextPct / 100));
  return {
    left: Math.max(0, sel.left - pad),
    top: Math.max(0, sel.top - pad),
    right: Math.min(doc.width, sel.right + pad),
    bottom: Math.min(doc.height, sel.bottom + pad),
  };
}

/** Composite RGB pixels of `rect`, scaled to `size`. Transparency goes to mid-gray. */
async function readComposite(doc, rect, size) {
  const { imageData } = await imaging.getPixels({
    documentID: doc.id,
    sourceBounds: rect,
    targetSize: size,
    colorSpace: "RGB",
    componentSize: 8,
    applyAlpha: false,
  });
  try {
    const src = await imageData.getData({ chunky: true });
    const { width, height, components } = imageData;
    const n = width * height;
    const rgb = new Uint8Array(n * 3);
    if (components === 3) {
      rgb.set(src.subarray(0, n * 3));
    } else {
      for (let i = 0; i < n; i++) {
        const a = src[i * 4 + 3] / 255;
        for (let c = 0; c < 3; c++) rgb[i * 3 + c] = Math.round(src[i * 4 + c] * a + 128 * (1 - a));
      }
    }
    return { pixels: rgb, width, height };
  } finally {
    imageData.dispose();
  }
}

/** Current selection as an 8-bit gray mask of `rect`, scaled to `size`. */
async function readSelectionMask(doc, rect, size) {
  const { imageData } = await imaging.getSelection({ documentID: doc.id, sourceBounds: rect, targetSize: size });
  try {
    const src = await imageData.getData({ chunky: true });
    return { pixels: new Uint8Array(src.subarray(0, imageData.width * imageData.height)), width: imageData.width, height: imageData.height };
  } finally {
    imageData.dispose();
  }
}

/**
 * Bring a PNG into `doc` as a new layer at rect.left/top, masked by the saved channel.
 */
async function placeResult(doc, pngBytes, rect, { layerName, channelName, featherPx, visible }) {
  const tmp = await storage.localFileSystem.getTemporaryFolder();
  const file = await tmp.createFile("legion_fill_" + Date.now() + ".png", { overwrite: true });
  await file.write(pngBytes.buffer.slice(pngBytes.byteOffset, pngBytes.byteOffset + pngBytes.byteLength), { format: storage.formats.binary });

  const srcDoc = await app.open(file);
  let layer;
  try {
    layer = await srcDoc.layers[0].duplicate(doc);
  } finally {
    await srcDoc.closeWithoutSaving();
    app.activeDocument = doc;
  }
  try { await file.delete(); } catch (e) {}

  layer.name = layerName;
  const b = layer.bounds;
  if (b.left !== rect.left || b.top !== rect.top) await layer.translate(rect.left - b.left, rect.top - b.top);

  await play([{ _obj: "select", _target: [{ _ref: "layer", _id: layer.id }], makeVisible: false }]);
  await loadChannelAsSelection(channelName);
  await softenSelection(featherPx);
  await play([{
    _obj: "make",
    new: { _class: "channel" },
    at: { _ref: "channel", _enum: "channel", _value: "mask" },
    using: { _enum: "userMaskEnabled", _value: "revealSelection" },
  }]);
  layer.visible = visible;
  return layer;
}

module.exports = {
  getSelectionBounds, selectRect, deselect, saveSelectionToChannel, loadChannelAsSelection,
  deleteChannel, prepareOutpaint, contextRegion, readComposite, readSelectionMask, placeResult,
};
