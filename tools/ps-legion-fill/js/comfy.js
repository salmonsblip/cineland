// Thin ComfyUI HTTP/WebSocket client for UXP.

class ComfyClient {
  constructor(baseUrl) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.clientId = "ps-legion-" + Math.random().toString(36).slice(2, 10);
  }

  async _json(path, opts) {
    const r = await fetch(this.base + path, opts);
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(`ComfyUI ${path}: HTTP ${r.status} ${text.slice(0, 400)}`);
    }
    return r.json();
  }

  systemStats() {
    return this._json("/system_stats");
  }

  /** Upload PNG bytes to input/. Returns the stored name (with subfolder if any). */
  async uploadImage(bytes, filename) {
    const boundary = "----psLegion" + Date.now().toString(16);
    const enc = new TextEncoder();
    const head = enc.encode(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="image"; filename="${filename}"\r\n` +
      `Content-Type: image/png\r\n\r\n`
    );
    const tail = enc.encode(
      `\r\n--${boundary}\r\n` +
      `Content-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n` +
      `--${boundary}--\r\n`
    );
    const body = new Uint8Array(head.length + bytes.length + tail.length);
    body.set(head, 0);
    body.set(bytes, head.length);
    body.set(tail, head.length + bytes.length);

    const res = await this._json("/upload/image", {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: body.buffer,
    });
    return res.subfolder ? `${res.subfolder}/${res.name}` : res.name;
  }

  async queue(workflow) {
    const res = await this._json("/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: this.clientId }),
    });
    if (res.node_errors && Object.keys(res.node_errors).length) {
      throw new Error("Ошибки в графе: " + JSON.stringify(res.node_errors).slice(0, 400));
    }
    return res.prompt_id;
  }

  interrupt() {
    return fetch(this.base + "/interrupt", { method: "POST" }).catch(() => {});
  }

  /** Live sampler progress via WebSocket; returns a close() function. */
  watchProgress(promptId, onProgress) {
    let ws;
    try {
      ws = new WebSocket(this.base.replace(/^http/, "ws") + "/ws?clientId=" + this.clientId);
    } catch (e) {
      return () => {};
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return; // binary preview frames
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === "progress" && msg.data && msg.data.prompt_id === promptId) {
        onProgress(msg.data.value, msg.data.max);
      }
    };
    ws.onerror = () => {};
    return () => { try { ws.close(); } catch (e) {} };
  }

  /** Poll /history until the job is done. Returns the list of output images. */
  async waitForImages(promptId, { isCancelled, intervalMs = 1000 } = {}) {
    for (;;) {
      if (isCancelled && isCancelled()) throw new Error("Отменено");
      const hist = await this._json("/history/" + promptId);
      const job = hist[promptId];
      if (job) {
        const st = job.status || {};
        if (st.status_str === "error") {
          const err = (st.messages || []).find((m) => m[0] === "execution_error");
          throw new Error("ComfyUI: " + (err ? err[1].exception_message : "ошибка выполнения"));
        }
        if (st.completed || job.outputs) {
          const images = [];
          for (const out of Object.values(job.outputs || {})) {
            for (const img of out.images || []) if (img.type === "output") images.push(img);
          }
          if (images.length || st.completed) return images;
        }
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  async fetchImage(img) {
    const q = `filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || "")}&type=${img.type}`;
    const r = await fetch(this.base + "/view?" + q);
    if (!r.ok) throw new Error(`Не удалось скачать ${img.filename}: HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }
}

module.exports = { ComfyClient };
