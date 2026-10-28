// ComfyUI API-format graph for FLUX.1 Fill [dev] inpaint / outpaint.

const MODELS = {
  unet: "flux1-fill-dev.safetensors",
  clip1: "clip_l.safetensors",
  clip2: "t5xxl_fp16.safetensors",
  vae: "ae.safetensors",
};

/** Snap to a multiple of 16 (FLUX latent patches), at least 256. */
function snap16(v) {
  return Math.max(256, Math.round(v / 16) * 16);
}

/**
 * Working resolution for a region: about `megapixels` MP, same aspect ratio.
 * Returns { width, height }.
 */
function workingSize(regionW, regionH, megapixels) {
  const s = Math.sqrt((megapixels * 1e6) / (regionW * regionH));
  return { width: snap16(regionW * s), height: snap16(regionH * s) };
}

/**
 * @param {object} o
 * @param {string} o.image      file name in ComfyUI input/
 * @param {string} o.mask       file name in ComfyUI input/ (white = repaint)
 * @param {string} o.prompt
 * @param {number} o.seed
 * @param {number} o.steps
 * @param {number} o.guidance   FluxGuidance, ~30 for Fill
 * @param {number} o.workW      sampling width  (multiple of 16)
 * @param {number} o.workH      sampling height (multiple of 16)
 * @param {number} o.outW       returned width  (region size in Photoshop)
 * @param {number} o.outH       returned height
 * @param {number} o.growMask   px at working resolution
 * @param {number} o.batch      variations
 * @param {string} o.weightDtype "default" | "fp8_e4m3fn" | ...
 * @param {string} o.prefix     SaveImage filename_prefix
 */
function buildFluxFill(o) {
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: MODELS.unet, weight_dtype: o.weightDtype || "default" } },
    "2": { class_type: "DualCLIPLoader", inputs: { clip_name1: MODELS.clip1, clip_name2: MODELS.clip2, type: "flux" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: MODELS.vae } },
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
      inputs: { positive: ["5", 0], negative: ["6", 0], vae: ["3", 0], pixels: ["8", 0], mask: ["12", 0], noise_mask: true },
    },
    "15": { class_type: "RepeatLatentBatch", inputs: { samples: ["14", 2], amount: Math.max(1, o.batch | 0) } },
    "16": {
      class_type: "KSampler",
      inputs: {
        model: ["13", 0], seed: o.seed, steps: o.steps, cfg: 1, sampler_name: "euler", scheduler: "normal",
        positive: ["14", 0], negative: ["14", 1], latent_image: ["15", 0], denoise: 1,
      },
    },
    "17": { class_type: "VAEDecode", inputs: { samples: ["16", 0], vae: ["3", 0] } },
    "18": { class_type: "ImageScale", inputs: { image: ["17", 0], upscale_method: "lanczos", width: o.outW, height: o.outH, crop: "disabled" } },
    "19": { class_type: "SaveImage", inputs: { images: ["18", 0], filename_prefix: o.prefix || "PS_fill" } },
  };
}

module.exports = { buildFluxFill, workingSize, MODELS };
