/** 后端 API 客户端 + WebSocket 订阅 */

const TOKEN_KEY = "avs_token";
export const getToken = () => localStorage.getItem(TOKEN_KEY) || "";
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t || "");

async function req(method, url, body, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload = body;
  if (body && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && typeof body === "object") {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok || (data && data.ok === false)) {
    const e = new Error(data?.error?.message || `HTTP ${res.status}`);
    e.code = data?.error?.code; e.status = res.status; e.detail = data?.error?.detail;
    throw e;
  }
  return data?.data;
}

/**
 * 拼查询串：undefined / null / 空串一律丢掉。
 * 不丢的话 URLSearchParams 会把它们拼成 "kind=undefined"、"project_id=null"，
 * 后端拿去当普通字符串做等值匹配，结果就是「库里明明有素材，列表却是空的」。
 */
function qs(q) {
  const clean = Object.fromEntries(
    Object.entries(q || {}).filter(([, v]) => v !== undefined && v !== null && v !== ""),
  );
  return Object.keys(clean).length ? `?${new URLSearchParams(clean)}` : "";
}

export const api = {
  get: (u) => req("GET", u),
  post: (u, b) => req("POST", u, b),
  patch: (u, b) => req("PATCH", u, b),
  del: (u) => req("DELETE", u),

  capabilities: () => api.get("/api/system/capabilities"),
  recheck: () => api.post("/api/system/capabilities/recheck"),
  instances: () => api.get("/api/system/instances"),
  pool: () => api.get("/api/system/pool"),
  llms: () => api.get("/api/system/llms"),
  llmProviders: () => api.get("/api/llm/providers"),
  createLlmProvider: (b) => api.post("/api/llm/providers", b),
  updateLlmProvider: (id, b) => api.patch(`/api/llm/providers/${id}`, b),
  deleteLlmProvider: (id) => api.del(`/api/llm/providers/${id}`),
  testLlmProvider: (b) => api.post("/api/llm/providers/test", b),
  freeMemory: () => api.post("/api/system/free"),
  // ------------------------------------------------------------ 语音合成（配音）
  ttsProviders: () => api.get("/api/tts/providers"),
  createTtsProvider: (b) => api.post("/api/tts/providers", b),
  updateTtsProvider: (id, b) => api.patch(`/api/tts/providers/${id}`, b),
  deleteTtsProvider: (id) => api.del(`/api/tts/providers/${id}`),
  testTtsProvider: (b) => api.post("/api/tts/providers/test", b),
  synthesizeTts: (b) => api.post("/api/tts/synthesize", b),
  /** 文字转语音，直接拿到可播放的 blob URL（试听用，不落素材） */
  async previewTts(b) {
    const headers = { "Content-Type": "application/json" };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch("/api/tts/preview", { method: "POST", headers, body: JSON.stringify(b || {}) });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const d = await res.json(); msg = d?.error?.message || msg; } catch { /* 非 JSON */ }
      throw new Error(msg);
    }
    return URL.createObjectURL(await res.blob());
  },
  dub: (b) => api.post("/api/dub", b),
  /** 视频 + 音频合成：音频由用户本地上传，不经过语音合成（后端本机 ffmpeg 完成） */
  mux: (b) => api.post("/api/mux", b),
  lyricsAlign: (b) => api.post("/api/lyrics/align", b),
  lyricsBurn: (b) => api.post("/api/lyrics/burn", b),
  lyricsAsrStatus: () => api.get("/api/lyrics/asr/status"),


  // ------------------------------------------------------------ AI 翻唱（本机 192.168.0.128）
  // 三条链路都在本机的 ComfyUI 上跑：RVC 换音色 / ACE-Step 1.5 重唱 / Demucs 人声分离。
  vocalStatus: () => api.get("/api/vocal/status"),
  vocalCover: (b) => api.post("/api/vocal/cover", b),
  /** 歌词 / 风格描述：走和创作台同一个大模型通道（本地模型或外部商业模型） */
  vocalPrompt: (b) => api.post("/api/vocal/prompt", b),

  // ------------------------------------------------------------ AI 创作音乐（本机 192.168.0.128）
  // 四条链路都在本机的 ComfyUI 上跑：MiniMax Music 3 / YuE2 / 锁旋律改编 / ACE-Step 1.5；
  // 音乐后期（拼接 / 裁剪 / 变速 / 接长 / 响度归一）走本机 ffmpeg，不占显卡。
  musicStatus: () => api.get("/api/music/status"),
  musicCreate: (b) => api.post("/api/music/create", b),
  /** 写词 / 写风格标签 / 写 MiniMax 三段式 caption：同一个大模型通道 */
  musicPrompt: (b) => api.post("/api/music/prompt", b),
  musicEdit: (b) => api.post("/api/music/edit", b),


  projects: () => api.get("/api/projects"),
  project: (id) => api.get(`/api/projects/${id}`),
  createProject: (b) => api.post("/api/projects", b),
  updateProject: (id, b) => api.patch(`/api/projects/${id}`, b),
  /** 项目重名实时校验：返回 { duplicate, project_duplicate, asset_duplicate, projects, assets } */
  checkProjectName: (title, excludeId) => api.get(`/api/projects/name-check${qs({ title, exclude_id: excludeId })}`),

  characters: (pid) => api.get(`/api/characters${pid ? `?project_id=${pid}` : ""}`),
  createCharacter: (b) => api.post("/api/characters", b),
  updateCharacter: (id, b) => api.patch(`/api/characters/${id}`, b),
  deleteCharacter: (id) => api.del(`/api/characters/${id}`),

  styles: () => api.get("/api/styles"),
  templates: (q) => api.get(`/api/templates${qs(q)}`),

  enhance: (b) => api.post("/api/prompt/enhance", b),
  genScript: (b) => api.post("/api/script/generate", b),
  scripts: (pid) => api.get(`/api/scripts?project_id=${pid}`),
  script: (id) => api.get(`/api/scripts/${id}`),
  updateShot: (id, b) => api.patch(`/api/shots/${id}`, b),
  runShot: (id, b) => api.post(`/api/shots/${id}/generate`, b || {}),
  runStoryboard: (pid, b) => api.post(`/api/projects/${pid}/storyboard/run-async`, b || {}),

  assets: (q) => api.get(`/api/assets${qs(q)}`),
  deleteAsset: (id) => api.del(`/api/assets/${id}`),
  /** 素材压缩（本机 ffmpeg 按目标大小压）：预设清单 / 执行 */
  compressPresets: () => api.get("/api/compress/presets"),
  compressAsset: (id, b) => api.post(`/api/assets/${id}/compress`, b || {}),
  /** 批量删除（素材库「删除选中 / 全选」用）：后端顺手把磁盘文件也清掉 */
  deleteAssets: (ids) => api.post("/api/assets/delete", { ids }),
  realignLyrics: (id, b) => api.post(`/api/assets/${id}/realign-lyrics`, b || {}),
  /** 歌词下载清单：所有带 .lrc / .srt / .ass 的素材（音乐页「④ 歌词下载清单」） */
  lyricsManifest: () => api.get("/api/lyrics/manifest"),
  /** 从歌词清单里删除选中条目（只删 .lrc / .srt / .ass；also_media 才连源素材一起删） */
  lyricsManifestDelete: (b) => api.post("/api/lyrics/manifest/delete", b || {}),
  /** 把歌词打包成 zip（传 asset_ids = 只打包这几首；不传 = 全打包） */
  lyricsPack: (keys) => api.post("/api/lyrics/manifest/pack", { keys: keys || [] }),


  jobs: (q) => api.get(`/api/jobs${qs(q)}`),
  job: (id) => api.get(`/api/jobs/${id}`),
  submitJob: (b) => api.post("/api/jobs", b),
  cancelJob: (id) => api.post(`/api/jobs/${id}/cancel`),

  exportFinal: (b) => api.post("/api/export/final", b),
  exportCapcut: (b) => api.post("/api/export/capcut", b),

  async upload(file, { projectId = "", onProgress } = {}) {
    const q = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/upload${q}`);
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
      const token = getToken();
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.upload.onprogress = (e) => onProgress && e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        try {
          const d = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300 && d.ok) resolve(d.data);
          else reject(new Error(d?.error?.message || `上传失败 ${xhr.status}`));
        } catch (e) { reject(e); }
      };
      xhr.onerror = () => reject(new Error("网络错误，上传失败"));
      xhr.send(file);
    });
  },
};

// ------------------------------------------------------------------ WebSocket
export function connectWs(jobId, onEvent) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/api/ws${jobId ? `?job_id=${encodeURIComponent(jobId)}` : ""}`;
  let ws = null, closed = false, retry = 0;
  const open = () => {
    ws = new WebSocket(url);
    ws.onopen = () => { retry = 0; };
    ws.onmessage = (e) => { try { onEvent(JSON.parse(e.data)); } catch { /* ignore */ } };
    ws.onclose = () => {
      if (closed) return;
      retry += 1;
      if (retry <= 8) setTimeout(open, Math.min(1000 * retry, 8000));
    };
    ws.onerror = () => { /* onclose 会处理重连 */ };
  };
  open();
  return { close() { closed = true; try { ws?.close(); } catch { /* ignore */ } } };
}
