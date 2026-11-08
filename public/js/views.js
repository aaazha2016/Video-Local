/** 各页面视图（8 个主页面，见需求报告 §9.1） */

import { api, connectWs, getToken } from "./api.js";
import { TRENDS, TREND_GROUPS, trendById, trendsOf } from "./trends.js";
import {
  h, toast, modal, clear, fmtSize, fmtDur, fmtTime, ago, statusPill,
  loadingNode, emptyNode, confirmDialog,
} from "./ui.js";

/** 取文件名：Windows 上是反斜杠、容器里是正斜杠，两种都要能切 */
const baseName = (p) => String(p || "").split(/[\\/]/).pop();

const ASPECT_LABEL = { "9:16": "9:16 竖版（抖音）", "1:1": "1:1 方形", "16:9": "16:9 横版", "4:3": "4:3", "3:4": "3:4" };

const MODES = [
  { id: "t2i", label: "文生图", icon: "🖼️", desc: "封面 / 场景 / 立绘 / 分镜素材", kinds: ["image"], test: (w) => w.supports.text2image || w.id.startsWith("WF-01") },
  { id: "i2i", label: "图生图", icon: "🎨", desc: "指令改图 / 多图参考 / 重绘 / 扩图 / 放大", kinds: ["image"], test: (w) => w.supports.image2image || w.supports.inpaint || w.supports.outpaint || w.supports.upscale },
  { id: "i2v", label: "图生视频", icon: "🎬", desc: "图片动起来 / 人物微动 / 口播动画", kinds: ["video"], test: (w) => w.supports.image2video || w.mode === "animate" || w.mode === "s2v" },
  { id: "t2v", label: "文生视频", icon: "✨", desc: "一句话生成动态画面", kinds: ["video"], test: (w) => w.supports.text2video },
  { id: "ref2v", label: "参考生视频", icon: "🧬", desc: "参考图/参考视频锁定角色与风格", kinds: ["video"], test: (w) => w.supports.reference || w.supports.video2video },
  { id: "audio", label: "音频 / 成片", icon: "🎵", desc: "BGM 混音 / 音轨合成 / 拼接合片", kinds: ["audio", "video"], test: (w) => ["WF-18", "WF-18M", "WF-25", "WF-26", "WF-16", "WF-16L", "WF-23", "WF-27"].includes(w.id) },
];

export const state = {
  capabilities: null,
  projects: [],
  projectId: null,
  styles: [],
  characters: [],
  mode: "t2i",
  engine: null,
  aspect: "9:16",
  duration: 5,
  refs: {},
  styleId: null,
  characterIds: [],
  prompt: "",
  negative: "",
  enhanceModes: {},    // 扩写方式：按创作台类型分别记住（文生图→画面词、图生图→改图词…）
  ws: null,
  currentJob: null,
  results: [],
  llms: null,          // 本地 LLM 清单（故事创作模型选择器）
  llmId: null,
  llmPreset: "balanced",
  llmThinking: false,
  pool: null,          // 多卡并行池状态
  // ---- 语音合成（配音页 / 故事创作带声音共用）
  tts: null,           // /api/tts/providers 的返回：音色清单 + 已配置服务
  dubVideo: null,      // 配音页选中的视频素材
  dubText: "",         // 配音文字（用户自己输入）
  dubResult: null,     // 上一次配音合成的成品（本机 ffmpeg 合成，通常几秒返回）
  ttsProvider: null,   // 选中的语音服务 id
  ttsVoice: null,      // 选中的音色
  ttsRate: 0,          // 语速（%，edge 通道支持）
  dubKeepOriginal: true,
  dubOriginalDb: -14,
  dubVoiceDb: 0,
  // ---- 视频 + 音频合成（配音页第二块：音频由用户本地上传）
  muxVideo: null,        // 选中的视频素材
  muxAudio: null,        // 上传（或从素材库挑）的音频素材
  muxAudioLib: null,     // 素材库里的音频清单（懒加载）
  muxKeepOriginal: false,// 是否保留视频原声（压低当背景）
  muxOriginalDb: -14,
  muxResult: null,       // 上一次合成结果
  // ---- 歌词 → 字幕（配音页第三块：歌词与音视频对齐，导出 .lrc / .srt / .ass）
  lrcMedia: null,        // 选中的音频或视频素材
  lrcMediaLib: null,     // 素材库里的音频 + 视频清单（懒加载）
  lrcText: "",           // 歌词原文（粘贴或上传 .txt / .lrc / .srt）
  lrcMode: "auto",       // auto | timed | speech | even
  lrcOffset: 0,          // 整体平移（毫秒，正数=字幕整体往后）
  lrcGap: 120,           // 每行末尾留白（毫秒）
  lrcResult: null,       // 对齐结果（三份字幕的下载地址 + 预览）
  lrcBurnResult: null,   // 烧录结果（带硬字幕的视频）
  // ---- 项目名称（创作台 / 故事创作共用；名字决定产物文件名，见 src/naming.js）
  projectNameDraft: null,    // 正在输入的项目名（null = 跟随当前项目的标题）
  projectNameDraftFor: null, // 这份草稿属于哪个项目，切项目要重置
  projectNameCheck: null,    // /api/projects/name-check 的结果
  projectNameForce: false,   // 重名时是否已确认「仍然使用这个名称」
  storyWithVoice: null, // 带声音：null = 自动（自带声音的引擎默认开，见 effectiveStoryVoice）
  storyBurnSubs: true,  // 分镜出片时把台词烧成硬字幕（本机 ffmpeg，不占显卡）
  storyVideoWf: null,   // 故事创作的视频引擎（默认 WF-15 MiniMax-H3，出的镜头自带声音）
  storyStyleId: null,   // 故事创作的风格模板（模板广场点「用于故事创作」写进来；存到 project.style_id）
  storyCharacterIds: [],// 故事创作锁定的角色卡（跨镜头保持人物长相；存到 project.meta.character_ids）
  storySyncedFor: null, // 上面两项是从哪个项目同步来的，避免反复覆盖用户手选
  charGenWf: null,      // 角色卡「AI 生成立绘」用的文生图引擎
  metaLoaded: false,
  // ---- AI 音乐（本机 192.168.0.128：MiniMax Music 3 / YuE2 / ACE-Step）
  musicStatus: null,      // /api/music/status：本机 ComfyUI 状态 + 四种玩法可用性 + 风格模仿预设
  musicLoading: false,
  musicMode: "mm3",       // mm3 文生歌曲 | yue 歌词成曲 | lock 锁旋律 | ace ACE-Step
  musicTopic: "",
  musicStyle: "",
  musicStylePreset: "",   // 风格模仿预设 id（清单来自 /api/music/status 的 styles）
  musicImitate: "",       // 自定义模仿对象：某位歌手 / 某个曲风
  musicLyrics: "",
  musicSeconds: null,     // null = 跟着当前引擎的默认时长走
  musicSteps: 0,
  musicSeed: -1,
  musicSong: null,        // 锁旋律用的参考音乐
  musicLlm: null,         // 写词用哪个大模型（和创作台各自独立）
  musicLlmPreset: null,
  musicJob: null,
  musicResult: [],
  // ---- 歌词下载清单（音乐页「④」：所有出歌 / 字幕产物一张表，可单条下载也可一键打包）
  lrcManifest: null,       // /api/lyrics/manifest 的返回
  lrcManifestSel: [],      // 清单里勾选待删除的行 key（asset:<id> / disk:<相对路径>）
  lrcManifestLoading: false,
  lrcManifestQuery: "",    // 清单里的搜索词
  lrcPack: null,           // 上一次打包结果（zip / csv 的下载地址）
  musicEditIds: [],
  musicEditResult: null,
  musicTrimStart: 0,
  musicTrimSeconds: 0,
  musicSpeed: 1,
  musicTarget: 0,
  musicFadeIn: 0,
  musicFadeOut: 0,
  musicNormalize: true,
  musicLoudness: "short_video",
  // ---- AI 翻唱（本机 192.168.0.128：RVC / ACE-Step / Demucs）
  vocalStatus: null,    // /api/vocal/status：本机 ComfyUI 在线状态 + 音色清单 + 三种玩法可用性
  vocalLoading: false,
  vocalMode: "rvc",     // rvc 换音色 | ace 整首重唱 | split 人声/伴奏分离
  vocalSong: null,      // 选中的歌曲素材（音频，或会被自动抽音轨的视频）
  vocalVoice: null,     // RVC 音色（形如 local:xxx.pth）
  vocalPitch: 0,
  vocalIndexRatio: 0.75,
  vocalConsonant: 0.25,
  vocalEnvelope: 0.25,
  vocalVocalDb: 0,
  vocalInstDb: 0,
  vocalLyrics: "",
  vocalTags: "",
  vocalBpm: 96,
  vocalSeconds: 180,
  vocalLang: "zh",
  vocalKey: "C major",
  vocalUseRef: true,    // ACE-Step 是否用原曲当参考音色
  vocalLlm: null,       // 写词用哪个大模型（和创作台 / 音乐页各自独立）
  vocalLlmPreset: null,
  vocalStylePreset: "", // 风格模仿预设 id（曲风 / 歌星唱腔 / 场景情绪）
  vocalImitate: "",     // 自定义模仿对象：某位歌手 / 某个曲风
  vocalJob: null,       // 当前翻唱任务
  vocalResult: [],      // 翻唱产物
  // ---- 训练新音色（录音 / 上传样本 → RVC 音色）
  vocalTrainFiles: null,      // 训练样本的素材 id 数组（录音和上传都往这里加）
  vocalTrainName: "",         // 音色名字（会变成模型文件名）
  vocalTrainRate: "",         // 采样率档位 32k / 40k / 48k
  vocalTrainEpochs: 50,       // 训练轮数
  vocalRecorder: null,        // 正在跑的 MediaRecorder（重绘页面也不丢）
};

// ============================================================ 工作台
function home(ctx) {
  const cap = state.capabilities;
  const box = h("div");
  const okCount = cap ? cap.workflows.filter((w) => w.available).length : 0;

  box.append(h("div", { class: "hero" },
    h("h1", null, "本地 AI 短视频创作台"),
    h("p", null, "全部生成在本机 ComfyUI 上完成：文生图 / 图生图 / 图生视频 / 原生 20 秒音画同步 / 多镜头故事模式。导出 1080P 无水印，可直接导入剪映。"),
    h("div", { class: "row wrap", style: { marginTop: "12px", gap: "8px" } },
      h("span", { class: `pill ${cap?.online ? "ok" : "err"}` }, cap?.online ? "ComfyUI 在线" : "ComfyUI 离线"),
      h("span", { class: "pill acc" }, `可用能力 ${okCount}/${cap?.workflows?.length || 0}`),
      h("span", { class: "pill" }, `节点 ${cap?.objectInfoNodes || 0}`),
      h("span", { class: "pill" }, `官方模板 ${cap?.templates?.total || 0}`),
      h("span", { class: "pill" }, `风格模板 ${state.styles.length}`)),
    h("div", { class: "quick" }, MODES.filter((m) => ["t2i", "i2i", "i2v", "ref2v"].includes(m.id)).map((m) =>
      h("button", { onClick: () => ctx.go(`/create?mode=${m.id}`) },
        h("span", { class: "q-ico" }, m.icon), h("b", null, m.label), h("span", null, m.desc))))));

  const unavailable = (cap?.workflows || []).filter((w) => !w.available);
  if (unavailable.length) {
    box.append(h("div", { class: "card", style: { marginBottom: "16px" } },
      h("h3", null, `⚠️ ${unavailable.length} 项能力因缺权重/模型暂不可用（已自动置灰）`),
      h("div", { class: "tiny muted" }, unavailable.map((w) => `${w.id} ${w.label}：${w.reasons[0]}`).join("　|　"))));
  }

  const projCard = h("div", { class: "card" },
    h("div", { class: "row", style: { justifyContent: "space-between" } },
      h("h3", null, "我的项目"),
      h("button", { class: "sm primary", onClick: () => newProject(ctx) }, "+ 新建项目")));
  if (!state.projects.length) projCard.append(emptyNode("还没有项目，点击右上角新建一个吧"));
  else {
    projCard.append(h("table", null,
      h("thead", null, h("tr", null, ...["项目", "比例", "更新时间", "操作"].map((t) => h("th", null, t)))),
      h("tbody", null, ...state.projects.slice(0, 12).map((p) => h("tr", null,
        h("td", null, h("b", null, p.title)),
        h("td", null, p.aspect),
        h("td", { class: "muted" }, ago(p.updated_at)),
        h("td", null, h("button", { class: "sm", onClick: () => ctx.go(`/create?project=${p.id}`) }, "进入创作")))))));
  }
  box.append(projCard);

  box.append(h("div", { class: "card", style: { marginTop: "16px" } },
    h("div", { class: "row", style: { justifyContent: "space-between" } },
      h("h3", null, "快捷入口"),
      h("div", { class: "row", style: { gap: "6px" } },
        h("button", { class: "sm", onClick: () => ctx.go("/trending") }, "🔥 爆款复刻"),
        h("button", { class: "sm", onClick: () => ctx.go("/templates") }, "模板广场"))),
    h("div", { class: "quick" }, MODES.map((m) => h("button", { onClick: () => ctx.go(`/create?mode=${m.id}`) },
      h("span", { class: "q-ico" }, m.icon), h("b", null, m.label), h("span", null, m.desc))))));
  return box;
}

function newProject(ctx) {
  const name = h("input", { placeholder: "项目名称，例如：赛博街头短剧" });
  const aspect = h("select", null, ...Object.keys(ASPECT_LABEL).map((a) => h("option", { value: a }, ASPECT_LABEL[a])));
  modal("新建项目", h("div", null,
    h("div", { class: "field" }, h("label", null, "项目名称"), name),
    h("div", { class: "field" }, h("label", null, "默认画幅比例"), aspect)),
  [{ label: "取消", onClick: (c) => c() }, {
    label: "创建", primary: true, onClick: async (c) => {
      try {
        const p = await api.createProject({ title: name.value || "未命名项目", aspect: aspect.value });
        state.projects = await api.projects();
        state.projectId = p.id;
        toast("项目已创建", "ok"); c(); ctx.reload();
      } catch (e) { toast(e.message, "err"); }
    },
  }]);
}

/**
 * 「项目 + 项目名称」一体控件（创作台 / 故事创作共用）。
 *
 * 为什么名字要单独做一栏：产物文件名就是「项目名称_图片|音频|视频_流水号」（见 src/naming.js），
 * 项目名不只是个标签 —— 它决定素材库里能不能一眼认出这是哪个项目的东西。所以三件事要同时成立：
 *   ① 能选已有项目；
 *   ② 能直接改名字（改完**之后的**新产物就用新名字，老文件不动）；
 *   ③ 还没选项目时，输入名字就能建一个新项目，不用跳回创作台。
 * 名字重了必须当场看出来：同名项目产出的文件在素材库里长得一模一样，事后没法分辨。
 * 校验走 /api/projects/name-check，边打字边查；建 / 改的时候后端还会再兜一道底。
 */
function projectNameRow(ctx) {
  const cur = state.projects.find((p) => (p.value ?? p.id) === state.projectId) || null;
  // 切项目时把上一份草稿丢掉，否则会把 A 项目的名字带到 B 项目上
  if (state.projectNameDraftFor !== state.projectId) {
    state.projectNameDraftFor = state.projectId;
    state.projectNameDraft = null;
    state.projectNameCheck = null;
    state.projectNameForce = false;
  }
  const savedTitle = cur ? String(cur.title || "") : "";

  const sel = h("select", { style: { minWidth: "220px" } },
    h("option", { value: "" }, "（不归属项目）"),
    ...state.projects.map((p) => h("option", { value: p.id, selected: p.id === state.projectId }, p.title)));

  const input = h("input", {
    placeholder: "项目名称，例如：赛博街头短剧",
    value: state.projectNameDraft ?? savedTitle,
    style: { minWidth: "240px" },
  });
  const hint = h("span", { class: "tiny muted" }, "");
  const saveBtn = h("button", { class: "sm" });
  const forceChk = h("input", { type: "checkbox", checked: !!state.projectNameForce });
  const forceLabel = h("label", { class: "tiny", style: { display: "inline-flex", gap: "4px", alignItems: "center", cursor: "pointer" } },
    forceChk, "仍然使用这个名称");

  /** 按当前输入 + 已拿到的校验结果重画提示条（只改这三个节点，不重绘整页，免得输入框失焦） */
  const paint = () => {
    const draft = input.value.trim();
    forceChk.checked = !!state.projectNameForce;
    saveBtn.textContent = cur ? "保存名称" : "创建项目";
    const changed = draft !== savedTitle;
    saveBtn.style.display = (draft && (changed || !cur)) ? "" : "none";

    const r = state.projectNameCheck;
    const fresh = r && r.title === draft;
    let dup = false;
    if (draft && fresh && r.duplicate) {
      dup = true;
      const why = [
        r.project_duplicate ? "已经有同名项目" : "",
        r.asset_duplicate ? `素材库里已经有 ${r.assets.length} 个以它开头的文件` : "",
      ].filter(Boolean).join("，");
      hint.className = state.projectNameForce ? "tiny muted" : "pill warn";
      hint.textContent = `　⚠️ ${why}${state.projectNameForce ? "（已确认继续）" : "，换一个更稳妥"}`;
    } else if (draft && fresh) {
      hint.className = "tiny muted";
      hint.textContent = `　✓ 这个名字没人用过，产物会命名成「${r.safe_name}_图片_0001」这样`;
    } else if (draft && !changed) {
      hint.className = "tiny muted";
      hint.textContent = `　产物会命名成「${draft}_图片_0001」这样`;
    } else {
      hint.className = "tiny muted";
      hint.textContent = "";
    }
    saveBtn.disabled = dup && !state.projectNameForce;
    forceLabel.style.display = dup ? "" : "none";
  };

  const check = debounce(async () => {
    const title = input.value.trim();
    if (!title) { state.projectNameCheck = null; paint(); return; }
    try {
      const r = await api.checkProjectName(title, state.projectId || "");
      if (input.value.trim() !== title) return;   // 用户又改了，这份结果已经过期
      state.projectNameCheck = r;
    } catch { state.projectNameCheck = null; }
    paint();
  }, 380);

  input.oninput = () => {
    state.projectNameDraft = input.value;
    state.projectNameForce = false;
    state.projectNameCheck = null;
    hint.className = "tiny muted"; hint.textContent = "　校验中…";
    saveBtn.style.display = "none";
    forceLabel.style.display = "none";
    check();
  };
  forceChk.onchange = () => { state.projectNameForce = forceChk.checked; paint(); };

  sel.onchange = () => {
    state.projectId = sel.value || null;
    // 换项目等于换一套分镜，清掉故事创作那边的缓存（在创作台设置也无害）
    state.scriptsLoadedFor = null; state.script = null; state.shots = [];
    ctx.reload();
  };

  saveBtn.onclick = async () => {
    const title = input.value.trim();
    if (!title) return toast("请先写一个项目名称", "warn");
    saveBtn.disabled = true; saveBtn.textContent = "保存中…";
    try {
      if (cur) {
        const p = await api.updateProject(cur.id, { title, force: state.projectNameForce });
        state.projects = state.projects.map((x) => (x.id === p.id ? { ...x, ...p } : x));
        toast(`项目名已改为「${p.title}」，之后的新产物就用这个名字`, "ok", 6000);
      } else {
        const p = await api.createProject({ title, aspect: state.aspect, force: state.projectNameForce });
        state.projects = await api.projects();
        state.projectId = p.id;
        toast(`项目「${p.title}」已创建，产物会以它开头命名`, "ok", 6000);
      }
      state.projectNameDraft = null; state.projectNameCheck = null; state.projectNameForce = false;
      state.projectNameDraftFor = null;
      ctx.reload();
    } catch (e) {
      // 后端兜底也会拦重名：把它的结论画到提示条上，别让用户只看到一句 toast
      if (e.detail && e.detail.duplicate) state.projectNameCheck = e.detail;
      toast(e.message, "err", 12000);
      saveBtn.disabled = false; paint();
    }
  };

  paint();
  return h("div", null,
    h("div", { class: "row wrap", style: { gap: "10px", alignItems: "center" } }, sel, input),
    h("div", { class: "row wrap", style: { gap: "10px", alignItems: "center", marginTop: "6px" } }, forceLabel, saveBtn, hint));
}

// ============================================================ 创作台
function create(ctx) {
  const box = h("div");

  const tabs = h("div", { class: "tabs" }, MODES.map((m) =>
    h("button", { class: m.id === state.mode ? "on" : "", onClick: () => { state.mode = m.id; state.engine = null; ctx.reload(); } }, `${m.icon} ${m.label}`)));

  const left = h("div", { class: "card" },
    h("div", { class: "field" }, h("label", null, "项目",
      h("span", { class: "tiny muted" }, "　选已有项目，或直接输入名字新建；产物文件名以项目名开头")), projectNameRow(ctx)),
    h("div", { class: "field" }, h("label", null, "生成能力（引擎）"), engineList(ctx)),
    h("div", { class: "field" }, h("label", null, "画幅比例"), aspectRow(ctx)),
    h("div", { class: "field" }, h("label", null, "时长"), durationSlider(ctx)),
    h("div", { class: "field" }, h("label", null, "风格模板"), stylePicker(ctx)),
    h("div", { class: "field" }, h("label", null, "角色锁定（可多选）"), characterPicker(ctx)),
    h("div", { class: "field" }, h("label", null, "参考素材（≤20，拖入或点击上传）"), refSlots(ctx)),
    h("div", { class: "field" }, h("label", null, "提示词"), promptBox(ctx)),
    h("div", { class: "row", style: { gap: "8px" } },
      h("button", { class: "primary", style: { flex: "1" }, onClick: () => submit(ctx) }, "开始生成"),
      h("button", { onClick: () => openEnhance(ctx, { auto: true }) }, "智能扩写")));

  const stage = h("div", { class: "stage", id: "stage" }, h("div", { class: "ph" }, "生成结果会显示在这里（支持实时预览帧）"));
  const stageWrap = h("div", null, stage, h("div", { class: "progress" }, h("i", { id: "stage-bar" })));

  const right = h("div", { class: "card" },
    h("div", { class: "row", style: { justifyContent: "space-between" } },
      h("h3", null, "本次产出"),
      h("button", { class: "sm ghost", onClick: () => ctx.go("/assets") }, "素材库")),
    h("div", { id: "result-list", class: "asset-grid" },
      state.results.length ? state.results.map(resultCard) : h("div", { class: "tiny muted" }, "暂无产出")),
    h("div", { class: "hr" }),
    h("div", { class: "tiny muted" }, "生成完成后可直接下载 1080P 无水印 MP4、加入素材库、导出剪映草稿。"));

  box.append(tabs, h("div", { class: "studio" }, left, stageWrap, right));
  return box;
}

function engineList(ctx) {
  const cap = state.capabilities;
  if (!cap) return loadingNode();
  const mode = MODES.find((m) => m.id === state.mode);
  const list = cap.workflows.filter((w) => mode.kinds.includes(w.kind) && mode.test(w));
  if (!list.length) return h("div", { class: "tiny muted" }, "该模式下当前没有可用引擎");
  if (!state.engine || !list.some((w) => w.id === state.engine)) state.engine = (list.find((w) => w.available) || list[0]).id;
  return h("div", null, list.map((w) => h("div", {
    class: `engine-opt ${w.available ? "" : "na"} ${state.engine === w.id ? "on" : ""}`,
    onClick: () => { if (!w.available) return toast(w.reasons[0] || "该能力暂不可用", "warn"); state.engine = w.id; ctx.reload(); },
  },
  h("div", { class: "row", style: { justifyContent: "space-between" } },
    h("b", null, w.label),
    h("span", { class: `pill ${w.available ? "ok" : "err"}` }, w.available ? "可用" : "不可用")),
  h("div", { class: "tiny muted" }, `${w.id} · ${w.engine} · 显存≈${Math.round((w.vramNeedMB || 0) / 1024)}GB${w.fps ? ` · ${w.fps}fps` : ""}${w.maxDurationS ? ` · 最长 ${w.maxDurationS}s` : ""}`),
  w.available ? null : h("div", { class: "why" }, w.reasons[0]))));
}

function aspectRow(ctx) {
  const aspects = Object.keys(state.capabilities?.aspects || { "9:16": 1, "1:1": 1, "16:9": 1 });
  return h("div", { class: "aspect-row" }, aspects.map((a) =>
    h("button", { class: state.aspect === a ? "on" : "", onClick: () => { state.aspect = a; ctx.reload(); } }, ASPECT_LABEL[a] || a)));
}

function currentWorkflow() {
  const cap = state.capabilities;
  if (!cap) return null;
  return cap.workflows.find((w) => w.id === state.engine) || null;
}

function frameCount(wf, d) {
  if (wf.id === "WF-15" || wf.id === "WF-15R") { const x = Math.max(5, Math.round(d * 24)); return x + ((5 - (x % 17)) % 17); }
  const fps = wf.fps || 16;
  return Math.round(d * fps) + 1;
}

function durationSlider(ctx) {
  const wf = currentWorkflow();
  const max = Math.min(20, wf?.maxDurationS || 20);
  const val = h("span", { class: "val" }, `${state.duration} 秒`);
  const info = h("div", { class: "tiny muted", style: { marginTop: "4px" } });
  const paint = () => {
    val.textContent = `${state.duration} 秒`;
    info.textContent = wf ? `对齐后帧数 ${frameCount(wf, state.duration)}${wf.fps ? ` · ${wf.fps}fps` : ""}${state.duration > 6 && wf.supports.contextWindow ? " · 超过 6 秒将自动启用上下文窗口续写" : ""}` : "";
  };
  const input = h("input", { type: "range", min: 2, max, step: 1, value: state.duration,
    oninput: (e) => { state.duration = Number(e.target.value); paint(); } });
  paint();
  return h("div", null,
    h("div", { class: "slider" }, input, val),
    h("div", { class: "ticks" }, h("span", null, "2s"), h("span", null, `${Math.round(max / 2)}s`), h("span", null, `${max}s`)),
    info);
}

function stylePicker(ctx) {
  const cur = state.styles.find((s) => s.id === state.styleId);
  return h("div", { class: "row" },
    h("div", { class: "pill acc", style: { flex: "1", padding: "8px 10px" } }, cur ? `${cur.category} · ${cur.name}` : "未选择（点击右侧按钮）"),
    h("button", { class: "sm", onClick: () => styleModal(ctx) }, "选择"),
    cur ? h("button", { class: "sm ghost", onClick: () => { state.styleId = null; ctx.reload(); } }, "清除") : null);
}

function styleModal(ctx) {
  const grid = h("div", { class: "style-grid" }, state.styles.map((s) => h("div", {
    class: `style-card ${state.styleId === s.id ? "on" : ""}`,
    onClick: () => { state.styleId = s.id; close(); ctx.reload(); },
  }, h("b", null, s.name), h("p", null, s.prompt_prefix || s.negative || s.category), h("span", { class: "pill" }, s.category))));
  const close = modal("风格模板（含抖音热门风格）", grid);
}

/**
 * 角色锁定选择器。默认写 state.characterIds（创作台）；故事创作传 "storyCharacterIds"。
 * 有形象图的角色在名字前带小缩略图，一眼认得出是谁。
 */
function characterPicker(ctx, key = "characterIds") {
  if (!state.characters.length) {
    return h("div", { class: "row" },
      h("span", { class: "tiny muted", style: { flex: "1" } }, "暂无角色卡（角色卡可保证跨镜头人物长相一致）"),
      h("button", { class: "sm", onClick: () => ctx.go("/characters") }, "去创建"));
  }
  if (!Array.isArray(state[key])) state[key] = [];
  const ids = state[key];
  // 角色卡里的参考图可能已经被从素材库删掉了（用户清过素材库 / 换过形象图），
  // 后端会用 refs_missing / refs_live 告诉我们「失效几张、还剩几张能用」。
  // 还剩 0 张能用的角色，等于只能靠文字提示词锁人 —— 勾它之前就得说清楚，别等出图才发现不像。
  const blind = state.characters.filter((c) => ids.includes(c.id) && characterRefsBlind(c)).map((c) => c.name);
  return h("div", null,
    h("div", { class: "chips" }, state.characters.map((c) => {
      const on = ids.includes(c.id);
      const cover = characterCover(c);
      const stale = characterRefsStale(c);
      return h("span", {
        class: `chip ${on ? "on" : ""}`, title: c.prompt_lock || c.name,
        style: { display: "inline-flex", gap: "6px", alignItems: "center" },
        onClick: () => {
          state[key] = on ? ids.filter((x) => x !== c.id) : [...ids, c.id];
          if (key === "storyCharacterIds") { state.storySyncedFor = state.projectId; persistStorySelection(); }
          ctx.reload();
        },
      }, cover
        ? h("img", { src: cover, style: { width: "18px", height: "18px", borderRadius: "50%", objectFit: "cover" } })
        : "🎭", c.name,
        stale ? h("span", { title: `${c.refs_missing} 张参考图已不在素材库里，出图可能只能靠文字锁人物` }, "⚠️") : null,
        h("span", {
          class: "chip-edit", title: "编辑角色卡 / 管理参考图池（看大图、换封面、删图、排序）",
          onClick: (e) => { e.stopPropagation(); e.preventDefault(); editCharacter(ctx, c); },
        }, "✎"));
    })),
    blind.length
      ? h("div", { class: "pill warn", style: { display: "block", marginTop: "6px" } },
        `⚠️ 角色「${blind.join("、")}」的参考图已不在素材库里，本次只能靠文字描述锁定人物长相。`
        + "要恢复「看图锁人」，到「角色卡」点一下「🎨 生成立绘」重新生成一张即可。")
      : null,
    h("div", { class: "tiny muted", style: { marginTop: "6px" } },
      ids.length
        ? `已锁定 ${ids.length} 个角色：生成时会把这些角色的形象图当参考图带上，保证人物长相一致。`
        : "不锁角色时人物长相每镜都可能变；做连载 / 口播号建议先在「角色卡」建好角色。"));
}

/** 角色卡的参考图有几张已经失效（原素材被删）；后端没标记就当作没失效，避免误报 */
function characterRefsStale(c) { return Number(c.refs_missing) > 0; }
/** 一张能用的参考图都不剩 —— 这时锁角色只剩文字描述，出图要提前提醒 */
function characterRefsBlind(c) { return characterRefsStale(c) && Number(c.refs_live) === 0; }

const SLOT_KEYS = {
  start_image: "首帧图", end_image: "尾帧图", mask: "遮罩（白=重绘区）",
  character: "角色参考图（可多张）", reference_image: "参考图", ref_images: "参考图组（可多张）",
  control_video: "驱动/源视频", pose_video: "动作视频", source_video: "源视频", videos: "待拼接视频（可多段）",
  audio: "配音/音频", speech: "口播配音", bgm: "BGM 音频",
};
/** 这些槽位可以放多个素材（用于多参考图锁角色、多段视频拼接） */
const MULTI_SLOTS = new Set(["character", "ref_images", "videos", "audios"]);

/** 把 state.refs 摊平成 {key, item} 列表，便于统一渲染与删除 */
function flattenRefs() {
  const out = [];
  for (const [key, v] of Object.entries(state.refs)) {
    for (const item of (Array.isArray(v) ? v : [v])) if (item) out.push({ key, item });
  }
  return out;
}

function removeRef(key, item) {
  const cur = state.refs[key];
  if (Array.isArray(cur)) {
    const next = cur.filter((x) => x !== item);
    if (next.length) state.refs[key] = next; else delete state.refs[key];
  } else delete state.refs[key];
}

function refSlots(ctx) {
  const wf = currentWorkflow();
  const slots = flattenRefs();
  const grid = h("div", { class: "slots" });
  slots.forEach(({ key, item: a }, i) => {
    grid.append(h("div", { class: "slot", title: key },
      h("span", { class: "idx" }, i + 1),
      h("button", { class: "del", onClick: () => { removeRef(key, a); ctx.reload(); } }, "×"),
      a.kind === "image" ? h("img", { src: a.url, alt: key })
        : h("div", { class: "tiny", style: { padding: "6px", textAlign: "center" } }, `${a.kind === "video" ? "🎬" : "🎵"} ${key}`)));
  });
  grid.append(h("div", { class: "slot", onClick: () => pickRef(ctx) }, h("span", { class: "plus" }, "+")));
  return h("div", null, grid,
    h("div", { class: "tiny muted", style: { marginTop: "6px" } },
      `已选 ${slots.length}/20　·　槽位会按引擎自动分配；` +
      (wf?.supports?.maxRefs ? `MiniMax-H3 单轮上限：${wf.supports.maxRefs.images} 图 + ${wf.supports.maxRefs.videos} 视频 + ${wf.supports.maxRefs.audios} 音频，超出请多轮融合。` : "")));
}

async function pickRef(ctx) {
  const sel = h("select", null, ...Object.entries(SLOT_KEYS).map(([k, v]) => h("option", { value: k }, `${v}（${k}）`)));
  const file = h("input", { type: "file", accept: "image/*,video/*,audio/*", multiple: true });
  const existing = h("select", null, h("option", { value: "" }, "或从素材库选择…"));
  api.assets({ limit: 100 }).then((list) => {
    for (const a of list) existing.append(h("option", { value: a.id }, `[${a.kind}] ${baseName(a.path)} · ${ago(a.created_at)}`));
  }).catch(() => {});
  const multiHint = h("div", { class: "tiny muted" });
  const paintHint = () => {
    const multi = MULTI_SLOTS.has(sel.value);
    file.multiple = multi;
    multiHint.textContent = multi ? "该槽位支持多选（按住 Ctrl / Shift 选多个）" : "该槽位只接受 1 个素材";
  };
  sel.onchange = paintHint;
  paintHint();
  modal("添加参考素材",
    h("div", null,
      h("div", { class: "field" }, h("label", null, "槽位"), sel),
      h("div", { class: "field" }, h("label", null, "上传新文件"), file, multiHint),
      h("div", { class: "field" }, h("label", null, "或复用已有素材"), existing)),
    [{ label: "取消", onClick: (c) => c() }, {
      label: "添加", primary: true, onClick: async (c) => {
        try {
          const multi = MULTI_SLOTS.has(sel.value);
          const addOne = (asset) => {
            if (multi) state.refs[sel.value] = [...(state.refs[sel.value] || []), asset];
            else state.refs[sel.value] = asset;
          };
          if (file.files?.length) {
            const limit = 20 - flattenRefs().length;
            for (const f of [...file.files].slice(0, multi ? Math.max(1, limit) : 1)) {
              addOne(await api.upload(f, { projectId: state.projectId || "" }));
            }
          } else if (existing.value) {
            const list = await api.assets({ limit: 200 });
            const found = list.find((x) => x.id === existing.value);
            if (found) addOne(found);
          } else return toast("请选择文件或素材", "warn");
          toast("已添加参考素材", "ok"); c(); ctx.reload();
        } catch (e) { toast(e.message, "err"); }
      },
    }]);
}

function promptBox() {
  const ta = h("textarea", { rows: 5, placeholder: "描述你想要的画面/动作，例如：夜晚霓虹街头，女孩回眸微笑，镜头缓慢推近" });
  ta.value = state.prompt || "";
  ta.oninput = () => { state.prompt = ta.value; };
  const neg = h("input", { placeholder: "负向提示词（可留空，默认已内置通用负向）" });
  neg.value = state.negative || "";
  neg.oninput = () => { state.negative = neg.value; };
  return h("div", null, ta, h("div", { style: { marginTop: "8px" } }, neg));
}

/**
 * 把「提示词扩写」的结果拼成能直接喂给拆分镜的脚本文字（爆款复刻用）。
 * 三种模式的返回结构不一样：分镜 = logline + shots[]，文案 = script，图像提示词 = prompt_zh。
 */
function enhanceToScript(result, raw) {
  if (result && Array.isArray(result.shots) && result.shots.length) {
    const head = String(result.logline || "").trim();
    const lines = result.shots.map((s) => {
      const p = String(s.prompt || s.description || "").trim();
      const d = String(s.dialogue || "").trim();
      return `${s.idx ?? ""}. ${p}${d ? `（台词：${d}）` : ""}`.trim();
    });
    return [head, ...lines].filter(Boolean).join("\n");
  }
  const text = String(result?.script || result?.prompt_zh || result?.logline || "").trim();
  if (text) return text;
  // 本地小模型偶尔会把 JSON 写崩（键名带空格 / 被 max_length 截断），extractJson 就解析不出来。
  // 这种情况别把半截 JSON 塞进梗概（人看不懂、拆分镜也读不了），改成从原文里把能用的字段抠出来。
  const src = String(raw || "");
  const field = (key) => [...src.matchAll(new RegExp(`"\\s*${key}\\s*"\\s*:\\s*"([^"]*)"`, "g"))]
    .map((m) => String(m[1] || "").trim()).filter(Boolean);
  const logline = field("logline")[0] || "";
  const lines = field("prompt").map((p, i) => `${i + 1}. ${p}`);
  if (lines.length) return [logline, ...lines].filter(Boolean).join("\n");
  if (logline) return logline;
  // 连字段都抠不出来：返回空串，让调用方提示「看原文 / 换个模型」，绝不覆盖用户原来写好的梗概
  return src.trim().startsWith("{") ? "" : src.trim();
}

/**
 * 扩写方式：和创作台当前选的类型一一对应（见 MODES），另外保留两个通用项。
 * 用户手动改过的会按类型分别记住，切回这个类型还是上次那种方式。
 */
const ENHANCE_MODES = [
  { v: "image_prompt", t: "文生图 · 画面提示词扩写", for: ["t2i"] },
  { v: "image_edit", t: "图生图 · 改图 / 重绘 / 扩图 / 高清放大", for: ["i2i"] },
  { v: "video_i2v", t: "图生视频 · 让这张图动起来", for: ["i2v"] },
  { v: "video_t2v", t: "文生视频 · 一句话出动态画面", for: ["t2v"] },
  { v: "video_ref", t: "参考生视频 · 多图锁角色 / 锁风格", for: ["ref2v"] },
  { v: "audio_final", t: "音频 / 成片 · 配音文案 / BGM / 字幕 / 拼接", for: ["audio"] },
  { v: "viral_copy", t: "抖音爆款文案（标题 / 钩子 / 话题 / 口播稿）", for: [] },
  { v: "storyboard", t: "剧本分镜拆解（故事创作 / 爆款复刻）", for: [] },
];
const enhanceModeLabel = (v) => ENHANCE_MODES.find((m) => m.v === v)?.t || v;

/** 创作台当前类型默认用哪种扩写方式（上次手选过的优先） */
function enhanceModeForState() {
  const saved = (state.enhanceModes || {})[state.mode];
  if (saved && ENHANCE_MODES.some((m) => m.v === saved)) return saved;
  return ENHANCE_MODES.find((m) => m.for.includes(state.mode))?.v || "image_prompt";
}

/**
 * 把扩写结果按「扩写方式」回填到创作台。
 * 各方式的返回结构不一样（画面词 / 改图指令 / 运镜 / 配音文案），这里统一翻译成「回填了什么」。
 */
function applyEnhanceResult(modeId, result) {
  const r = result || {};
  const done = [];
  const text = String(r.prompt_zh || r.prompt_en || "").trim();
  const fillPrompt = () => {
    if (!text) return false;
    state.prompt = text;
    const neg = String(r.negative || "").trim();
    if (neg) state.negative = neg;
    done.push("提示词");
    return true;
  };
  if (modeId === "image_prompt" || modeId === "image_edit") {
    if (!fillPrompt()) return toast("没拿到能用的提示词，可以看下面的原文自己挑一句", "warn", 7000);
    if (modeId === "image_edit") {
      if (r.edit_strength) done.push(`改图幅度建议 ${r.edit_strength}`);
      if (Array.isArray(r.keep) && r.keep.length) done.push(`要保留的 ${r.keep.length} 项特征`);
    } else if (Array.isArray(r.style_tags) && r.style_tags.length) {
      done.push(`风格词 ${r.style_tags.length} 个`);
    }
  } else if (modeId === "video_i2v" || modeId === "video_t2v" || modeId === "video_ref") {
    if (!fillPrompt()) return toast("没拿到能用的提示词，可以看下面的原文自己挑一句", "warn", 7000);
    if (r.motion) done.push(`动态：${String(r.motion).slice(0, 24)}`);
    const hit = CAMERA_OPTIONS.find((c) => c.v === String(r.camera_move || "").trim());
    if (hit) done.push(`运镜「${hit.t}」`);
    const dur = Number(r.duration_s);
    if (Number.isFinite(dur) && dur > 0) {
      state.duration = Math.max(1, Math.min(20, Math.round(dur)));
      done.push(`时长 ${state.duration} 秒`);
    }
    if (Array.isArray(r.shots) && r.shots.length) done.push(`分好 ${r.shots.length} 段`);
    if (r.audio_hint) done.push("音效 / 配乐提示");
  } else if (modeId === "audio_final") {
    const lines = (Array.isArray(r.voiceover) ? r.voiceover : []).map((x) => String(x?.text || "").trim()).filter(Boolean);
    if (!lines.length) return toast("没拿到配音文案，可以看下面的原文自己整理", "warn", 7000);
    state.dubText = lines.map((s, i) => `${i + 1}. ${s}`).join("\n");
    done.push(`配音文案 ${lines.length} 句（已填到「视频配音」页）`);
    if (r.mix) done.push(`混音建议 ${r.mix}`);
    if (Array.isArray(r.sfx) && r.sfx.length) done.push(`环境音 ${r.sfx.length} 处`);
    if (Array.isArray(r.subtitles) && r.subtitles.length) done.push(`字幕 ${r.subtitles.length} 条`);
  }
  if (!done.length) return toast("已生成，内容在下面的原文里", "ok", 6000);
  toast(`已回填：${done.join("、")}`, "ok", 9000);
}

/**
 * 提示词 / 文案 / 剧本扩写弹窗（创作台与「爆款复刻」共用）。
 *
 * opts.initial  预填文本（默认用创作台当前的提示词）
 * opts.auto     跟着创作台当前选的类型自动匹配扩写方式（创作台用）
 * opts.mode     固定预选模式（故事创作 / 爆款复刻用 storyboard）
 * opts.title    弹窗标题
 * opts.onApply(result, raw)  拿到结果后的回填逻辑；传了就不再默认回填到创作台提示词
 */
function openEnhance(ctx, opts = {}) {
  if (!state.llms) loadLlms().then(() => ctx?.reload?.()).catch(() => {});
  const ta = h("textarea", { rows: 8, placeholder: "写下你的想法或故事梗概…" });
  ta.value = opts.initial != null ? String(opts.initial) : (state.prompt || "");
  const auto = !!opts.auto;
  const mode = h("select", { style: { minWidth: "330px" } },
    ...ENHANCE_MODES.map((m) => h("option", { value: m.v }, m.t)));
  const setMode = (v) => { if ([...mode.options].some((o) => o.value === v)) mode.value = v; };
  setMode(auto ? enhanceModeForState() : (opts.mode || "image_prompt"));
  const hint = h("div", { class: "tiny muted", style: { marginTop: "6px" } });
  const paintHint = () => {
    const cur = MODES.find((m) => m.id === state.mode);
    hint.textContent = auto && cur
      ? `创作台当前类型是「${cur.label}」，默认就用「${enhanceModeLabel(enhanceModeForState())}」；换类型会自动跟着换，也可以在这里手动改（改完会记住）。`
      : `当前方式：${enhanceModeLabel(mode.value)}`;
  };
  paintHint();
  mode.onchange = () => {
    if (auto) state.enhanceModes = { ...(state.enhanceModes || {}), [state.mode]: mode.value };
    paintHint();
  };
  const out = h("div", { class: "tiny", style: { maxHeight: "220px", overflow: "auto", marginTop: "10px" } });
  const btn = h("button", { class: "primary", onClick: async () => {
    btn.disabled = true; btn.textContent = "生成中…";
    clear(out); out.append(loadingNode(isExternalLlm(currentLlm()) ? "外部模型正在扩写…" : "本地大模型正在扩写…"));
    try {
      const r = await api.enhance({
        project_id: state.projectId, mode: mode.value, text: ta.value,
        llm: state.llmId, preset: state.llmPreset, thinking: state.llmThinking,
      });
      clear(out);
      out.append(h("pre", { style: { whiteSpace: "pre-wrap", fontSize: "12px" } }, r.raw || ""));
      if (typeof opts.onApply === "function") {
        opts.onApply(r.result, r.raw);
      } else {
        applyEnhanceResult(mode.value, r.result);
        ctx?.reload?.();
      }
    } catch (e) { clear(out); out.append(h("div", { class: "pill err" }, e.message)); }
    btn.disabled = false; btn.textContent = "开始扩写";
  } }, "开始扩写");
  modal(opts.title || "提示词智能扩写 / 文案 / 剧本",
    h("div", null,
      h("div", { class: "field" }, h("label", null, "AI 模型（本地 / 外部商业模型）"), llmPicker(ctx)),
      h("div", { class: "field" }, h("label", null, auto ? "扩写方式（自动跟着创作台所选类型）" : "扩写方式"), mode, hint),
      h("div", { class: "field" }, h("label", null, "你的想法"), ta),
      h("div", { class: "row" }, btn), out),
    [{ label: "关闭", onClick: (c) => c() }]);
}

async function submit(ctx) {
  const wf = currentWorkflow();
  if (!wf) return toast("请先选择生成能力", "warn");
  if (!wf.available) return toast(wf.reasons[0] || "该能力当前不可用", "err");
  if (wf.kind === "text") return toast("文本类任务请使用「智能扩写」", "warn");
  if (!state.prompt && !Object.keys(state.refs).length) return toast("请填写提示词或添加参考素材", "warn");

  const refs = {};
  for (const [k, v] of Object.entries(state.refs)) {
    const ids = (Array.isArray(v) ? v : [v]).filter(Boolean).map((x) => x.id);
    if (!ids.length) continue;
    refs[k] = MULTI_SLOTS.has(k) ? ids : ids[0];
  }
  const params = {
    prompt: state.prompt || "", negative_prompt: state.negative || undefined,
    aspect: state.aspect, duration_s: state.duration,
    style_id: state.styleId || undefined, character_ids: state.characterIds,
    refs,
  };
  try {
    const job = await api.submitJob({ workflow_id: wf.id, project_id: state.projectId, params });
    state.currentJob = job.job_id;
    toast(`任务已提交（${wf.label}）`, "ok");
    const stage = document.getElementById("stage");
    if (stage) { clear(stage); stage.append(h("div", { class: "ph" }, "已提交，等待 ComfyUI 调度…")); }
    watchJob(ctx, job.job_id, wf);
    ctx.refreshQueueBadge?.();
  } catch (e) { toast(e.message, "err"); }
}

function watchJob(ctx, jobId, wf) {
  const bar = () => document.getElementById("stage-bar");
  state.ws?.close();
  state.ws = connectWs(jobId, (ev) => {
    const b = bar();
    if (ev.type === "progress" && b) b.style.width = `${ev.percent}%`;
    if (ev.type === "preview" && ev.image_b64) {
      const stage = document.getElementById("stage");
      if (stage) { clear(stage); stage.append(h("img", { src: ev.image_b64 })); }
    }
    if (ev.type === "error") toast(`生成失败：${ev.message}`, "err", 9000);
    if (ev.type === "done") {
      const b2 = bar(); if (b2) b2.style.width = "100%";
      refreshResults(ctx, jobId, wf);
    }
  });
}

async function refreshResults(ctx, jobId, wf) {
  try {
    const j = await api.job(jobId);
    state.results = (j.assets || []).map((a) => ({ ...a }));
    if (state.results.length) {
      const first = state.results[0];
      const stage = document.getElementById("stage");
      if (stage) {
        clear(stage);
        stage.append(first.kind === "video"
          ? h("video", { src: first.url, controls: true, autoplay: true, loop: true, style: { maxHeight: "520px" } })
          : h("img", { src: first.url }));
        stage.append(resultBar(ctx, first));
      }
      toast(`生成完成，产出 ${state.results.length} 个文件`, "ok");
    } else if (j.status === "failed") {
      toast(`生成失败：${j.error}`, "err", 9000);
    }
    const rl = document.getElementById("result-list");
    if (rl) { clear(rl); state.results.forEach((a) => rl.append(resultCard(a))); }
  } catch (e) { toast(e.message, "err"); }
}

function resultBar(ctx, asset) {
  return h("div", { class: "row wrap", style: { position: "absolute", left: "10px", bottom: "14px", gap: "6px", background: "rgba(10,13,20,.78)", padding: "8px 10px", borderRadius: "10px" } },
    h("a", { href: asset.url, download: "" }, h("button", { class: "sm primary" }, "下载无水印 1080P")),
    h("button", { class: "sm", onClick: () => ctx.go("/assets") }, "加入素材库"),
    h("button", { class: "sm", onClick: () => exportCapcut(ctx) }, "导出剪映草稿"),
    h("button", { class: "sm", onClick: () => toast("参数已保留，可切换「视频拼接」把多段拼成长视频", "ok") }, "继续续写"));
}

function resultCard(a) {
  return h("div", { class: "asset-card" },
    h("div", { class: "thumb" }, a.kind === "image" ? h("img", { src: a.url }) : h("span", null, a.kind === "video" ? "🎬" : a.kind === "audio" ? "🎵" : "📄")),
    h("div", { class: "meta" },
      h("div", null, `${a.kind} · ${fmtSize(a.size_bytes)}`),
      h("div", { class: "tiny muted" }, a.duration_ms ? fmtDur(a.duration_ms) : fmtTime(a.created_at))),
    h("div", { class: "row", style: { padding: "0 8px 8px" } },
      h("a", { href: a.url, download: "", style: { flex: "1" } }, h("button", { class: "sm", style: { width: "100%" } }, "下载"))));
}

async function exportCapcut(ctx) {
  try {
    const r = await api.exportCapcut({ project_id: state.projectId, asset_ids: state.results.map((a) => a.id) });
    toast("剪映草稿包已生成", "ok");
    window.open(r.download_url, "_blank");
  } catch (e) { toast(e.message, "err"); }
}

// ============================================================ 模板广场
function templates(ctx) {
  const box = h("div");
  box.append(h("div", { class: "card" },
    h("h3", null, `内置风格模板（${state.styles.length} 个，可直接用到创作台或故事创作）`),
    h("div", { class: "style-grid" }, state.styles.map((s) =>
      h("div", { class: "style-card" },
        h("b", null, s.name), h("p", null, s.prompt_prefix || s.negative || ""), h("span", { class: "pill" }, s.category),
        h("div", { class: "row wrap", style: { marginTop: "8px", gap: "6px" } },
          h("button", { class: "sm primary", onClick: () => { state.styleId = s.id; ctx.go("/create"); } }, "用于创作台"),
          h("button", { class: "sm", onClick: () => {
            state.storyStyleId = s.id;
            state.storySyncedFor = state.projectId;
            persistStorySelection();
            toast(`已把「${s.name}」设为故事创作的风格`, "ok");
            ctx.go("/story");
          } }, "用于故事创作")))))));

  const q = h("input", { placeholder: "搜索官方模板（如 wan2.2 / minimax / z_image）", style: { maxWidth: "320px" } });
  const onlyLocal = h("input", { type: "checkbox", style: { width: "auto" } });
  const listBox = h("div");
  const search = async () => {
    clear(listBox); listBox.append(loadingNode());
    try {
      const r = await api.templates({ q: q.value, supported: onlyLocal.checked ? "true" : "", limit: 60 });
      clear(listBox);
      listBox.append(h("div", { class: "tiny muted", style: { margin: "8px 0" } },
        `共 ${r.total} 个（显示前 ${r.items.length} 个；本机可直接复现的会标「本机可用」）`));
      listBox.append(h("div", { class: "style-grid" }, r.items.map((t) => h("div", { class: "style-card" },
        h("div", { class: "row", style: { justifyContent: "space-between" } },
          h("b", null, t.title || t.name),
          h("span", { class: `pill ${t.local_supported ? "ok" : ""}` }, t.local_supported ? "本机可用" : "缺模型")),
        h("p", null, t.description || t.name),
        h("div", { class: "chips", style: { marginTop: "6px" } }, ...(t.tags || []).slice(0, 4).map((x) => h("span", { class: "chip" }, x))),
        h("div", { class: "tiny muted", style: { marginTop: "6px" } }, t.local_note || ""),
        t.tutorial_url ? h("a", { href: t.tutorial_url, target: "_blank", class: "tiny" }, "查看官方教程 →") : null))));
    } catch (e) { clear(listBox); listBox.append(h("div", { class: "pill err" }, e.message)); }
  };
  q.oninput = debounce(search, 400);
  onlyLocal.onchange = search;
  box.append(h("div", { class: "card", style: { marginTop: "16px" } },
    h("h3", null, "官方模板广场（实机官方模板快照）"),
    h("div", { class: "row wrap", style: { marginBottom: "8px" } }, q,
      h("label", { class: "row", style: { margin: 0, gap: "6px", color: "var(--dim)" } }, onlyLocal, h("span", null, "只看本机可用"))),
    listBox));
  search();
  return box;
}

// ============================================================ 角色卡
function characters(ctx) {
  const box = h("div");
  box.append(h("div", { class: "row", style: { justifyContent: "space-between", marginBottom: "14px" } },
    h("div", null, h("h2", { style: { margin: 0 } }, "角色卡管理"),
      h("div", { class: "tiny muted" }, "参考图池 ≤20 张 + 角色提示词锁，保证一集/多条视频里人物长相不变；" +
        "可以直接用本机文生图「生成立绘」，再一键「用于创作台 / 用于故事创作」")),
    h("button", { class: "primary", onClick: () => editCharacter(ctx, null) }, "+ 新建角色")));

  const grid = h("div", { class: "grid", style: { gridTemplateColumns: "repeat(auto-fill,minmax(240px,1fr))" } });
  if (!state.characters.length) grid.append(emptyNode("还没有角色卡"));
  for (const c of state.characters) {
    const cover = characterCover(c);
    const nimg = (c.ref_images || []).length;
    grid.append(h("div", { class: "card" },
      h("div", { class: "slot", style: { aspectRatio: "1" } }, cover ? h("img", { src: cover }) : h("span", { class: "plus" }, "🎭")),
      h("h3", { style: { margin: "10px 0 4px" } }, c.name),
      h("div", { class: "tiny muted" }, `参考图 ${nimg}/20` + (nimg ? "" : "　（还没有形象图）")),
      h("div", { class: "tiny muted", style: { height: "32px", overflow: "hidden" } }, c.prompt_lock || "（未设置提示词锁）"),
      h("div", { class: "row wrap", style: { marginTop: "8px", gap: "6px" } },
        h("button", { class: "sm primary", onClick: () => openCharacterGen(ctx, {
          title: `生成立绘 · ${c.name}`, subject: c.name, lock: c.prompt_lock, negative: c.negative,
          onImages: (ids) => attachCharacterImages(ctx, c, ids),
        }) }, "🎨 生成立绘"),
        h("button", { class: "sm", onClick: () => editCharacter(ctx, c) }, "编辑"),
        h("button", { class: "sm", onClick: () => useCharacterIn(ctx, c, "/create") }, "用于创作台"),
        h("button", { class: "sm", onClick: () => useCharacterIn(ctx, c, "/story") }, "用于故事创作"),
        h("button", { class: "sm danger", onClick: () => confirmDialog("删除角色", `确定删除「${c.name}」？`, async () => { await api.deleteCharacter(c.id); ctx.reload(); }) }, "删除"))));
  }
  box.append(grid);
  return box;
}

/** 角色卡封面：优先 ref_image，其次参考图池里任意一张 */
function characterCover(c) {
  const idx = state.__assetIndex || {};
  return idx[c.ref_image]?.url || (c.ref_images || []).map((id) => idx[id]?.url).find(Boolean) || null;
}

/**
 * 素材索引里查不到的 id，有可能是「索引只装了最近一批」而不是「真被删了」。
 * 补拉一次完整清单再判断，避免把好好的参考图误判成失效。
 */
async function ensureAssets(ids = []) {
  const idx = state.__assetIndex || {};
  const miss = [...new Set(ids.filter((id) => id && !idx[id]))];
  if (!miss.length) return idx;
  try {
    const list = await api.assets({ limit: 2000 });
    state.__assetIndex = Object.fromEntries(list.map((a) => [a.id, a]));
    state.assets = list;
  } catch { /* 拉不到就按现状显示，不阻塞 */ }
  return state.__assetIndex || {};
}

/** 轮询任务直到结束（生成立绘用：本机文生图通常几十秒，不必开 WebSocket） */
async function awaitJob(jobId, onTick) {
  for (let i = 0; i < 900; i++) {
    const j = await api.job(jobId);
    if (onTick) onTick(j);
    if (["succeeded", "failed", "canceled"].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return await api.job(jobId);
}

/** 把新生成的形象图挂到角色卡参考图池（≤20），还没有封面时用第一张当封面 */
async function attachCharacterImages(ctx, c, ids) {
  const pool = [...new Set([...(c.ref_images || []), ...ids])].slice(0, 20);
  await api.updateCharacter(c.id, {
    ref_images: pool, ref_image: pool.includes(c.ref_image) ? c.ref_image : (pool[0] || null),
    project_id: c.project_id || state.projectId || null,
  });
  state.characters = await api.characters();
  toast(`已把 ${ids.length} 张形象图加入「${c.name}」的参考图池（${pool.length}/20）`, "ok", 7000);
  ctx.reload();
}

/** 角色卡一键带到创作台 / 故事创作：先勾上这个角色再跳过去 */
function useCharacterIn(ctx, c, path) {
  if (path === "/story") {
    state.storyCharacterIds = state.storyCharacterIds.includes(c.id) ? state.storyCharacterIds : [...state.storyCharacterIds, c.id];
    state.storySyncedFor = state.projectId;
    persistStorySelection();
  } else {
    state.characterIds = state.characterIds.includes(c.id) ? state.characterIds : [...state.characterIds, c.id];
  }
  toast(`已锁定角色「${c.name}」`, "ok");
  ctx.go(path);
}

/**
 * 「AI 生成立绘」：用本机文生图引擎给角色出形象图。
 * 提示词 = 角色名 + 提示词锁（可改），风格模板可选；张数 >1 时并发提交，交给 222 上的多卡并行池调度。
 * 结果通过 onImages(assetIds) 回调交给调用方 —— 卡片上是存进参考图池，编辑弹窗里是放进本地池子。
 */
function openCharacterGen(ctx, opts = {}) {
  const imageWfs = (state.capabilities?.workflows || []).filter((w) => w.kind === "image" && w.available
    && (w.supports?.text2image || w.id.startsWith("WF-01")));
  const wfSel = h("select", { style: { minWidth: "300px" } });
  for (const w of imageWfs) wfSel.append(h("option", { value: w.id, selected: w.id === (state.charGenWf || imageWfs[0]?.id) }, `${w.label}（${w.id}）`));
  if (!imageWfs.length) wfSel.append(h("option", null, state.capabilities ? "当前没有可用的文生图引擎" : "能力清单加载中…"));
  wfSel.onchange = () => { state.charGenWf = wfSel.value; };

  const aspectSel = h("select", null, ...Object.keys(ASPECT_LABEL).map((a) => h("option", { value: a }, ASPECT_LABEL[a])));
  aspectSel.value = "1:1";
  const nSel = h("select", null, ...[1, 2, 3, 4].map((n) => h("option", { value: String(n) }, `${n} 张`)));
  const styleSel = h("select", { style: { minWidth: "220px" } },
    h("option", { value: "" }, "（不套风格模板）"),
    ...state.styles.map((s) => h("option", { value: s.id, selected: s.id === (state.charGenStyleId || "") }, `${s.category} · ${s.name}`)));
  styleSel.onchange = () => { state.charGenStyleId = styleSel.value || null; };

  const subject = h("input", { placeholder: "角色外观关键词，例如：20岁东亚女生，短发，黑色皮夹克" });
  subject.value = [opts.subject, opts.lock].filter(Boolean).join("，");
  const neg = h("input", { placeholder: "负向词（可留空）" });
  neg.value = opts.negative || "";
  const out = h("div", { class: "style-grid", style: { marginTop: "10px" } });
  const stat = h("div", { class: "tiny muted", style: { marginTop: "8px" } });
  const genBtn = h("button", { class: "primary" }, "开始生成");

  genBtn.onclick = async () => {
    if (!imageWfs.length) return toast("当前没有可用的文生图引擎", "err");
    if (!subject.value.trim()) return toast("先写一句角色外观关键词", "warn");
    const n = Number(nSel.value) || 1;
    genBtn.disabled = true; genBtn.textContent = "生成中…";
    clear(out);
    const cards = [];
    for (let i = 0; i < n; i++) {
      const ph = h("div", { class: "style-card" }, h("div", { class: "tiny muted" }, `第 ${i + 1} 张：排队中…`));
      cards.push(ph); out.append(ph);
    }
    stat.textContent = `已提交 ${n} 个任务，交给多卡并行池调度…`;
    const done = [];
    const runOne = async (i) => {
      try {
        const s = await api.submitJob({
          workflow_id: wfSel.value, project_id: state.projectId || undefined,
          title: `角色立绘 · ${opts.subject || "角色"}`,
          params: {
            prompt: subject.value, negative_prompt: neg.value || undefined, aspect: aspectSel.value,
            style_id: styleSel.value || undefined, seed: Math.floor(Math.random() * 1e9),
          },
        });
        const j = await awaitJob(s.job_id, (jj) => {
          clear(cards[i]);
          cards[i].append(h("div", { class: "tiny muted" }, `第 ${i + 1} 张：${jj.status === "running" ? "生成中…" : jj.status}`));
        });
        const imgs = (j.assets || []).filter((a) => a.kind === "image");
        if (!imgs.length) throw new Error(j.error || "没有产出图片");
        const a = imgs[0];
        done.push(a.id);
        state.__assetIndex = { ...(state.__assetIndex || {}), [a.id]: a };
        clear(cards[i]);
        cards[i].append(h("img", { src: a.url, style: { width: "100%", borderRadius: "8px" } }));
      } catch (e) {
        clear(cards[i]);
        cards[i].append(h("div", { class: "pill err" }, `第 ${i + 1} 张失败：${e.message}`));
      }
    };
    await Promise.all(cards.map((_, i) => runOne(i)));
    stat.textContent = `完成 ${done.length}/${n} 张` + (done.length ? "，已交给调用方入库" : "");
    genBtn.disabled = false; genBtn.textContent = "再生一批";
    if (done.length && opts.onImages) opts.onImages(done);
  };

  modal(opts.title || "AI 生成立绘",
    h("div", null,
      h("div", { class: "field" }, h("label", null, "文生图引擎（本机）"), wfSel),
      h("div", { class: "field" }, h("label", null, "角色外观关键词（直接作为提示词）"), subject,
        h("div", { style: { marginTop: "8px" } }, neg)),
      h("div", { class: "row wrap", style: { gap: "10px" } },
        h("div", { class: "field", style: { margin: 0 } }, h("label", null, "比例"), aspectSel),
        h("div", { class: "field", style: { margin: 0 } }, h("label", null, "张数"), nSel),
        h("div", { class: "field", style: { margin: 0 } }, h("label", null, "风格模板"), styleSel)),
      h("div", { class: "row", style: { marginTop: "12px" } }, genBtn),
      stat, out),
    [{ label: "关闭", onClick: (c) => c() }]);
}

function editCharacter(ctx, c) {
  const name = h("input", { value: c?.name || "", placeholder: "角色名，例如：林小满" });
  const lock = h("textarea", { rows: 3, placeholder: "角色提示词锁，例如：20岁东亚女生，短发，左眼角一颗小痣，黑色皮夹克" });
  lock.value = c?.prompt_lock || "";
  const neg = h("input", { placeholder: "角色专属负向词（可留空）", value: c?.negative || "" });
  const pool = [...(c?.ref_images || [])];
  let cover = c?.ref_image && (c.ref_images || []).includes(c.ref_image) ? c.ref_image : (pool[0] || null);
  const thumbs = h("div", { class: "slots" });
  const poolLabel = h("label", null, "参考图池");
  const staleCount = () => pool.filter((id) => !(state.__assetIndex || {})[id]?.url).length;
  const file = h("input", { type: "file", accept: "image/*", multiple: true, style: { display: "none" } });
  const render = () => {
    const idx = state.__assetIndex || {};
    // 封面指向的图已经被删掉时，自动落到池子里第一张还能用的图上（不用用户先清一遍）
    if (cover && !idx[cover]?.url) cover = pool.find((id) => idx[id]?.url) || cover;
    if (!pool.includes(cover)) cover = pool[0] || null;
    clear(thumbs);
    pool.forEach((id, i) => {
      const url = idx[id]?.url || null;
      const isCover = cover === id;
      thumbs.append(h("div", { class: `slot ${isCover ? "cover" : ""} ${url ? "" : "bad"}` },
        h("span", { class: "idx" }, i + 1),
        isCover ? h("span", { class: "cov" }, "封面") : null,
        h("button", { class: "del", title: "从参考图池移除", onClick: (e) => { e.stopPropagation(); pool.splice(i, 1); render(); } }, "×"),
        url
          ? h("img", { src: url, alt: `图${i + 1}`, loading: "lazy", title: "点击看大图", onClick: () => previewAsset(id) })
          : h("div", { class: "tiny", style: { padding: "6px", textAlign: "center", color: "#e0a03a" } }, "这张已失效"),
        url ? h("div", { class: "slot-ops" },
          isCover ? null : h("button", { class: "xs", onClick: (e) => { e.stopPropagation(); cover = id; render(); } }, "设为封面"),
          i > 0 ? h("button", { class: "xs", title: "往前挪", onClick: (e) => { e.stopPropagation(); const [x] = pool.splice(i, 1); pool.splice(i - 1, 0, x); render(); } }, "←") : null,
          i < pool.length - 1 ? h("button", { class: "xs", title: "往后挪", onClick: (e) => { e.stopPropagation(); const [x] = pool.splice(i, 1); pool.splice(i + 1, 0, x); render(); } }, "→") : null) : null));
    });
    if (pool.length < 20) thumbs.append(h("div", { class: "slot", onClick: () => file.click(), title: "上传图片 / 生成立绘" }, h("span", { class: "plus" }, "+")));
    const n = staleCount();
    poolLabel.textContent = `参考图池（${pool.length}/20，封面是第 ${Math.max(1, pool.indexOf(cover) + 1)} 张）${n ? ` · ${n} 张已失效` : ""}`;
  };
  file.onchange = async () => {
    for (const f of [...file.files].slice(0, 20 - pool.length)) {
      try { const a = await api.upload(f, { projectId: state.projectId || "" }); pool.push(a.id); } catch (e) { toast(e.message, "err"); }
    }
    file.value = ""; render();
  };
  render();
  ensureAssets(pool).then(() => render());
  modal(c ? "编辑角色卡" : "新建角色卡",
    h("div", null,
      h("div", { class: "field" }, h("label", null, "角色名"), name),
      h("div", { class: "field" }, h("label", null, "提示词锁（每次生成自动拼接）"), lock),
      h("div", { class: "field" }, h("label", null, "角色负向词"), neg),
      h("div", { class: "field" }, poolLabel, thumbs, file,
        h("div", { class: "row wrap", style: { marginTop: "8px", gap: "8px" } },
          h("button", { class: "sm", onClick: () => openCharacterGen(ctx, {
            title: `生成立绘 · ${name.value || "新角色"}`,
            subject: name.value, lock: lock.value, negative: neg.value,
            onImages: (ids) => {
              for (const id of ids) { if (pool.length < 20) pool.push(id); }
              render();
              toast(`已生成立绘并放进参考图池（${pool.length}/20）；点「保存」写入角色卡`, "ok", 7000);
            },
          }) }, "🎨 AI 生成立绘（本机文生图）"),
          h("button", { class: "sm", onClick: () => {
            const before = pool.length;
            for (let i = pool.length - 1; i >= 0; i--) if (!(state.__assetIndex || {})[pool[i]]?.url) pool.splice(i, 1);
            render();
            const n = before - pool.length;
            toast(n ? `已清理 ${n} 张失效图，记得点「保存」写进角色卡` : "参考图池里没有失效的图", n ? "ok" : "info");
          } }, "🧹 清理失效图"),
          h("span", { class: "tiny muted" }, "生成结果自动进参考图池，保存后即生效；也可以直接从本地上传图片")))),
    [{ label: "取消", onClick: (x) => x() }, {
      label: "保存", primary: true, onClick: async (x) => {
        try {
          const body = { name: name.value || "角色", prompt_lock: lock.value, negative: neg.value, ref_images: pool, project_id: state.projectId, ref_image: cover || pool[0] || null };
          if (c) await api.updateCharacter(c.id, body); else await api.createCharacter(body);
          state.characters = await api.characters(state.projectId || undefined);
          toast("已保存", "ok"); x(); ctx.reload();
        } catch (e) { toast(e.message, "err"); }
      },
    }]);
}

// ============================================================ 故事创作 / 分镜
const CAMERA_OPTIONS = [
  { v: "static", t: "固定机位" }, { v: "zoom_in", t: "推近" }, { v: "zoom_out", t: "拉远" },
  { v: "pan_left", t: "左摇" }, { v: "pan_right", t: "右摇" }, { v: "orbit", t: "环绕" }, { v: "track", t: "跟拍" },
];
const SHOT_TYPES = ["大远景", "远景", "全景", "中景", "近景", "特写", "大特写"];

async function loadStory(ctx) {
  if (!state.projectId) { state.scripts = []; state.scriptsLoadedFor = null; state.script = null; state.shots = []; return; }
  if (state.scriptsLoadedFor === state.projectId) return;
  state.scriptsLoadedFor = state.projectId;
  try {
    state.scripts = await api.scripts(state.projectId);
    if (state.scripts.length) {
      const full = await api.script(state.scripts[0].id);
      state.script = full;
      state.shots = full.shots || [];
    } else { state.script = null; state.shots = []; }
    ctx.reload();
  } catch (e) { toast(e.message, "err"); }
}

/** 拉取本地 LLM 清单（故事创作的模型选择器数据源） */
async function loadLlms() {
  try {
    state.llms = await api.llms();
    const avail = (state.llms.models || []).filter((m) => m.available);
    if (!state.llmId || !avail.some((m) => m.id === state.llmId)) {
      state.llmId = state.llms.default && avail.some((m) => m.id === state.llms.default)
        ? state.llms.default : (avail[0] || {}).id || null;
    }
    if (!state.llmPreset) state.llmPreset = "balanced";
  } catch {
    state.llms = { models: [], presets: [], groups: [], default: null };
  }
}

/** 拉取多卡并行池状态（192.168.0.222 上的 4 张卡） */
async function loadPool() {
  try { state.pool = await api.pool(); } catch { state.pool = null; }
}

function poolText() {
  const cap = state.pool?.capacity;
  if (!cap || !cap.instances) return "";
  return `　并行算力：${cap.instances} 张显卡，可同时跑 ${cap.total} 个任务`;
}
/**
 * 故事创作可选的视频引擎。
 *
 * 这一页的流水线是「先出首帧图、再图生视频」，所以只列能接首帧的引擎：
 * 口型驱动（要额外音轨）、参考视频驱动、视频拼接、视频改图这些不接首帧的能力全部排除，
 * 免得在下拉里选到一个「点了就报缺素材」的引擎。
 */
function storyVideoEngines() {
  return (state.capabilities?.workflows || []).filter((w) => w.kind === "video" && w.available
    && w.supports?.image2video
    && !w.supports?.audioDriven && !w.supports?.concat
    && !w.supports?.video2video && !w.supports?.reference
    && w.mode !== "animate" && w.mode !== "s2v");
}

/** 默认引擎：MiniMax-H3 图生视频——画面和声音一次生成（台词 / 环境音 / 配乐）；台词默认交给本机配音念 */
const DEFAULT_STORY_VIDEO_WF = "WF-15";

/** 当前生效的视频引擎：这次手选的 > 项目里存过的 > 默认 MiniMax */
function storyVideoWfId() {
  const list = storyVideoEngines();
  const saved = (state.projects.find((p) => (p.value ?? p.id) === state.projectId) || {}).meta?.video_workflow;
  for (const id of [state.storyVideoWf, saved, DEFAULT_STORY_VIDEO_WF]) {
    if (id && list.some((w) => w.id === id)) return id;
  }
  return (list[0] || {}).id || DEFAULT_STORY_VIDEO_WF;
}

/** 某个视频引擎是不是「画面和声音一起生成」的那种（MiniMax-H3 / LTX-2.5） */
function engineHasAudio(wfId) {
  const id = wfId || storyVideoWfId();
  const wf = (state.capabilities?.workflows || []).find((w) => w.id === id);
  return !!wf?.hasAudio;
}

/**
 * 「带声音」到底开不开。默认（null）跟着引擎走：自带声音的引擎开、无声引擎关。
 *
 * 为什么自带声音的引擎也默认开：MiniMax-H3 / LTX-2.5 让模型自己念中文极不稳定，
 * 实测经常吐出一段听不懂的杂音人声（用户反馈的「声音乱码」）。改成本机 TTS 念台词、
 * 模型只出环境音与配乐，声音才干净。用户想听模型原声，把「带声音」的勾去掉即可。
 */
function effectiveStoryVoice(wfId) {
  return state.storyWithVoice === null || state.storyWithVoice === undefined
    ? engineHasAudio(wfId)
    : !!state.storyWithVoice;
}

/** 引擎选择器：下拉即改，选完顺手存进项目（下次进来自动带出来） */
function storyEngineRow(ctx) {
  const list = storyVideoEngines();
  const sel = h("select", { style: { minWidth: "320px" } });
  if (!list.length) {
    sel.disabled = true;
    sel.append(h("option", null, state.capabilities ? "当前没有可用的视频引擎" : "能力清单加载中…"));
  } else {
    const cur = storyVideoWfId();
    for (const w of list) {
      const tags = [w.engine, w.fps ? `${w.fps}fps` : null,
        w.hasAudio ? "自带声音" : "无声",
        w.maxDurationS ? `单镜≤${w.maxDurationS}s` : null].filter(Boolean).join(" · ");
      sel.append(h("option", { value: w.id, selected: w.id === cur }, `${w.label}（${tags}）`));
    }
    sel.onchange = () => {
      state.storyVideoWf = sel.value;
      const proj = state.projects.find((p) => (p.value ?? p.id) === state.projectId);
      if (proj) {
        const meta = { ...(proj.meta || {}), video_workflow: sel.value };
        proj.meta = meta;
        api.updateProject(proj.id, { meta }).catch(() => {});
      }
      ctx.reload();
    };
  }
  const wf = list.find((w) => w.id === storyVideoWfId());
  const hint = !wf ? null : (wf.hasAudio
    ? `${wf.id} · ${wf.engine}：画面与声音一次生成（台词 / 环境音 / 配乐），单镜最长 ${wf.maxDurationS || "?"} 秒。默认由本机配音念台词、模型只出环境音——模型自己念中文容易出听不懂的杂音人声；取消「带声音」才会让模型自己说。`

    : `${wf.id} · ${wf.engine}：这个引擎不出声音，想要声音请勾下面「带声音」（按分镜台词自动配音）。`);
  return h("div", null, sel, hint ? h("div", { class: "tiny muted", style: { marginTop: "6px" } }, hint) : null);
}

/** 当前选中的模型条目（本地或外部） */
function currentLlm() {
  return (((state.llms || {}).models) || []).find((m) => m.id === state.llmId) || null;
}

const isExternalLlm = (m) => !!m && m.source === "external";

/**
 * AI 模型选择器：本地模型 / 外部商业模型分组 + 采样预设 + 深度思考。
 * 外部模型旁边给出醒目的「数据会出网」提示，避免误用。
 */
function llmPicker(ctx, opts = {}) {
  // 默认沿用全局的 state.llmId（创作台 / 爆款复刻 / 故事创作共用一份选择）。
  // 传 key / presetKey 就让这个页面用自己的选择，互不影响 —— 音乐页和翻唱页就是这么用的。
  const key = opts.key || "llmId";
  const presetKey = opts.presetKey || "llmPreset";
  const thinkKey = opts.thinkKey || "llmThinking";
  const info = state.llms;
  const llmSel = h("select", { style: { minWidth: "290px" } });
  const presetSel = h("select");
  const thinkChk = h("input", { type: "checkbox", checked: !!state[thinkKey] });
  thinkChk.onchange = () => { state[thinkKey] = thinkChk.checked; };
  const hint = h("div", { class: "tiny muted", style: { flexBasis: "100%", marginTop: "2px" } });
  const cfgBtn = h("button", { class: "sm ghost", onClick: () => openLlmProviders(ctx) }, "⚙️ 配置外部模型");

  const modelOf = (id) => ((info && info.models) || []).find((m) => m.id === id) || null;

  const refreshHint = () => {
    const m = modelOf(llmSel.value);
    if (!m) { hint.textContent = ""; return; }
    if (!m.available) {
      hint.textContent = `不可用：${(m.reasons || []).join("；")}`;
      hint.style.color = "#ff8b8b";
    } else if (isExternalLlm(m)) {
      hint.textContent = `当前：${m.label}　⚠️ 外部商业模型：提示词会发送到「${m.provider}」并按其价格计费`;
      hint.style.color = "#e0a458";
    } else {
      hint.textContent = `当前：${m.label}${m.note ? `　·　${m.note}` : ""}　·　本地权重，不出网`;
      hint.style.color = "";
    }
  };

  if (!info || !(info.models || []).length) {
    llmSel.append(h("option", null, "模型清单加载中…"));
    hint.textContent = "正在读取 192.168.0.222 上可用的本地大模型…";
  } else {
    // 按后端给的分组渲染（本地 / 外部），没有分组信息时退化成单一列表
    const groups = (info.groups && info.groups.length)
      ? info.groups
      : [{ id: "all", label: "模型", model_ids: info.models.map((m) => m.id) }];
    for (const g of groups) {
      const items = (g.model_ids || []).map(modelOf).filter(Boolean);
      if (!items.length) continue;
      const og = h("optgroup", { label: g.label });
      for (const m of items) {
        og.append(h("option", { value: m.id, disabled: !m.available, selected: m.id === state[key] },
          m.available ? m.label : `⛔ ${m.label}`));
      }
      llmSel.append(og);
    }
    for (const p of info.presets || []) {
      presetSel.append(h("option", { value: p.id, selected: p.id === state[presetKey] }, p.label));
    }
    if (!state[key]) state[key] = llmSel.value;
    llmSel.onchange = () => { state[key] = llmSel.value; refreshHint(); };
    presetSel.onchange = () => { state[presetKey] = presetSel.value; };
    refreshHint();
  }

  const cap = (t) => h("span", { class: "tiny muted", style: { whiteSpace: "nowrap" } }, t);
  return h("div", { class: "row wrap", style: { gap: "8px", alignItems: "center" } },
    cap(opts.label || "AI 模型"), llmSel,
    cap("采样"), presetSel,
    h("label", { class: "tiny", style: { display: "inline-flex", flex: "0 0 auto", gap: "4px", alignItems: "center", cursor: "pointer", whiteSpace: "nowrap" } },
      thinkChk, "深度思考"),
    cfgBtn,
    hint);
}

/**
 * 外部商业模型配置面板：新增 / 编辑 / 测试 / 删除连接器。
 * API Key 只保存在服务器本地，界面永远只回显打码值。
 */
function openLlmProviders(ctx) {
  const root = h("div");
  let editing = null;      // 正在编辑的连接器；null = 新增
  let testedModels = [];   // 「测试连接」拉回来的真实模型清单
  let dlSeq = 0;

  modal("外部商业模型（第三方 API）", root, [
    { label: "完成", primary: true, onClick: (c) => { c(); loadLlms().then(() => ctx && ctx.reload && ctx.reload()).catch(() => {}); } },
  ]);

  const fld = (label, node) => h("div", { class: "field" }, h("label", null, label), node);

  async function render() {
    clear(root);
    let data;
    try { data = await api.llmProviders(); }
    catch (e) { root.append(h("div", { class: "pill err" }, `读取连接器失败：${e.message}`)); return; }

    // -------------------------------------------------- 已配置列表
    root.append(h("div", { class: "tiny muted", style: { marginBottom: "10px" } },
      "外部模型完全可选：不配置时，故事创作只用 192.168.0.222 上的本地权重，提示词不出网。",
      h("br"),
      "API Key 保存在服务器的 ",
      h("code", null, data.store_file),
      "，界面只回显打码值。"));

    const list = h("div", { style: { marginBottom: "14px" } });
    if (!data.connectors.length) {
      list.append(h("div", { class: "tiny muted" }, "（还没有配置任何外部模型）"));
    } else {
      for (const c of data.connectors) {
        const t = c.last_test;
        const pill = t
          ? (t.ok ? h("span", { class: "pill ok" }, "已连通") : h("span", { class: "pill err" }, "测试失败"))
          : h("span", { class: "pill" }, "未测试");
        const testBtn = h("button", { class: "sm", onClick: async () => {
          testBtn.disabled = true; testBtn.textContent = "测试中…";
          try {
            const r = await api.testLlmProvider({ id: c.id });
            toast(r.ok ? `「${c.label}」连通正常，可用模型 ${(r.models || []).length} 个` : `「${c.label}」测试失败：${r.error}`, r.ok ? "ok" : "err", 9000);
          } catch (err) { toast(err.message, "err", 9000); }
          render();
        } }, "测试");
        list.append(h("div", { class: "row wrap", style: { justifyContent: "space-between", gap: "8px", padding: "7px 0", borderBottom: "1px solid var(--line, #2a2a35)" } },
          h("div", { style: { minWidth: "240px" } },
            h("b", null, c.label), " ",
            pill,
            h("div", { class: "tiny muted" }, `${c.model || "（未选模型）"}　${c.api_key_masked || "未配置 Key"}　${c.base_url}`),
            t && !t.ok ? h("div", { class: "tiny", style: { color: "#ff8b8b" } }, t.error) : null),
          h("div", { class: "row", style: { gap: "6px" } },
            testBtn,
            h("button", { class: "sm", onClick: () => { editing = c; testedModels = []; render(); } }, "编辑"),
            h("button", { class: "sm ghost", onClick: async () => {
              try {
                await api.deleteLlmProvider(c.id);
                if (editing && editing.id === c.id) editing = null;
                toast("已删除", "ok");
                render();
              } catch (err) { toast(err.message, "err"); }
            } }, "删除"))));
      }
    }
    root.append(list);

    // -------------------------------------------------- 新增 / 编辑表单
    const presetSel = h("select");
    for (const p of data.presets) {
      presetSel.append(h("option", { value: p.id, selected: (editing ? editing.preset : "custom") === p.id }, p.label));
    }
    const labelIn = h("input", { value: editing ? editing.label : "", placeholder: "例如：DeepSeek 正式账号" });
    const baseIn = h("input", { value: editing ? editing.base_url : "", placeholder: "https://api.deepseek.com/v1" });
    const keyIn = h("input", {
      type: "password",
      placeholder: editing && editing.has_key ? `已保存 ${editing.api_key_masked}，留空表示不修改` : "sk-…（只保存在本机服务器）",
    });
    const dlId = `llm-models-${++dlSeq}`;
    const modelIn = h("input", { list: dlId, value: editing ? editing.model : "", placeholder: "点「测试连接」拉取清单，或直接手填" });
    const dl = h("datalist", { id: dlId });
    const fillModels = () => { clear(dl); for (const m of testedModels) dl.append(h("option", { value: m })); };
    fillModels();

    const presetHint = h("div", { class: "tiny muted" }, "");
    const applyPreset = () => {
      const p = data.presets.find((x) => x.id === presetSel.value);
      if (!p) return;
      presetHint.textContent = p.note || "";
      if (!editing) {
        // 「自定义」没有具体厂商，名称留空让用户自己起，避免填出一个没意义的默认名
        labelIn.value = p.id === "custom" ? "" : p.label;
        baseIn.value = p.baseUrl;
      }
    };
    presetSel.onchange = () => applyPreset();
    applyPreset();

    const kindOf = () => {
      const p = data.presets.find((x) => x.id === presetSel.value);
      return p ? p.kind : "openai";
    };
    const testOut = h("div", { class: "tiny", style: { marginTop: "6px", whiteSpace: "pre-wrap" } });
    const testBtn = h("button", { class: "sm", onClick: async () => {
      testBtn.disabled = true; testBtn.textContent = "测试中…";
      clear(testOut); testOut.append("正在连接并拉取模型清单…");
      try {
        const r = await api.testLlmProvider({
          ...(editing ? { id: editing.id } : {}),
          label: labelIn.value, base_url: baseIn.value,
          api_key: keyIn.value || undefined,
          kind: kindOf(), model: modelIn.value,
        });
        clear(testOut);
        if (r.ok) {
          testedModels = r.models || [];
          fillModels();
          if (!modelIn.value && testedModels.length) modelIn.value = testedModels[0];
          testOut.append(h("span", { class: "pill ok" }, "连通正常"),
            ` 拉取到 ${testedModels.length} 个模型${r.mode === "chat" ? "（该服务没有 /models，已用对话请求验证）" : ""}`);
        } else {
          testOut.append(h("span", { class: "pill err" }, "失败"), " ", String(r.error || ""));
        }
      } catch (e) { clear(testOut); testOut.append(h("span", { class: "pill err" }, e.message)); }
      testBtn.disabled = false; testBtn.textContent = "测试连接";
    } }, "测试连接");

    const saveBtn = h("button", { class: "primary", onClick: async () => {
      const body = {
        label: labelIn.value, preset: presetSel.value, kind: kindOf(),
        base_url: baseIn.value, model: modelIn.value,
        ...(keyIn.value ? { api_key: keyIn.value } : {}),
      };
      saveBtn.disabled = true;
      try {
        if (editing) await api.updateLlmProvider(editing.id, body);
        else await api.createLlmProvider(body);
        toast(editing ? "已保存修改" : "已添加外部模型", "ok");
        editing = null; testedModels = [];
        render();
      } catch (e) { toast(e.message, "err", 9000); }
      saveBtn.disabled = false;
    } }, editing ? "保存修改" : "添加");

    root.append(h("div", { style: { borderTop: "1px solid var(--line, #2a2a35)", paddingTop: "12px" } },
      h("h4", { style: { margin: "0 0 8px" } }, editing ? `编辑：${editing.label}` : "新增连接器"),
      fld("厂商 / 协议", h("div", null, presetSel, presetHint)),
      fld("名称", labelIn),
      fld("接口地址（Base URL）", baseIn),
      fld("API Key", keyIn),
      fld("模型名", h("div", null, modelIn, dl)),
      h("div", { class: "row wrap", style: { gap: "8px" } },
        testBtn, saveBtn,
        editing ? h("button", { class: "sm ghost", onClick: () => { editing = null; testedModels = []; render(); } }, "取消编辑") : null),
      testOut));
  }

  render();
}
/** 把故事创作页选的角色 / 风格存回项目（下次进来、以及后端批量出片时都以它为准） */
function persistStorySelection() {
  const proj = state.projects.find((p) => (p.value ?? p.id) === state.projectId);
  if (!proj) return;
  const meta = { ...(proj.meta || {}), character_ids: [...(state.storyCharacterIds || [])] };
  proj.meta = meta;
  proj.style_id = state.storyStyleId || null;
  api.updateProject(proj.id, { meta, style_id: state.storyStyleId || null }).catch(() => {});
}

/** 切项目时把项目上存过的风格 / 角色同步进选择器（同一个项目内不覆盖用户手选） */
function syncStoryFromProject() {
  if (!state.projectId || state.storySyncedFor === state.projectId) return;
  const proj = state.projects.find((p) => (p.value ?? p.id) === state.projectId);
  if (!proj) return;
  state.storySyncedFor = state.projectId;
  state.storyStyleId = proj.style_id || null;
  state.storyCharacterIds = [...((proj.meta && proj.meta.character_ids) || [])];
}

/** 故事创作的风格模板选择器（与创作台 / 模板广场共用同一批模板） */
function storyStylePicker(ctx) {
  const cur = state.styles.find((s) => s.id === state.storyStyleId);
  return h("div", null,
    h("div", { class: "row wrap", style: { gap: "6px" } },
      h("div", { class: "pill acc", style: { flex: "1", padding: "8px 10px" } },
        cur ? `${cur.category} · ${cur.name}` : "未选择（整条片子用引擎默认画风）"),
      h("button", { class: "sm", onClick: () => storyStyleModal(ctx) }, "选择模板"),
      h("button", { class: "sm ghost", onClick: () => ctx.go("/templates") }, "模板广场"),
      cur ? h("button", { class: "sm ghost", onClick: () => {
        state.storyStyleId = null; state.storySyncedFor = state.projectId; persistStorySelection(); ctx.reload();
      } }, "清除") : null),
    h("div", { class: "tiny muted", style: { marginTop: "6px" } },
      cur
        ? `拆分镜和出片都会带上「${cur.prompt_prefix || cur.name}」，整条片子统一画风。`
        : "选一个模板：AI 拆分镜会按这个画风写，出片时也会自动给每个镜头套上（和创作台、模板广场是同一批模板）。"));
}

function storyStyleModal(ctx) {
  const grid = h("div", { class: "style-grid" }, state.styles.map((s) => h("div", {
    class: `style-card ${state.storyStyleId === s.id ? "on" : ""}`,
    onClick: () => {
      state.storyStyleId = s.id;
      state.storySyncedFor = state.projectId;
      persistStorySelection();
      close(); ctx.reload();
    },
  }, h("b", null, s.name), h("p", null, s.prompt_prefix || s.negative || s.category), h("span", { class: "pill" }, s.category))));
  const close = modal("风格模板 · 用于故事创作（整条片子统一画风）", grid);
}

function story(ctx) {
  if (!state.scripts) state.scripts = [];
  if (!state.shots) state.shots = [];
  syncStoryFromProject();
  loadStory(ctx);
  // 模型清单 / 算力池只拉一次，拿到后重绘一次选择器
  if (!state.metaLoaded) {
    state.metaLoaded = true;
    Promise.all([loadLlms(), loadPool()]).then(() => ctx.reload()).catch(() => {});
  }
  if (state.tts === null) loadTts(ctx);

  const box = h("div");
  const idea = h("textarea", { rows: 4, placeholder: "写一句故事梗概，例如：外卖小哥深夜送单，在电梯里遇见三年后的自己…" });
  idea.value = state.storyIdea || "";
  idea.oninput = () => { state.storyIdea = idea.value; };
  // 上限给到 60：镜头数量按你填的来（后端会强制校验并补齐缺口），别让人以为最多只能 12 个
  const nShots = h("input", { type: "number", min: 2, max: 60, value: state.storyShotCount || 4, style: { width: "86px" } });
  nShots.oninput = () => { state.storyShotCount = Number(nShots.value) || 4; };

  // 带声音：每个镜头生成画面后，用它自己的台词合成配音并合轨（声音来自本机/你配置的语音服务）
  const withVoice = effectiveStoryVoice();
  const autoVoice = state.storyWithVoice === null || state.storyWithVoice === undefined;
  const voiceChk = h("input", { type: "checkbox", checked: withVoice });
  voiceChk.onchange = () => { state.storyWithVoice = voiceChk.checked; ctx.reload(); };
  // 字幕：把这一镜的台词烧成硬字幕（本机 ffmpeg）。默认开 ——「一键生成全部镜头」出来的片子
  // 直接带字、能发；拼接成片时若片段已经自带字幕会自动跳过，不会叠两层。
  const subChk = h("input", { type: "checkbox", checked: state.storyBurnSubs !== false });
  subChk.onchange = () => { state.storyBurnSubs = subChk.checked; ctx.reload(); };
  const voiceRow = h("div", { class: "row wrap", style: { gap: "10px", alignItems: "center" } },
    h("label", { class: "tiny", style: { display: "inline-flex", gap: "4px", alignItems: "center", cursor: "pointer", whiteSpace: "nowrap" } },
      voiceChk, "带声音（按分镜台词自动配音）"),
    h("label", { class: "tiny", style: { display: "inline-flex", gap: "4px", alignItems: "center", cursor: "pointer", whiteSpace: "nowrap" } },
      subChk, "镜头带字幕（台词烧在画面上）"),
    withVoice ? ttsControls(ctx, "配音引擎") : null);
  const voiceHint = engineHasAudio() && autoVoice
    ? h("div", { class: "tiny muted", style: { marginTop: "6px" } },
      "当前引擎自带声音，但模型自己念中文经常是听不懂的杂音人声；这里默认改用本机配音念台词、"
      + "模型只出环境音与配乐，声音更清楚。想听模型原声就把「带声音」的勾去掉。")
    : null;
  const genBtn = h("button", { class: "primary", onClick: async () => {
    if (!state.projectId) return toast("请先选择项目", "warn");
    if (!idea.value.trim()) return toast("请先写一段故事梗概", "warn");
    const viaText = isExternalLlm(currentLlm()) ? "外部模型" : "本地模型";
    genBtn.disabled = true; genBtn.textContent = `${viaText}拆分镜中…`;
    try {
      persistStorySelection();
      const r = await api.genScript({
        project_id: state.projectId, story: idea.value,
        shot_count: Number(nShots.value) || 4, aspect: state.aspect,
        style_id: state.storyStyleId || undefined,
        character_ids: state.storyCharacterIds,
        llm: state.llmId, preset: state.llmPreset, thinking: state.llmThinking,
      });
      state.script = r.script; state.shots = r.shots || [];
      state.scriptsLoadedFor = state.projectId;
      const shortOf = r.requested_shots && state.shots.length < r.requested_shots;
      toast(r.note || `已生成 ${state.shots.length} 个分镜`, shortOf ? "warn" : "ok", shortOf ? 12000 : 5000);
      ctx.reload();
    } catch (e) { toast(e.message, "err", 9000); }
    genBtn.disabled = false; genBtn.textContent = "① AI 拆分镜";
  } }, "① AI 拆分镜");

  box.append(h("div", { class: "card" },
    h("h3", null, "故事创作模式（短剧号 / 剧情号）"),
    h("div", { class: "tiny muted" }, "一条脚本一次性生成多个镜头，人物跨镜头保持一致；「带声音」把每镜台词配成清晰中文并合到画面上，「镜头带字幕」再把台词烧成硬字幕；生成完成后可拼接成片并一键导出剪映草稿。" + poolText()),
    h("div", { class: "field" }, h("label", null, "项目",
      h("span", { class: "tiny muted" }, "　选已有项目，或直接输入名字新建；产物文件名以项目名开头")), projectNameRow(ctx)),
    h("div", { class: "field" }, h("label", null, "故事梗概 / 脚本"), idea),
    h("div", { class: "field" }, h("label", null, "AI 模型（本地 / 外部商业模型）"), llmPicker(ctx)),
    h("div", { class: "field" }, h("label", null, "视频引擎（分镜出片）"), storyEngineRow(ctx)),
    h("div", { class: "field" }, h("label", null, "风格模板（整条片子统一画风）"), storyStylePicker(ctx)),
    h("div", { class: "field" }, h("label", null, "角色锁定（跨镜头保持长相，可多选）"), characterPicker(ctx, "storyCharacterIds")),
    h("div", { class: "field" }, h("label", null, "声音 / 字幕（可选）"), voiceRow, voiceHint),
    h("div", { class: "row wrap", style: { gap: "8px", alignItems: "center" } },
      h("span", { class: "tiny muted" }, "镜头数"), nShots, genBtn,
      h("button", { onClick: () => openEnhance(ctx, {
        title: "提示词 / 剧本扩写助手",
        mode: "storyboard",
        initial: idea.value,
        onApply: (result, raw) => {
          const text = enhanceToScript(result, raw);
          if (!text) return toast("扩写没有返回可用内容，可以看下面的原文再手动粘贴", "warn", 7000);
          state.storyIdea = text;
          idea.value = text;
          toast("已把扩写结果填回「故事梗概 / 脚本」，点「① AI 拆分镜」就能出分镜", "ok", 8000);
        },
      }) }, "提示词 / 剧本扩写助手"))));

  const card = h("div", { class: "card", style: { marginTop: "16px" } });
  if (!state.script || !state.shots.length) {
    card.append(emptyNode(state.projectId ? "该项目还没有分镜表，先在上方生成" : "请先在上方选择项目"));
  } else {
    const totalSec = state.shots.reduce((s, x) => s + (x.duration_s || 5), 0);
    const cap = state.pool?.capacity;
    card.append(h("div", { class: "row wrap", style: { justifyContent: "space-between", gap: "8px" } },
      h("div", null,
        h("h3", { style: { margin: 0 } }, `分镜表 · ${state.shots.length} 个镜头 · 约 ${totalSec} 秒`),
        h("div", { class: "tiny muted" }, (state.script.logline || "") + (cap ? `　（${cap.instances} 卡并行，最多同时生成 ${cap.total} 个镜头）` : ""))),
      h("div", { class: "row wrap", style: { gap: "6px" } },
        h("button", { class: "sm primary", onClick: () => runAll(ctx) }, "② 一键生成全部镜头"),
        h("button", { class: "sm", onClick: () => assembleFinal(ctx) }, "③ 拼接成片（排顺序 / 烧字幕）"),
        h("button", { class: "sm", onClick: () => exportCapcut(ctx) }, "④ 导出剪映草稿"),
        h("button", { class: "sm ghost", onClick: () => { state.scriptsLoadedFor = null; ctx.reload(); } }, "刷新"))));
    card.append(h("div", { style: { marginTop: "12px" } }, state.shots.map((s) => shotRow(ctx, s))));
  }
  box.append(card);
  return box;
}
function shotRow(ctx, s) {
  const prompt = h("textarea", { rows: 2, placeholder: "画面提示词" });
  prompt.value = s.prompt || "";
  prompt.oninput = debounce(() => {
    api.updateShot(s.id, { prompt: prompt.value }).catch((e) => toast(e.message, "err"));
  }, 700);
  const dialogue = h("input", { placeholder: "台词 / 口播音（勾选「带声音」时会自动配音并合到该镜画面上）", value: s.dialogue || "" });
  dialogue.oninput = debounce(() => {
    api.updateShot(s.id, { dialogue: dialogue.value }).catch((e) => toast(e.message, "err"));
  }, 700);
  const typeSel = h("select", null, ...SHOT_TYPES.map((t) => h("option", { value: t, selected: s.shot_type === t }, t)));
  typeSel.onchange = () => api.updateShot(s.id, { shot_type: typeSel.value }).catch((e) => toast(e.message, "err"));
  const camSel = h("select", null, ...CAMERA_OPTIONS.map((c) => h("option", { value: c.v, selected: s.camera_move === c.v }, c.t)));
  camSel.onchange = () => api.updateShot(s.id, { camera_move: camSel.value }).catch((e) => toast(e.message, "err"));
  const dur = h("input", { type: "number", min: 2, max: 20, value: s.duration_s || 5, style: { width: "72px" } });
  dur.onchange = () => api.updateShot(s.id, { duration_s: Number(dur.value) || 5 }).catch((e) => toast(e.message, "err"));

  const runBtn = h("button", { class: "sm primary", onClick: async () => {
    runBtn.disabled = true; runBtn.textContent = "生成中…";
    try {
      const r = await api.runShot(s.id, { video_workflow: storyVideoWfId(),
        style_id: state.storyStyleId || undefined, character_ids: state.storyCharacterIds,
        with_voice: effectiveStoryVoice(), burn_subtitles: state.storyBurnSubs !== false });
      toast(r.ok ? `镜头 ${s.idx} 生成完成` : `镜头 ${s.idx} 失败：${r.error || ""}`, r.ok ? "ok" : "err", 8000);
      state.scriptsLoadedFor = null; ctx.reload();
    } catch (e) { toast(e.message, "err"); runBtn.disabled = false; runBtn.textContent = "生成"; }
  } }, "生成");

  return h("div", { class: "shot" },
    h("div", { class: "no" }, String(s.idx)),
    h("div", { style: { flex: "1", minWidth: "240px" } },
      h("div", { class: "row wrap", style: { gap: "6px", marginBottom: "6px" } }, prompt),
      h("div", { class: "row wrap", style: { gap: "6px", alignItems: "center" } },
        typeSel, camSel, dur, h("span", { class: "tiny muted" }, "秒"), statusPill(s.status), dialogue)),
    h("div", { style: { width: "96px", textAlign: "right" } }, runBtn));
}

async function runAll(ctx) {
  if (!state.projectId) return toast("请先选择项目", "warn");
  try {
    const engine = storyVideoWfId();
    persistStorySelection();
    await api.runStoryboard(state.projectId, {
      continue_on_error: true,
      video_workflow: engine,
      style_id: state.storyStyleId || undefined,
      character_ids: state.storyCharacterIds,
      with_voice: effectiveStoryVoice(),
      burn_subtitles: state.storyBurnSubs !== false,
      tts_provider: state.ttsProvider,
      tts_voice: state.ttsVoice,
      tts_rate: Number(state.ttsRate) || 0,
      keep_original_audio: state.dubKeepOriginal !== false,
      original_volume_db: Number(state.dubOriginalDb ?? -14),
    });
    const eng = storyVideoEngines().find((w) => w.id === engine);
    const via = eng ? `${eng.id} ${eng.label}${eng.hasAudio ? "（自带声音）" : ""}` : engine;
    toast(`已开始批量生成：逐镜头「首帧图 → 视频」，引擎 ${via}`
      + (effectiveStoryVoice() ? "，并按台词加 TTS 配音" : "")
      + (state.storyBurnSubs !== false ? "、烧台词字幕" : "") + "；可在任务中心查看进度", "ok", 9000);
    ctx.go("/jobs");
  } catch (e) { toast(e.message, "err", 9000); }
}

/**
 * 打开「拼接成片」弹窗（故事创作）。
 * 默认按分镜顺序、每个镜头取最新出的那条视频；顺序能自己调，也能临时补上传的片段。
 */
async function assembleFinal(ctx) {
  if (!state.projectId) return toast("请先选择项目", "warn");
  let initial = [];
  try {
    const vids = await api.assets({ kind: "video", project_id: state.projectId, limit: 200 });
    const newest = new Map();                 // 列表按时间倒序，每个镜头第一条就是最新的
    for (const a of vids) if (a.shot_id && !newest.has(a.shot_id)) newest.set(a.shot_id, a);
    const shots = [...(state.shots || [])].sort((x, y) => (x.idx || 0) - (y.idx || 0));
    for (const s of shots) { const a = newest.get(s.id); if (a) initial.push(a); }
    // 还没跑过分镜：退回项目里最近的几条（跳过上一版成片，免得越拼越长）
    if (!initial.length) initial = vids.filter((a) => !["WF-16", "WF-27"].includes(a.meta?.workflow_id)).slice(0, 12);
  } catch (e) { toast("读取项目视频失败：" + e.message, "err", 7000); }
  concatModal(ctx, { initial, projectId: state.projectId });
}

/**
 * 「拼接成片」弹窗：自己挑片段 + 自己排顺序。
 *
 * 顺序就是成片顺序：↑↓ 调序、✕ 移除；片段能从素材库挑、也能直接上传本地视频。
 * 「烧字幕」默认打开——拼接完成后会用每个镜头分镜表里的「台词」在本机烧成硬字幕
 * （不动画面尺寸、不占显卡，旁边还会存一份 .srt 可导入剪映）。
 */
function concatModal(ctx, { initial = [], projectId = null } = {}) {
  const items = (initial || []).filter((a) => a && a.kind === "video");
  let library = [];
  const listBox = h("div");
  const poolSel = h("select", { style: { minWidth: "300px" } });
  const file = h("input", { type: "file", accept: "video/*", multiple: true });
  const subChk = h("input", { type: "checkbox", checked: true });
  const lvlChk = h("input", { type: "checkbox", checked: true });
  const bgmSel = h("select", { style: { minWidth: "220px" } });
  const totalLine = h("div", { class: "tiny muted" });

  const lineOf = (a) => String(a.dialogue || "").trim()
    || String((a.shot_id && (state.shots || []).find((s) => s.id === a.shot_id) || {}).dialogue || "").trim();
  const totalMs = () => items.reduce((s, a) => s + (a.duration_ms || 0), 0);

  function paint() {
    clear(listBox);
    if (!items.length) listBox.append(emptyNode("还没有选择片段：从下面「素材库」挑，或直接上传本地视频"));
    items.forEach((a, i) => {
      const shot = a.shot_id ? (state.shots || []).find((s) => s.id === a.shot_id) : null;
      const line = lineOf(a);
      listBox.append(h("div", { class: "row wrap", style: { gap: "10px", alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--line, #2a2a35)" } },
        h("div", { style: { minWidth: "26px", textAlign: "center", fontWeight: "700" } }, String(i + 1)),
        h("video", { src: a.url, muted: true, preload: "metadata", style: { width: "96px", height: "54px", objectFit: "cover", borderRadius: "6px", background: "#000", flex: "none" } }),
        h("div", { style: { flex: "1", minWidth: "200px" } },
          h("div", { class: "tiny" }, baseName(a.path)),
          h("div", { class: "tiny muted" }, `${a.width || "?"}x${a.height || "?"} · ${fmtDur(a.duration_ms)}${a.has_audio ? " · 有声音" : ""}${shot ? ` · 镜头 ${shot.idx}` : ""}`),
          line ? h("div", { class: "tiny", style: { color: "#7cc7ff" } }, `台词：${line}`) : null),
        h("div", { class: "row", style: { gap: "4px" } },
          h("button", { class: "sm ghost", disabled: i === 0, title: "上移", onClick: () => { const t = items[i - 1]; items[i - 1] = items[i]; items[i] = t; paint(); } }, "↑"),
          h("button", { class: "sm ghost", disabled: i === items.length - 1, title: "下移", onClick: () => { const t = items[i + 1]; items[i + 1] = items[i]; items[i] = t; paint(); } }, "↓"),
          h("button", { class: "sm danger", title: "移除", onClick: () => { items.splice(i, 1); paint(); } }, "✕"))));
    });
    const nLine = items.filter((a) => lineOf(a)).length;
    totalLine.textContent = `共 ${items.length} 段 · 合计 ${fmtDur(totalMs())}`
      + (nLine ? `　·　其中 ${nLine} 段有台词，烧字幕时会按顺序落在画面上` : "");
    clear(poolSel);
    poolSel.append(h("option", { value: "" }, library.length ? "从素材库添加片段…" : "素材库加载中…"));
    for (const a of library) {
      if (items.some((x) => x.id === a.id)) continue;
      poolSel.append(h("option", { value: a.id }, `${baseName(a.path)} · ${fmtDur(a.duration_ms)} · ${ago(a.created_at)}`));
    }
  }

  poolSel.onchange = () => {
    const a = library.find((x) => x.id === poolSel.value);
    if (a && !items.some((x) => x.id === a.id)) { items.push(a); poolSel.value = ""; paint(); }
  };
  // 素材库 / BGM 清单异步补齐（不挡弹窗先出来）
  api.assets({ kind: "video", limit: 200 }).then((list) => { library = list || []; paint(); }).catch(() => paint());
  api.assets({ kind: "audio", limit: 200 }).then((list) => {
    clear(bgmSel);
    bgmSel.append(h("option", { value: "" }, "不加 BGM"));
    for (const a of list || []) bgmSel.append(h("option", { value: a.id }, `${baseName(a.path)} · ${fmtDur(a.duration_ms)}`));
  }).catch(() => {});

  const body = h("div", null,
    h("div", { class: "tiny muted", style: { marginBottom: "8px" } },
      "片段按下面的顺序首尾相接，成片是 1080P 无水印 MP4，可直接拖进剪映。"),
    h("div", { style: { maxHeight: "320px", overflow: "auto" } }, listBox),
    h("div", { style: { marginTop: "6px" } }, totalLine),
    h("div", { class: "field", style: { marginTop: "14px" } }, h("label", null, "① 添加片段"),
      h("div", { class: "row wrap", style: { gap: "8px", alignItems: "center" } }, poolSel,
        file,
        h("button", { class: "sm", onClick: async () => {
          if (!file.files?.length) return toast("请先选择要上传的视频文件", "warn");
          for (const f of [...file.files]) {
            try { items.push(await api.upload(f, { projectId: projectId || state.projectId || "" })); }
            catch (e) { toast(`上传失败：${e.message}`, "err"); }
          }
          file.value = ""; paint();
        } }, "＋ 上传并添加"))),
    h("div", { class: "field" }, h("label", null, "② 附加音轨（可选，盖在整条成片上）"), bgmSel),
    h("div", { class: "field" }, h("label", null, "③ 字幕"),
      h("label", { class: "tiny", style: { display: "inline-flex", gap: "6px", alignItems: "center", cursor: "pointer" } },
        subChk, "拼接后自动烧字幕（取各镜头分镜表的「台词」，另存 .srt 可导入剪映）")),
    h("div", { class: "field" }, h("label", null, "④ 混音"),
      h("label", { class: "tiny", style: { display: "inline-flex", gap: "6px", alignItems: "center", cursor: "pointer" } },
        lvlChk, "统一原声音量（推荐）：把「没台词的片段」原声压到与配音镜头同一档，避免成片里音量忽大忽小")));

  modal("拼接成片 · 选择片段与顺序", body, [
    { label: "取消", onClick: (c) => c() },
    { label: "开始拼接", primary: true, onClick: async (c) => {
      if (!items.length) return toast("请先添加至少一个视频片段", "warn");
      try {
        const r = await api.exportFinal({
          project_id: projectId || state.projectId || null,
          asset_ids: items.map((a) => a.id),
          audio_asset_ids: bgmSel.value ? [bgmSel.value] : [],
          subtitles: !!subChk.checked,
          level_audio: !!lvlChk.checked,
        });
        toast(`已提交拼接任务（${r.segments} 段${r.subtitles ? "，拼完自动烧字幕" : ""}）`, "ok", 7000);
        c(); ctx.go("/jobs");
      } catch (e) { toast(e.message, "err", 7000); }
    } },
  ]);
}

// ============================================================ 配音
/**
 * 语音服务 / 音色清单（配音页与故事创作共用）。
 * 默认是内置的 edge 通道：跑在本机 Python 上，免费、不需要 Key、不出网。
 */
async function loadTts(ctx) {
  if (state.ttsLoading) return;
  state.ttsLoading = true;
  try {
    state.tts = await api.ttsProviders();
    const provs = state.tts.providers || [];
    if (!state.ttsProvider || !provs.some((p) => p.id === state.ttsProvider)) {
      state.ttsProvider = state.tts.default || (provs[0] || {}).id || null;
    }
    const list = (state.tts.voices || {})[state.ttsProvider] || [];
    if (!state.ttsVoice || !list.some((v) => v.id === state.ttsVoice)) {
      state.ttsVoice = list.some((v) => v.id === state.tts.default_voice)
        ? state.tts.default_voice : (list[0] || {}).id || null;
    }
    if (ctx && ctx.reload) ctx.reload();
  } catch (e) {
    state.tts = { providers: [], voices: {}, error: e.message };
  } finally { state.ttsLoading = false; }
}

/** 音色下拉：有内置清单就用下拉，没有（自定义服务）就手填音色名 */
function voiceNode(ctx) {
  const list = ((state.tts && state.tts.voices) || {})[state.ttsProvider] || [];
  const prov = ((state.tts && state.tts.providers) || []).find((p) => p.id === state.ttsProvider);
  if (!list.length) {
    if (!state.ttsVoice) state.ttsVoice = (prov && prov.voice) || "";
    const inp = h("input", { value: state.ttsVoice || "", placeholder: "音色名（该服务需手动填写）", style: { minWidth: "200px" } });
    inp.oninput = () => { state.ttsVoice = inp.value.trim(); };
    return inp;
  }
  if (!state.ttsVoice || !list.some((v) => v.id === state.ttsVoice)) {
    state.ttsVoice = (prov && prov.voice && list.some((v) => v.id === prov.voice)) ? prov.voice : list[0].id;
  }
  const sel = h("select", { style: { minWidth: "240px" } });
  for (const v of list) {
    sel.append(h("option", { value: v.id, selected: v.id === state.ttsVoice },
      v.label && v.label !== v.id ? `${v.label}（${v.id}）` : v.id));
  }
  sel.onchange = () => { state.ttsVoice = sel.value; };
  return sel;
}

/** 配音引擎 + 音色 + 语音服务配置入口 */
function ttsControls(ctx, label = "配音引擎") {
  const info = state.tts;
  const provs = (info && info.providers) || [];
  const cap = (t) => h("span", { class: "tiny muted", style: { whiteSpace: "nowrap" } }, t);
  const provSel = h("select", { style: { minWidth: "230px" } });
  if (!info) provSel.append(h("option", null, "语音服务加载中…"));
  else if (!provs.length) provSel.append(h("option", null, "没有可用的语音服务"));
  else for (const p of provs) {
    provSel.append(h("option", { value: p.id, selected: p.id === state.ttsProvider, disabled: p.enabled === false },
      p.enabled === false ? `⛔ ${p.label}` : p.label));
  }
  const vBox = h("span");
  const paint = () => { clear(vBox); vBox.append(voiceNode(ctx)); };
  provSel.onchange = () => { state.ttsProvider = provSel.value; state.ttsVoice = null; paint(); };
  paint();
  return h("div", { class: "row wrap", style: { gap: "8px", alignItems: "center" } },
    cap(label), provSel, cap("音色"), vBox,
    h("button", { class: "sm ghost", onClick: () => openTtsProviders(ctx) }, "⚙️ 语音服务"));
}

/** 语音服务配置面板：内置 edge 通道 + 任意 OpenAI 兼容 /audio/speech 服务 */
function openTtsProviders(ctx) {
  const root = h("div");
  let editing = null;
  modal("语音服务（配音引擎）", root, [
    { label: "完成", primary: true, onClick: (c) => { c(); loadTts(ctx).catch(() => {}); } },
  ]);
  const fld = (label, node) => h("div", { class: "field" }, h("label", null, label), node);

  async function render() {
    clear(root);
    let data;
    try { data = await api.ttsProviders(); }
    catch (e) { root.append(h("div", { class: "pill err" }, `读取语音服务失败：${e.message}`)); return; }
    state.tts = data;

    root.append(h("div", { class: "tiny muted", style: { marginBottom: "10px" } },
      "配音引擎跑在服务器上，文字只在本机合成，不会外发（除非你自己选了外部服务）。",
      h("br"),
      data.edge && data.edge.available
        ? h("span", { class: "pill ok" }, "本机语音引擎可用")
        : h("span", { class: "pill err" }, "本机语音引擎不可用"),
      " ",
      data.edge && data.edge.python ? `edge-tts @ ${data.edge.python}` : String((data.edge && data.edge.error) || "")));

    const list = h("div", { style: { marginBottom: "14px" } });
    for (const p of data.providers || []) {
      const t = p.last_test;
      const pill = t ? (t.ok ? h("span", { class: "pill ok" }, "已连通") : h("span", { class: "pill err" }, "测试失败"))
        : h("span", { class: "pill" }, "未测试");
      const testBtn = h("button", { class: "sm", onClick: async () => {
        testBtn.disabled = true; testBtn.textContent = "测试中…";
        try {
          const r = await api.testTtsProvider({ id: p.id });
          toast(r.ok ? `「${p.label}」${r.message || "可用"}` : `「${p.label}」测试失败：${r.error}`, r.ok ? "ok" : "err", 9000);
        } catch (err) { toast(err.message, "err", 9000); }
        render();
      } }, "测试");
      list.append(h("div", { class: "row wrap", style: { justifyContent: "space-between", gap: "8px", padding: "7px 0", borderBottom: "1px solid var(--line, #2a2a35)" } },
        h("div", { style: { minWidth: "240px" } },
          h("b", null, p.label), " ", pill, p.builtin ? h("span", { class: "pill" }, "内置") : null,
          h("div", { class: "tiny muted" }, `${p.kind === "edge" ? "本机合成" : (p.model || "（未填模型）")}　${p.has_key ? p.api_key_masked : (p.kind === "edge" ? "无需 Key" : "未配置 Key")}　${p.base_url || ""}`),
          t && !t.ok ? h("div", { class: "tiny", style: { color: "#ff8b8b" } }, t.error) : null),
        h("div", { class: "row", style: { gap: "6px" } },
          testBtn,
          p.builtin ? null : h("button", { class: "sm", onClick: () => { editing = p; render(); } }, "编辑"),
          p.builtin ? null : h("button", { class: "sm ghost", onClick: async () => {
            try { await api.deleteTtsProvider(p.id); if (editing && editing.id === p.id) editing = null; toast("已删除", "ok"); render(); }
            catch (err) { toast(err.message, "err"); }
          } }, "删除"))));
    }
    root.append(list);

    const presetSel = h("select");
    for (const item of data.presets || []) {
      presetSel.append(h("option", { value: item.id, selected: (editing ? editing.preset : "siliconflow") === item.id }, item.label));
    }
    const labelIn = h("input", { value: editing ? editing.label : "", placeholder: "例如：硅基流动正式账号" });
    const baseIn = h("input", { value: editing ? editing.base_url : "", placeholder: "https://api.siliconflow.cn/v1" });
    const keyIn = h("input", { type: "password", placeholder: editing && editing.has_key ? `已保存 ${editing.api_key_masked}，留空表示不修改` : "sk-…（只保存在本机服务器）" });
    const modelIn = h("input", { value: editing ? editing.model : "", placeholder: "例如：FunAudioLLM/CosyVoice2-0.5B" });
    const voiceIn = h("input", { value: editing ? editing.voice : "", placeholder: "默认音色，例如：alex / longxiaochun" });
    const presetHint = h("div", { class: "tiny muted" }, "");
    const kindOf = () => (data.presets || []).find((x) => x.id === presetSel.value) || { kind: "openai" };
    const syncKind = () => {
      const p = kindOf();
      presetHint.textContent = p.note || "";
      const isEdge = p.kind === "edge";
      for (const n of [baseIn, keyIn, modelIn, voiceIn]) n.disabled = isEdge;
      if (!editing && !isEdge) { labelIn.value = p.id === "custom" ? "" : p.label; baseIn.value = p.baseUrl || ""; modelIn.value = p.model || ""; }
      if (!editing && isEdge) { labelIn.value = p.label; }
    };
    presetSel.onchange = () => syncKind();
    syncKind();

    const testOut = h("div", { class: "tiny", style: { marginTop: "6px", whiteSpace: "pre-wrap" } });
    const testBtn = h("button", { class: "sm", onClick: async () => {
      testBtn.disabled = true; testBtn.textContent = "测试中…";
      clear(testOut); testOut.append("正在试合成一句「你好，这是一条配音测试。」…");
      try {
        const r = await api.testTtsProvider({
          ...(editing ? { id: editing.id } : {}),
          label: labelIn.value, kind: kindOf().kind, base_url: baseIn.value,
          api_key: keyIn.value || undefined, model: modelIn.value, voice: voiceIn.value,
        });
        clear(testOut);
        testOut.append(r.ok ? h("span", { class: "pill ok" }, "可用") : h("span", { class: "pill err" }, "失败"), " ", String(r.message || r.error || ""));
      } catch (e) { clear(testOut); testOut.append(h("span", { class: "pill err" }, e.message)); }
      testBtn.disabled = false; testBtn.textContent = "测试";
    } }, "测试");

    const saveBtn = h("button", { class: "primary", onClick: async () => {
      const body = {
        label: labelIn.value, preset: presetSel.value, kind: kindOf().kind,
        base_url: baseIn.value, model: modelIn.value, voice: voiceIn.value,
        ...(keyIn.value ? { api_key: keyIn.value } : {}),
      };
      saveBtn.disabled = true;
      try {
        if (editing) await api.updateTtsProvider(editing.id, body);
        else await api.createTtsProvider(body);
        toast(editing ? "已保存修改" : "已添加语音服务", "ok");
        editing = null; render();
      } catch (e) { toast(e.message, "err", 9000); }
      saveBtn.disabled = false;
    } }, editing ? "保存修改" : "添加");

    root.append(h("div", { style: { borderTop: "1px solid var(--line, #2a2a35)", paddingTop: "12px" } },
      h("h4", { style: { margin: "0 0 8px" } }, editing ? `编辑：${editing.label}` : "新增语音服务"),
      fld("类型", h("div", null, presetSel, presetHint)),
      fld("名称", labelIn),
      fld("接口地址（Base URL）", baseIn),
      fld("API Key", keyIn),
      fld("模型名", modelIn),
      fld("默认音色", voiceIn),
      h("div", { class: "row wrap", style: { gap: "8px" } },
        testBtn, saveBtn,
        editing ? h("button", { class: "sm ghost", onClick: () => { editing = null; render(); } }, "取消编辑") : null),
      testOut));
  }
  render();
}

async function loadDubVideos(ctx) {
  if (state.dubVideos) return;
  try { state.dubVideos = await api.assets({ kind: "video", limit: 200 }); ctx.reload(); }
  catch { state.dubVideos = []; }
}

/** 「视频 + 音频合成」那块要用的音频清单（和视频一样懒加载一次） */
async function loadMuxAudio(ctx) {
  if (state.muxAudioLib) return;
  try { state.muxAudioLib = await api.assets({ kind: "audio", limit: 200 }); ctx.reload(); }
  catch { state.muxAudioLib = []; }
}

/** 「歌词 → 字幕」那块要用的清单：音频和视频都要（歌词可能配歌，也可能配片子） */
async function loadLrcMedia(ctx) {
  if (state.lrcMediaLib) return;
  try {
    const [v, a] = await Promise.all([
      api.assets({ kind: "video", limit: 200 }).catch(() => []),
      api.assets({ kind: "audio", limit: 200 }).catch(() => []),
    ]);
    state.lrcMediaLib = [...(v || []), ...(a || [])];
    ctx.reload();
  } catch { state.lrcMediaLib = []; }
}

/** 配音页：视频（上传 / 素材库）+ 自己写的文字 → 本地语音 → 带配音的视频 */
function dub(ctx) {
  if (state.tts === null) loadTts(ctx);
  if (state.dubVideos === undefined || state.dubVideos === null) loadDubVideos(ctx);
  if (state.muxAudioLib === undefined || state.muxAudioLib === null) loadMuxAudio(ctx);
  if (state.lrcMediaLib === undefined || state.lrcMediaLib === null) loadLrcMedia(ctx);
  const box = h("div");
  const v = state.dubVideo;

  const file = h("input", { type: "file", accept: "video/*" });
  file.onchange = async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    try {
      // 归属项目跟着「当前选中的视频」走，而不是全局 state.projectId ——
      // 配音页没有项目选择器，用全局值会把别的页面残留的项目带进来，
      // 产物就会落到错误的项目目录、顶着一个不相干的项目名（产物命名见 src/naming.js）。
      const a = await api.upload(f, { projectId: (v && v.project_id) || "" });
      state.dubVideo = a; state.dubVideos = null;
      toast("视频已上传", "ok"); ctx.reload();
    } catch (e) { toast(e.message, "err", 9000); }
  };

  const assetSel = h("select", { style: { minWidth: "320px" } }, h("option", { value: "" }, "从素材库选择视频…"));
  for (const a of state.dubVideos || []) {
    assetSel.append(h("option", { value: a.id, selected: !!v && a.id === v.id },
      `${baseName(a.path)} · ${a.duration_ms ? fmtDur(a.duration_ms) : "时长未知"} · ${ago(a.created_at)}`));
  }
  if (!(state.dubVideos || []).length) assetSel.append(h("option", { value: "" }, "（素材库里还没有视频）"));
  assetSel.onchange = () => {
    const a = (state.dubVideos || []).find((x) => x.id === assetSel.value) || null;
    if (!a) return;
    state.dubVideo = a; ctx.reload();
  };

  const preview = h("div", { style: { marginTop: "10px" } });
  if (v) {
    preview.append(
      h("video", { src: v.url, controls: true, style: { maxHeight: "260px", borderRadius: "8px", background: "#000" } }),
      h("div", { class: "tiny muted", style: { marginTop: "4px" } },
        `${v.path.split("/").pop()}　${fmtSize(v.size_bytes)}　${v.duration_ms ? fmtDur(v.duration_ms) : "时长未知"}`,
        "　", h("button", { class: "sm ghost", onClick: () => { state.dubVideo = null; ctx.reload(); } }, "换一个")));
  } else {
    preview.append(h("div", { class: "tiny muted" }, "还没有选视频：上传一个，或从素材库里挑一个。"));
  }

  const ta = h("textarea", { rows: 5, placeholder: "把要念的台词写这里，例如：大家好，今天带你看一个能自己拍短剧的本地 AI 工作台。" });
  ta.value = state.dubText || "";
  const cnt = h("span", { class: "tiny muted" });
  const paintCnt = () => { cnt.textContent = `${ta.value.length} 字`; };
  ta.oninput = () => { state.dubText = ta.value; paintCnt(); };
  paintCnt();

  const rate = h("input", { type: "range", min: -50, max: 50, step: 5, value: state.ttsRate || 0, style: { width: "140px" } });
  const rateHint = h("span", { class: "tiny muted" }, `${state.ttsRate || 0}%`);
  rate.oninput = () => { state.ttsRate = Number(rate.value); rateHint.textContent = `${rate.value}%`; };

  const keep = h("input", { type: "checkbox", checked: state.dubKeepOriginal !== false });
  const origVol = h("input", { type: "range", min: -40, max: 0, step: 2, value: state.dubOriginalDb ?? -14, style: { width: "120px" } });
  const origHint = h("span", { class: "tiny muted" }, `${state.dubOriginalDb ?? -14} dB`);
  origVol.oninput = () => { state.dubOriginalDb = Number(origVol.value); origHint.textContent = `${origVol.value} dB`; };
  keep.onchange = () => { state.dubKeepOriginal = keep.checked; origVol.disabled = !keep.checked; };

  const payload = () => ({
    video_asset_id: v && v.id, text: ta.value,
    tts_provider: state.ttsProvider, voice: state.ttsVoice,
    rate: Number(state.ttsRate) || 0,
    speed: Math.min(4, Math.max(0.25, 1 + (Number(state.ttsRate) || 0) / 100)),
    project_id: (v && v.project_id) || null,
    keep_original: keep.checked, original_volume_db: Number(state.dubOriginalDb ?? -14),
    voice_volume_db: 0,
  });

  const audition = h("button", { class: "sm", onClick: async () => {
    if (!ta.value.trim()) return toast("请先输入要配音的文字", "warn");
    audition.disabled = true; audition.textContent = "合成中…";
    try {
      const url = await api.previewTts({ ...payload(), video_asset_id: undefined });
      new Audio(url).play();
      toast("试听中…", "ok");
    } catch (e) { toast(e.message, "err", 9000); }
    audition.disabled = false; audition.textContent = "试听";
  } }, "试听");

  const onlyAudio = h("button", { class: "sm", onClick: async () => {
    if (!ta.value.trim()) return toast("请先输入要配音的文字", "warn");
    onlyAudio.disabled = true; onlyAudio.textContent = "合成中…";
    try {
      const r = await api.synthesizeTts({ ...payload(), video_asset_id: undefined });
      toast(`配音已存入素材库（${r.chars} 字，音色 ${r.voice}）`, "ok", 8000);
      state.dubVideos = null;
    } catch (e) { toast(e.message, "err", 9000); }
    onlyAudio.disabled = false; onlyAudio.textContent = "只生成配音";
  } }, "只生成配音");

  const runBtn = h("button", { class: "primary", onClick: async () => {
    if (!v) return toast("请先选择要配音的视频", "warn");
    if (!ta.value.trim()) return toast("请先输入要配音的文字", "warn");
    runBtn.disabled = true; runBtn.textContent = "配音合成中…";
    try {
      const r = await api.dub(payload());
      state.dubResult = r;
      state.dubVideos = null;          // 置空让素材库重新拉一次，新成片会出现在里面
      toast(`配音完成（${r.chars} 字，音色 ${r.voice}）· ${r.keep_original ? "原声压低当背景" : "已替换原音轨"}`, "ok", 8000);
      ctx.reload();
    } catch (e) { toast(e.message, "err", 9000); }
  } }, "开始配音");

  box.append(h("div", { class: "card" },
    h("h3", null, "视频配音（自己写台词）"),
    h("div", { class: "tiny muted" }, "上传一段视频或从素材库挑一段，写下要念的文字，AI 就用你选的音色念出来并合到画面上。合成在这台机器上用 ffmpeg 完成（视频画面原样复制、只换音轨），通常几秒出片，视频多长都能合；成品无水印、画质和源素材一致，可直接拖进剪映。"),
    h("div", { class: "field" }, h("label", null, "① 选择视频"), h("div", { class: "row wrap", style: { gap: "10px", alignItems: "center" } }, file, assetSel)),
    preview));

  // ------------------------------------------------ 第二块：视频 + 音频合成（音频本地上传）
  // 和上面那块唯一的区别：音频不是现场合成的，而是用户自己上传的文件（也可以从素材库挑）。
  const mixVideoFile = h("input", { type: "file", accept: "video/*" });
  mixVideoFile.onchange = async () => {
    const f = mixVideoFile.files && mixVideoFile.files[0];
    if (!f) return;
    try {
      const a = await api.upload(f, { projectId: (state.muxVideo && state.muxVideo.project_id) || "" });
      state.muxVideo = a; state.dubVideos = null; state.muxResult = null;
      toast("视频已上传", "ok"); ctx.reload();
    } catch (e) { toast(e.message, "err", 9000); }
  };

  const mixVideoSel = h("select", { style: { minWidth: "300px" } }, h("option", { value: "" }, "从素材库选择视频…"));
  for (const a of state.dubVideos || []) {
    mixVideoSel.append(h("option", { value: a.id, selected: !!state.muxVideo && a.id === state.muxVideo.id },
      `${baseName(a.path)} · ${a.duration_ms ? fmtDur(a.duration_ms) : "时长未知"}`));
  }
  if (!(state.dubVideos || []).length) mixVideoSel.append(h("option", { value: "" }, "（素材库里还没有视频）"));
  mixVideoSel.onchange = () => {
    const a = (state.dubVideos || []).find((x) => x.id === mixVideoSel.value) || null;
    if (!a) return;
    state.muxVideo = a; state.muxResult = null; ctx.reload();
  };

  const mixFile = h("input", { type: "file", accept: "audio/*" });
  mixFile.onchange = async () => {
    const f = mixFile.files && mixFile.files[0];
    if (!f) return;
    try {
      const a = await api.upload(f, { projectId: (state.muxVideo && state.muxVideo.project_id) || "" });
      state.muxAudio = a; state.muxAudioLib = null; state.muxResult = null;
      toast(`音频已上传：${baseName(a.path)}　${fmtSize(a.size_bytes)}`, "ok");
      ctx.reload();
    } catch (e) { toast(e.message, "err", 9000); }
  };

  const mixSel = h("select", { style: { minWidth: "300px" } }, h("option", { value: "" }, "从素材库选择音频…"));
  for (const a of state.muxAudioLib || []) {
    mixSel.append(h("option", { value: a.id, selected: !!state.muxAudio && a.id === state.muxAudio.id },
      `${baseName(a.path)} · ${a.duration_ms ? fmtDur(a.duration_ms) : "时长未知"} · ${fmtSize(a.size_bytes)}`));
  }
  if (!(state.muxAudioLib || []).length) mixSel.append(h("option", { value: "" }, "（素材库里还没有音频）"));
  mixSel.onchange = () => {
    const a = (state.muxAudioLib || []).find((x) => x.id === mixSel.value) || null;
    if (!a) return;
    state.muxAudio = a; state.muxResult = null; ctx.reload();
  };

  const mixKeep = h("input", { type: "checkbox", checked: state.muxKeepOriginal === true });
  const mixOrig = h("input", { type: "range", min: -40, max: 0, step: 2, value: state.muxOriginalDb ?? -14, style: { width: "120px" }, disabled: state.muxKeepOriginal !== true });
  const mixOrigHint = h("span", { class: "tiny muted" }, `${state.muxOriginalDb ?? -14} dB`);
  mixOrig.oninput = () => { state.muxOriginalDb = Number(mixOrig.value); mixOrigHint.textContent = `${mixOrig.value} dB`; };
  mixKeep.onchange = () => { state.muxKeepOriginal = mixKeep.checked; mixOrig.disabled = !mixKeep.checked; };

  const mixPick = h("div", { class: "tiny muted", style: { marginTop: "8px" } },
    state.muxVideo
      ? h("div", null, `视频：${baseName(state.muxVideo.path)}　${fmtSize(state.muxVideo.size_bytes)}　${state.muxVideo.duration_ms ? fmtDur(state.muxVideo.duration_ms) : "时长未知"}`, "　",
        h("button", { class: "sm ghost", onClick: () => { state.muxVideo = null; state.muxResult = null; ctx.reload(); } }, "换一个"))
      : h("div", null, "还没选视频"),
    state.muxAudio
      ? h("div", { style: { marginTop: "4px" } }, `音频：${baseName(state.muxAudio.path)}　${fmtSize(state.muxAudio.size_bytes)}`, "　",
        h("button", { class: "sm ghost", onClick: () => { state.muxAudio = null; state.muxResult = null; ctx.reload(); } }, "换一个"))
      : h("div", { style: { marginTop: "4px" } }, "还没选音频 —— 请上传一个音频文件"));

  const mixBtn = h("button", { class: "primary", onClick: async () => {
    if (!state.muxVideo) return toast("请先选择要合成的视频", "warn");
    if (!state.muxAudio) return toast("请先上传要合成的音频文件", "warn");
    mixBtn.disabled = true; mixBtn.textContent = "合成中…";
    try {
      const r = await api.mux({
        video_asset_id: state.muxVideo.id, audio_asset_id: state.muxAudio.id,
        // 同上传：归属项目以源视频为准，避免把别的页面残留的项目带进来
        project_id: state.muxVideo.project_id || state.muxAudio.project_id || null,
        keep_original: mixKeep.checked,
        original_volume_db: Number(state.muxOriginalDb ?? -14),
      });
      state.muxResult = r;
      state.dubVideos = null; state.muxAudioLib = null;   // 置空让素材库重拉，新成片会出现在里面
      toast("合成完成，已存进素材库", "ok", 8000);
      ctx.reload();
    } catch (e) { toast(e.message, "err", 9000); }
    mixBtn.disabled = false; mixBtn.textContent = "开始合成";
  } }, "开始合成");

  box.append(h("div", { class: "card", style: { marginTop: "16px" } },
    h("h3", null, "视频 + 音频合成（音频自己上传）"),
    h("div", { class: "tiny muted" }, "手上已经有现成的音频时用这一块：配乐、旁白录音、从别处导出的音轨都行。视频从素材库挑或直接上传，音频由你本地上传，把两轨合成一条片子。同样在这台机器上用 ffmpeg 完成（视频画面原样复制、只重编码音轨），不占 222 的显存，视频多长都能合；成品无水印、画质和源素材一致，可直接拖进剪映。"),
    h("div", { class: "field" }, h("label", null, "① 视频（素材库选择，或本地上传）"),
      h("div", { class: "row wrap", style: { gap: "10px", alignItems: "center" } }, mixVideoFile, mixVideoSel)),
    h("div", { class: "field" }, h("label", null, "② 音频（本地上传，或从素材库选择）"),
      h("div", { class: "row wrap", style: { gap: "10px", alignItems: "center" } }, mixFile, mixSel)),
    mixPick,
    h("div", { class: "field" }, h("label", null, "③ 视频原声怎么处理"),
      h("div", { class: "row wrap", style: { gap: "10px", alignItems: "center" } },
        h("label", { class: "tiny", style: { display: "inline-flex", gap: "4px", alignItems: "center", cursor: "pointer" } }, mixKeep, "保留视频原声（压低当背景）"),
        h("span", { class: "tiny muted" }, "原声音量"), mixOrig, mixOrigHint)),
    h("div", { class: "row wrap", style: { gap: "8px" } }, mixBtn)));

  if (state.muxResult && state.muxResult.video_url) {
    const mr = state.muxResult;
    box.append(h("div", { class: "card", style: { marginTop: "16px" } },
      h("h3", null, "合成结果"),
      h("video", { src: mr.video_url, controls: true, style: { maxHeight: "320px", borderRadius: "8px", background: "#000" } }),
      h("div", { class: "row wrap", style: { gap: "10px", alignItems: "center", marginTop: "8px" } },
        h("span", { class: "pill ok" }, "无水印 · 画质无损"),
        h("span", { class: "tiny muted" }, `音频 ${mr.audio_name || ""} · 任务 ${mr.job_id}`),
        h("a", { class: "sm", href: mr.video_url, download: "" }, "⬇ 下载成片"),
        h("button", { class: "sm ghost", onClick: () => { state.muxResult = null; ctx.reload(); } }, "收起")),
      h("div", { class: "tiny muted", style: { marginTop: "6px" } }, mr.note || "")));
  }

  // ------------------------------------------------ 第三块：歌词 → 字幕（歌词与音视频对齐）
  // 给一份歌词（粘贴，或上传 .txt / .lrc / .srt）+ 一段音频 / 视频 → 自动算出时间轴，
  // 导出 .lrc（播放器歌词）/ .srt（视频与剪映通用）/ .ass（烧录用）三份标准字幕；
  // 还能一键烧成硬字幕视频。对齐与烧录都在本机 ffmpeg 完成，不占 222 的显存。
  // 本机 Whisper 逐字对齐是否就绪（需求报告 附录 AF）：就绪时下面的「自动」会优先走它
  const lrcAsrPill = h("span", { class: "pill acc" }, "语音识别：检测中…");
  api.lyricsAsrStatus().then((st) => {
    if (st && st.available) {
      lrcAsrPill.textContent = `语音识别逐字对齐：可用（${st.model || "whisper"}）`;
      lrcAsrPill.className = "pill ok";
    } else {
      const why = st && Array.isArray(st.reasons) && st.reasons.length ? `：${st.reasons[0]}` : "";
      lrcAsrPill.textContent = `语音识别逐字对齐：不可用${why}`;
      lrcAsrPill.className = "pill warn";
    }
  }).catch(() => { lrcAsrPill.textContent = "语音识别：未检测"; lrcAsrPill.className = "pill acc"; });

  const lrcPick = h("div", { class: "tiny muted", style: { marginTop: "8px" } });
  const lrcMediaFile = h("input", { type: "file", accept: "video/*,audio/*" });
  lrcMediaFile.onchange = async () => {
    const f = lrcMediaFile.files && lrcMediaFile.files[0];
    if (!f) return;
    try {
      const a = await api.upload(f, { projectId: (state.lrcMedia && state.lrcMedia.project_id) || "" });
      state.lrcMedia = a; state.lrcMediaLib = null; state.lrcResult = null; state.lrcBurnResult = null;
      toast(`已上传：${baseName(a.path)}`, "ok"); ctx.reload();
    } catch (e) { toast(e.message, "err", 9000); }
  };

  const lrcMediaSel = h("select", { style: { minWidth: "320px" } }, h("option", { value: "" }, "从素材库选择音频 / 视频…"));
  for (const a of state.lrcMediaLib || []) {
    lrcMediaSel.append(h("option", { value: a.id, selected: !!state.lrcMedia && a.id === state.lrcMedia.id },
      `${a.kind === "audio" ? "🎵" : "🎬"} ${baseName(a.path)} · ${a.duration_ms ? fmtDur(a.duration_ms) : "时长未知"}`));
  }
  if (!(state.lrcMediaLib || []).length) lrcMediaSel.append(h("option", { value: "" }, "（素材库里还没有音频 / 视频）"));
  lrcMediaSel.onchange = () => {
    const a = (state.lrcMediaLib || []).find((x) => x.id === lrcMediaSel.value) || null;
    if (!a) return;
    state.lrcMedia = a; state.lrcResult = null; state.lrcBurnResult = null; ctx.reload();
  };
  lrcPick.append(state.lrcMedia
    ? h("div", null,
        `${state.lrcMedia.kind === "audio" ? "音频" : "视频"}：${baseName(state.lrcMedia.path)}　${fmtSize(state.lrcMedia.size_bytes)}　${state.lrcMedia.duration_ms ? fmtDur(state.lrcMedia.duration_ms) : "时长未知"}`, "　",
        h("button", { class: "sm ghost", onClick: () => { state.lrcMedia = null; state.lrcResult = null; state.lrcBurnResult = null; ctx.reload(); } }, "换一个"))
    : h("div", null, "还没选音视频"));

  const lrcLyricsFile = h("input", { type: "file", accept: ".txt,.lrc,.srt,text/plain" });
  lrcLyricsFile.onchange = async () => {
    const f = lrcLyricsFile.files && lrcLyricsFile.files[0];
    if (!f) return;
    try {
      const buf = await f.arrayBuffer();
      let txt = new TextDecoder("utf-8").decode(buf);
      // 中文歌词文件有不少是 GBK 编码的，用替换字符探一下再兜底
      if (txt.includes("\uFFFD")) {
        try { txt = new TextDecoder("gbk").decode(buf); } catch { /* 浏览器不支持 gbk 就保留 utf-8 的结果 */ }
      }
      state.lrcText = txt.replace(/^\uFEFF/, "");
      state.lrcResult = null; state.lrcBurnResult = null;
      toast(`已读入歌词：${f.name}`, "ok"); ctx.reload();
    } catch (e) { toast(`读取歌词失败：${e.message}`, "err", 9000); }
  };

  const lrcCount = h("span", { class: "tiny muted" }, "");
  const paintLrcCount = () => {
    const n = String(state.lrcText || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean).length;
    lrcCount.textContent = n ? `已输入 ${n} 行` : "还没有歌词";
  };
  const lrcArea = h("textarea", {
    rows: 9,
    placeholder: "把歌词粘贴到这里，一行一句就行。\n\n也支持带时间轴的写法（有自带时间轴就直接用你的）：\n[00:12.34]第一句歌词\n[00:16.80]第二句歌词",
    style: { width: "100%", fontFamily: "inherit" },
  });
  lrcArea.value = state.lrcText || "";
  lrcArea.oninput = () => { state.lrcText = lrcArea.value; paintLrcCount(); };
  paintLrcCount();

  const lrcModeSel = h("select", { style: { minWidth: "360px" } },
    ...[
      ["auto", "自动（推荐：有自带时间轴就用它；否则用本机语音识别逐字对齐；再不行按停顿估算）"],
      ["timed", "用歌词自带的时间轴（.lrc / .srt）"],
      ["speech", "按人声停顿估算（不用语音识别，最快）"],
      ["even", "按字数均分（兜底，任何素材都能用）"],
    ].map(([val, label]) => h("option", { value: val, selected: (state.lrcMode || "auto") === val }, label)));
  lrcModeSel.onchange = () => { state.lrcMode = lrcModeSel.value; };

  const lrcOffsetIn = h("input", { type: "number", value: String(state.lrcOffset ?? 0), step: 50, style: { width: "110px" } });
  lrcOffsetIn.oninput = () => { state.lrcOffset = Number(lrcOffsetIn.value) || 0; };
  const lrcGapIn = h("input", { type: "number", value: String(state.lrcGap ?? 120), min: 0, max: 3000, step: 20, style: { width: "110px" } });
  lrcGapIn.oninput = () => { state.lrcGap = Number(lrcGapIn.value) || 0; };

  const lrcAlign = async () => {
    if (!state.lrcMedia) { toast("请先选择要配字幕的音频或视频", "warn"); return; }
    if (!String(state.lrcText || "").trim()) { toast("请先粘贴歌词，或上传 .txt / .lrc / .srt 文件", "warn"); return; }
    lrcBtn.disabled = true; const old = lrcBtn.textContent; lrcBtn.textContent = "正在对齐…";
    try {
      state.lrcResult = await api.lyricsAlign({
        media_asset_id: state.lrcMedia.id,
        lyrics: state.lrcText,
        mode: state.lrcMode || "auto",
        offset_ms: Number(state.lrcOffset ?? 0),
        gap_ms: Number(state.lrcGap ?? 120),
        project_id: state.lrcMedia.project_id || null,
      });
      state.lrcBurnResult = null;
      toast(`已对齐 ${state.lrcResult.count} 行（${state.lrcResult.mode_label}）`, "ok", 8000);
      ctx.reload();
    } catch (e) { toast(e.message, "err", 9000); }
    lrcBtn.disabled = false; lrcBtn.textContent = old;
  };
  const lrcBtn = h("button", null, "① 生成字幕文件");
  lrcBtn.onclick = lrcAlign;

  const lrcBurnBtn = h("button", { class: "ghost" }, "② 烧成硬字幕视频");
  lrcBurnBtn.onclick = async () => {
    if (!state.lrcMedia) { toast("请先选择要配字幕的视频", "warn"); return; }
    if (state.lrcMedia.kind !== "video") { toast("字幕要烧进画面，请选一段视频；只有音频的话用「生成字幕文件」导出 .lrc / .srt", "warn", 9000); return; }
    if (!String(state.lrcText || "").trim()) { toast("请先粘贴歌词", "warn"); return; }
    lrcBurnBtn.disabled = true; const old = lrcBurnBtn.textContent; lrcBurnBtn.textContent = "正在烧字幕…（视频越长越慢）";
    try {
      state.lrcBurnResult = await api.lyricsBurn({
        media_asset_id: state.lrcMedia.id,
        lyrics: state.lrcText,
        mode: state.lrcMode || "auto",
        offset_ms: Number(state.lrcOffset ?? 0),
        gap_ms: Number(state.lrcGap ?? 120),
        project_id: state.lrcMedia.project_id || null,
      });
      state.lrcMediaLib = null;   // 置空让素材库重拉，新成片会出现在里面
      toast("已烧成硬字幕视频，存进素材库", "ok", 8000);
      ctx.reload();
    } catch (e) { toast(e.message, "err", 9000); }
    lrcBurnBtn.disabled = false; lrcBurnBtn.textContent = old;
  };

  box.append(h("div", { class: "card", style: { marginTop: "16px" } },
    h("h3", null, "歌词 → 字幕（和音视频自动对齐）"),
    h("div", { class: "tiny muted" },
      "手上有一份歌词、想让它跟着歌或片子出字幕时用这一块：歌词粘贴或上传，系统帮你算出每行的时间轴，" +
      "导出 .lrc（播放器歌词）/ .srt（视频播放器与剪映通用）/ .ass（烧录用）三份标准格式，也能直接烧成硬字幕视频。" +
      "没时间轴的歌词会先用本机 Whisper 把人声听一遍、逐字贴到真正唱出来的那一刻（间奏不会被算成演唱时间，" +
      "这正是上一版歌词整体错位的原因）；识别不可用时才退回「按停顿估算」。全程不改动你的歌词一个字。"),
    h("div", { class: "field" }, h("label", null, "① 音视频（素材库选择，或本地上传）"),
      h("div", { class: "row wrap", style: { gap: "10px", alignItems: "center" } }, lrcMediaFile, lrcMediaSel)),
    lrcPick,
    h("div", { class: "field" }, h("label", null, "② 歌词（粘贴，或上传 .txt / .lrc / .srt）"),
      h("div", { class: "row wrap", style: { gap: "10px", alignItems: "center" } }, lrcLyricsFile, lrcCount),
      lrcArea,
      h("div", { class: "tiny muted", style: { marginTop: "4px" } },
        "一行一句最省事；带 [00:12.34] 时间戳的 .lrc、或带 --> 时间码的 .srt 会被优先采用（自带时间轴最准）。")),
    h("div", { class: "field" }, h("label", null, "③ 对齐方式"),
      h("div", { class: "row wrap", style: { gap: "10px", alignItems: "center" } }, lrcModeSel, lrcAsrPill)),
    h("div", { class: "field" }, h("label", null, "微调（可选）"),
      h("div", { class: "row wrap", style: { gap: "12px", alignItems: "center" } },
        h("span", { class: "tiny muted" }, "整体平移(ms)"), lrcOffsetIn,
        h("span", { class: "tiny muted" }, "行间留白(ms)"), lrcGapIn,
        h("span", { class: "tiny muted" }, "字幕整体偏早 / 偏晚时调平移，字幕挨得太紧就调大留白"))),
    h("div", { class: "row wrap", style: { gap: "8px" } }, lrcBtn, lrcBurnBtn)));

  if (state.lrcResult) {
    const r = state.lrcResult;
    const f = r.files || {};
    box.append(h("div", { class: "card", style: { marginTop: "16px" } },
      h("h3", null, "字幕文件"),
      h("div", { class: "row wrap", style: { gap: "10px", alignItems: "center" } },
        h("span", { class: "pill ok" }, `${r.count} 行 · ${r.mode_label}`),
        h("span", { class: "tiny muted" }, `素材 ${(Number(r.duration_ms || 0) / 1000).toFixed(2)}s · 歌词来源 ${r.source === "plain" ? "纯文本" : String(r.source).toUpperCase()}`),
        f.lrc ? h("a", { class: "sm", href: f.lrc.url, download: f.lrc.name }, "⬇ .lrc 播放器歌词") : null,
        f.srt ? h("a", { class: "sm", href: f.srt.url, download: f.srt.name }, "⬇ .srt 剪映 / 播放器") : null,
        f.ass ? h("a", { class: "sm", href: f.ass.url, download: f.ass.name }, "⬇ .ass 高级字幕") : null,
        h("button", { class: "sm ghost", onClick: () => { state.lrcResult = null; ctx.reload(); } }, "收起")),
      h("div", { class: "tiny muted", style: { marginTop: "6px" } },
        r.speech_note || "",
        Number(r.offset_ms) ? `　整体平移 ${r.offset_ms} ms` : "",
        `　行间留白 ${r.gap_ms} ms`),
      h("div", { class: "tiny", style: { marginTop: "8px", maxHeight: "230px", overflow: "auto", fontFamily: "ui-monospace, Consolas, monospace", lineHeight: "1.7" } },
        ...(r.lines || []).slice(0, 60).map((l) => h("div", null, `${l.time}  ${String(l.text).replace(/\n/g, " ／ ")}`)))));
  }

  if (state.lrcBurnResult) {
    const r = state.lrcBurnResult;
    box.append(h("div", { class: "card", style: { marginTop: "16px" } },
      h("h3", null, "带歌词硬字幕的视频"),
      h("video", { src: r.video_url, controls: true, style: { maxHeight: "320px", borderRadius: "8px", background: "#000" } }),
      h("div", { class: "row wrap", style: { gap: "10px", alignItems: "center", marginTop: "8px" } },
        h("span", { class: "pill ok" }, "无水印 · 硬字幕已烧进画面"),
        r.subtitle_lines ? h("span", { class: "tiny muted" }, `${r.subtitle_lines} 条字幕`) : null,
        r.srt_url ? h("a", { class: "sm", href: r.srt_url, download: "" }, "⬇ .srt") : null,
        r.lrc && r.lrc.url ? h("a", { class: "sm", href: r.lrc.url, download: r.lrc.name }, "⬇ .lrc") : null,
        h("button", { class: "sm ghost", onClick: () => { state.lrcBurnResult = null; ctx.reload(); } }, "收起")),
      h("div", { class: "tiny muted", style: { marginTop: "6px" } }, r.note || "")));
  }

  box.append(h("div", { class: "card", style: { marginTop: "16px" } },
    h("h3", null, "② 台词与音色"),

    h("div", { class: "field" }, h("label", null, "配音文字"), ta, h("div", { style: { marginTop: "4px" } }, cnt)),
    h("div", { class: "field" }, h("label", null, "配音引擎 / 音色"), ttsControls(ctx)),
    h("div", { class: "field" }, h("label", null, "语速"), h("div", { class: "row wrap", style: { gap: "8px", alignItems: "center" } }, rate, rateHint)),
    h("div", { class: "field" }, h("label", null, "原声处理"),
      h("div", { class: "row wrap", style: { gap: "10px", alignItems: "center" } },
        h("label", { class: "tiny", style: { display: "inline-flex", gap: "4px", alignItems: "center", cursor: "pointer" } }, keep, "保留视频原声（压低当背景）"),
        h("span", { class: "tiny muted" }, "原声音量"), origVol, origHint)),
    h("div", { class: "row wrap", style: { gap: "8px" } }, audition, onlyAudio, runBtn)));

  if (state.dubResult && state.dubResult.video_url) {
    const r = state.dubResult;
    box.append(h("div", { class: "card", style: { marginTop: "16px" } },
      h("h3", null, "③ 配音成片"),
      h("video", { src: r.video_url, controls: true, style: { maxHeight: "320px", borderRadius: "8px", background: "#000" } }),
      h("div", { class: "row wrap", style: { gap: "10px", alignItems: "center", marginTop: "8px" } },
        h("span", { class: "pill ok" }, "无水印 · 画质无损"),
        h("span", { class: "tiny muted" }, `音色 ${r.voice} · ${r.chars} 字 · 任务 ${r.job_id}`),
        h("a", { class: "sm", href: r.video_url, download: "" }, "⬇ 下载成片"),
        h("button", { class: "sm ghost", onClick: () => { state.dubResult = null; ctx.reload(); } }, "收起")),
      h("div", { class: "tiny muted", style: { marginTop: "6px" } }, r.note || "")));
  }

  return box;
}
// ============================================================ 爆款复刻
/**
 * 「爆款复刻」：把抖音 / 快手最热的视频玩法做成卡片，选中即按赛道预设一键出片。
 *
 * 数据在 public/js/trends.js；执行链路完全复用现有能力，没有额外后端接口：
 *   ① AI 拆分镜（本地 LLM / 外部商业模型）→ ② 逐镜头「首帧图 → 视频」批量出片
 *   → ③ 拼接成片 + 烧字幕 → ④ 导出剪映草稿。
 * 批量出片统一交给 192.168.0.222 上的多卡并行池调度。
 */

/** 赛道依赖的本机能力是否都可用；返回不可用清单（空数组 = 全都能跑） */
function trendMissing(t) {
  const cap = state.capabilities;
  if (!cap) return [];
  const miss = [];
  for (const id of new Set([...(t.tools || []), t.imageWf, t.videoWf].filter(Boolean))) {
    const w = (cap.workflows || []).find((x) => x.id === id);
    if (w && !w.available) miss.push(`${w.label}（${id}）`);
  }
  return miss;
}

/** 赛道用哪张图当首帧：动画类走二次元立绘，真人类走写实 / Qwen-Image */
function trendImageRow(track) {
  const list = (state.capabilities?.workflows || []).filter((w) => w.kind === "image" && w.available);
  const cur = state.trendImageWf || track.imageWf || (list[0] || {}).id;
  const sel = h("select", { style: { minWidth: "330px" } });
  if (!list.length) sel.append(h("option", null, state.capabilities ? "当前没有可用的文生图引擎" : "能力清单加载中…"));
  for (const w of list) sel.append(h("option", { value: w.id, selected: w.id === cur }, `${w.label}（${w.id}）`));
  sel.onchange = () => { state.trendImageWf = sel.value; };
  return sel;
}

/**
 * 一键复刻：拆分镜 →（可选）批量出片。
 * onlyScript=true 时只拆分镜，方便先看脚本、再回「故事创作」精修单个镜头。
 */
async function trendRun(ctx, track, { idea, shots, seconds, onlyScript }, btn) {
  if (!state.projectId) return toast("请先选择项目（没有项目就去工作台新建一个）", "warn", 6000);
  const text = String(idea || "").trim() || track.idea;
  const label = btn.textContent;
  btn.disabled = true;
  try {
    persistStorySelection();
    btn.textContent = "① 正在拆分镜…";
    const perShot = Math.max(2, Math.min(20, Number(seconds) || Number(track.duration) || 5));
    const r = await api.genScript({
      project_id: state.projectId, story: text,
      shot_count: Number(shots) || track.shots, aspect: state.aspect,
      duration_s: perShot,
      style_id: state.storyStyleId || undefined,
      character_ids: state.storyCharacterIds,
      llm: state.llmId, preset: state.llmPreset, thinking: state.llmThinking,
    });
    state.script = r.script; state.shots = r.shots || [];
    state.scriptsLoadedFor = state.projectId;
    const shortOf = r.requested_shots && state.shots.length < r.requested_shots;
    toast(r.note || `「${track.name}」已拆出 ${state.shots.length} 个镜头（单镜 ${perShot} 秒）`, shortOf ? "warn" : "ok", shortOf ? 12000 : 6000);
    if (onlyScript) { ctx.reload(); return; }

    btn.textContent = "② 正在批量出片…";
    const imgs = (state.capabilities?.workflows || []).filter((w) => w.kind === "image" && w.available);
    const imageWf = state.trendImageWf || track.imageWf;
    const videoWf = state.storyVideoWf || track.videoWf;
    await api.runStoryboard(state.projectId, {
      continue_on_error: true,
      video_workflow: videoWf,
      image_workflow: imgs.some((w) => w.id === imageWf) ? imageWf : undefined,
      style_id: state.storyStyleId || undefined,
      character_ids: state.storyCharacterIds,
      with_voice: effectiveStoryVoice(videoWf),
      burn_subtitles: state.storyBurnSubs !== false,
      tts_provider: state.ttsProvider, tts_voice: state.ttsVoice, tts_rate: Number(state.ttsRate) || 0,

      keep_original_audio: state.dubKeepOriginal !== false,
      original_volume_db: Number(state.dubOriginalDb ?? -14),
    });
    const eng = storyVideoEngines().find((w) => w.id === videoWf);
    toast(`「${track.name}」已开始批量出片：逐镜头「首帧图 → 视频」`
      + (eng ? `，引擎 ${eng.id} ${eng.label}${eng.hasAudio ? "（自带声音）" : ""}` : "")
      + poolText() + "；到任务中心看进度", "ok", 9000);
    ctx.go("/jobs");
  } catch (e) { toast(e.message, "err", 9000); } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

function trending(ctx) {
  if (!state.trendGroup) state.trendGroup = "all";
  if (!state.trendId || !trendById(state.trendId)) state.trendId = TRENDS[0].id;
  if (!state.trendMetaLoaded) {
    state.trendMetaLoaded = true;
    Promise.all([loadLlms(), loadPool()]).then(() => ctx.reload()).catch(() => {});
  }
  if (state.tts === null) loadTts(ctx);

  const track = trendById(state.trendId) || TRENDS[0];
  const list = trendsOf(state.trendGroup);
  const missing = trendMissing(track);
  const groupLabel = (TREND_GROUPS.find((g) => g.id === state.trendGroup) || {}).label || "全部热门";

  const hero = h("div", { class: "hero", style: { marginBottom: "14px" } },
    h("h1", null, "🔥 爆款复刻"),
    h("p", null, `把抖音 / 快手最热的 ${TRENDS.length} 个视频玩法做成卡片：选一个赛道，它自带选题模板、镜头节拍、画幅、风格模板和出片引擎，一句话就能复刻一条同款。`),
    h("p", { style: { marginTop: "6px" } }, "拆分镜 → 逐镜头出首帧图 → 图生视频（可带台词人声）→ 拼接成片烧字幕 → 导出剪映草稿，全程在本机模型上跑。"),
    h("div", { class: "row wrap", style: { marginTop: "10px", gap: "8px" } },
      h("span", { class: "pill acc" }, `${list.length} 个赛道可选`),
      ...(state.pool?.capacity ? [h("span", { class: "pill ok" }, `多卡并行：${state.pool.capacity.instances} 张卡 / 同时 ${state.pool.capacity.total} 个任务`)] : []),
      h("span", { class: "pill" }, `本项目已有 ${(state.shots || []).length} 个分镜`)));

  const tabs = h("div", { class: "tabs" },
    h("button", { class: state.trendGroup === "all" ? "on" : "", onClick: () => { state.trendGroup = "all"; ctx.reload(); } }, "🔥 全部热门"),
    ...TREND_GROUPS.map((g) => h("button", {
      class: state.trendGroup === g.id ? "on" : "", title: g.desc,
      onClick: () => { state.trendGroup = g.id; ctx.reload(); },
    }, `${g.ico} ${g.label}`)));

  const cards = h("div", { class: "trend-grid" }, list.map((t) => {
    const miss = trendMissing(t);
    const styleName = (state.styles.find((s) => s.id === t.styleId) || {}).name || t.styleId;
    return h("div", {
      class: `trend-card ${t.id === track.id ? "on" : ""}`,
      title: t.tagline,
      onClick: () => {
        state.trendId = t.id;
        state.aspect = t.ratio;
        state.storyShotCount = t.shots;
        state.trendImageWf = t.imageWf;
        state.storyVideoWf = t.videoWf;
        state.storyWithVoice = !!t.withVoice;
        state.trendIdea = null;
        state.trendShotSeconds = t.duration || 5;
        ctx.reload();
      },
    },
      h("div", { class: "tt" }, h("span", { class: "ti" }, t.ico), h("span", null, t.name), h("span", { class: "hot" }, t.hot)),
      h("p", null, t.tagline),
      h("div", { class: "meta" },
        h("span", { class: "pill" }, t.ratio),
        h("span", { class: "pill" }, `${t.shots} 镜 / 单镜 ${t.duration}s`),
        h("span", { class: "pill" }, t.withVoice ? "带人声" : "纯音乐"),
        h("span", { class: "pill acc" }, styleName)),
      miss.length ? h("div", { class: "tiny", style: { color: "var(--warn)" } }, `⚠️ 缺：${miss.join("、")}`) : null,
      h("div", { class: "src" }, `赛道来源：${t.source}`));
  }));

  const projSel = h("select", null,
    h("option", { value: "" }, "（请选择项目）"),
    ...state.projects.map((p) => h("option", { value: p.value ?? p.id, selected: (p.value ?? p.id) === state.projectId }, p.title)));
  projSel.onchange = () => {
    state.projectId = projSel.value || null;
    state.scriptsLoadedFor = null;
    ctx.reload();
  };

  const idea = h("textarea", { rows: 5, placeholder: "赛道选题，可改成你自己的" });
  idea.value = state.trendIdea != null ? state.trendIdea : track.idea;
  idea.oninput = () => { state.trendIdea = idea.value; };

  const nShots = h("input", { type: "number", min: 2, max: 60, value: state.storyShotCount || track.shots, style: { width: "86px" } });
  nShots.oninput = () => { state.storyShotCount = Number(nShots.value) || track.shots; };
  // 单镜时长：拆分镜时就把这个秒数写进每个镜头（不再听模型自己写的 4~6 秒）。
  // 一条片子每镜等长，拼接后的节奏才稳；切换赛道会回到该赛道的推荐时长。
  if (!(Number(state.trendShotSeconds) > 0)) state.trendShotSeconds = track.duration || 5;
  const secInput = h("input", { type: "number", min: 2, max: 20, step: 1, value: state.trendShotSeconds, style: { width: "86px" } });
  secInput.oninput = () => { state.trendShotSeconds = Number(secInput.value) || 0; };

  const voiceChk = h("input", { type: "checkbox", checked: !!state.storyWithVoice });
  voiceChk.onchange = () => { state.storyWithVoice = voiceChk.checked; ctx.reload(); };

  const onlyBtn = h("button", null, "只拆分镜看看");
  onlyBtn.onclick = () => trendRun(ctx, track, { idea: idea.value, shots: nShots.value, seconds: secInput.value, onlyScript: true }, onlyBtn);
  const runBtn = h("button", { class: "primary", style: { flex: "1", minWidth: "200px" } }, "🔥 一键复刻（拆分镜 → 批量出片）");
  runBtn.onclick = () => trendRun(ctx, track, { idea: idea.value, shots: nShots.value, seconds: secInput.value, onlyScript: false }, runBtn);

  const left = h("div", { class: "card" },
    h("h3", null, "复刻设置"),
    h("div", { class: "field" }, h("label", null, "所属项目"), projSel),
    h("div", { class: "pill acc", style: { display: "block", padding: "10px 12px", marginBottom: "12px", lineHeight: "1.7" } },
      h("b", null, `${track.ico} ${track.name}　`), h("span", { class: "tiny" }, track.hot),
      h("div", { class: "tiny", style: { marginTop: "6px", color: "var(--dim)" } }, track.tagline),
      h("div", { class: "tiny muted", style: { marginTop: "4px" } }, `赛道来源：${track.source}`),
      track.beats && track.beats.length ? h("ul", { class: "trend-beats" }, track.beats.map((b) => h("li", null, b))) : null,
      h("div", { class: "tiny muted", style: { marginTop: "4px" } }, track.note)),
    missing.length ? h("div", { class: "pill warn", style: { display: "block", marginBottom: "10px" } },
      `⚠️ 本机暂缺：${missing.join("、")}，出片时这几个环节会自动降级`) : null,
    track.needBgm ? h("div", { class: "pill warn", style: { display: "block", marginBottom: "10px" } },
      "🎵 BGM 自己上传：本机 AI 生成 BGM 权重缺失，出片后在「拼接成片」里挂一条音轨即可。") : null,
    h("div", { class: "field" },
      h("div", { class: "row wrap", style: { justifyContent: "space-between", alignItems: "center", gap: "8px" } },
        h("label", { style: { margin: 0 } }, "故事梗概 / 脚本（可改成你自己的选题）"),
        h("button", { class: "sm", title: "让 AI 把梗概写细：拆出每个镜头的画面与台词，写完再填回来",
          onClick: () => openEnhance(ctx, {
            title: "提示词扩写 · 把梗概写细",
            mode: "storyboard",
            initial: idea.value,
            onApply: (result, raw) => {
              const text = enhanceToScript(result, raw);
              if (!text) return toast("扩写没有返回可用内容，可以看下面的原文再手动粘贴", "warn", 7000);
              state.trendIdea = text;
              idea.value = text;
              toast("已把扩写结果填回「故事梗概」，可以直接一键复刻", "ok", 7000);
            },
          }) }, "✨ 提示词扩写")),
      idea),
    h("div", { class: "field" }, h("label", null, "镜头数与节奏"),
      h("div", { class: "row wrap", style: { gap: "16px", alignItems: "center" } },
        h("span", { class: "row", style: { gap: "6px", alignItems: "center" } },
          h("span", { class: "tiny muted" }, "镜头数"), nShots),
        h("span", { class: "row", style: { gap: "6px", alignItems: "center" } },
          h("span", { class: "tiny muted" }, "单镜时长"), secInput, h("span", { class: "tiny muted" }, "秒")),
        h("span", { class: "tiny muted" }, "抖音爆款一般 4~6 秒 / 镜，最长 20 秒"))),
    h("div", { class: "field" }, h("label", null, "画幅比例"), aspectRow(ctx),
      h("div", { class: "tiny muted", style: { marginTop: "4px" } }, `赛道推荐 ${track.ratio}（抖音竖版主战场）`)),
    h("div", { class: "field" }, h("label", null, "AI 模型（写脚本 / 拆分镜）"), llmPicker(ctx)),
    h("div", { class: "field" }, h("label", null, "视频引擎（分镜出片）"), storyEngineRow(ctx),
      h("div", { class: "tiny muted", style: { marginTop: "4px" } }, `赛道推荐 ${track.videoWf}`)),
    h("div", { class: "field" }, h("label", null, "首帧出图引擎"), trendImageRow(track),
      h("div", { class: "tiny muted", style: { marginTop: "4px" } }, `赛道推荐 ${track.imageWf}${track.imageWf === "WF-01C" ? "（二次元立绘，动画赛道用）" : ""}`)),
    h("div", { class: "field" }, h("label", null, "风格模板（整条片子统一画风）"), storyStylePicker(ctx)),
    h("div", { class: "field" }, h("label", null, "角色锁定（跨镜头保持长相，可多选）"), characterPicker(ctx, "storyCharacterIds")),
    h("div", { class: "field" }, h("label", null, "声音"),
      h("div", { class: "row wrap", style: { gap: "10px", alignItems: "center" } },
        h("label", { class: "tiny", style: { display: "inline-flex", gap: "4px", alignItems: "center", cursor: "pointer", whiteSpace: "nowrap" } },
          voiceChk, "按分镜台词自动配音"),
        state.storyWithVoice ? ttsControls(ctx, "配音引擎") : null)),
    h("div", { class: "row wrap", style: { gap: "8px" } }, runBtn, onlyBtn),
    h("div", { class: "tiny muted", style: { marginTop: "10px" } },
      "出片后到「任务中心」看进度；「故事创作」里能单镜重出、调顺序拼接成片、烧字幕，并一键导出剪映草稿。" + poolText()));

  return h("div", null, hero, tabs,
    h("div", { class: "trend-studio" },
      left,
      h("div", { class: "card" },
        h("div", { class: "row wrap", style: { justifyContent: "space-between", gap: "8px" } },
          h("h3", { style: { margin: 0 } }, `${groupLabel} · ${list.length} 个赛道`),
          h("span", { class: "tiny muted" }, "点卡片 = 自动套用这条赛道的全部预设")),
        h("div", { style: { marginTop: "12px" } }, cards))));
}
// ---------------------------------------------------- 素材压缩（按目标大小压一份小副本）

/** 目标大小预设（和 src/compress.js 的 PRESETS 对齐） */
const COMPRESS_PRESETS = [
  { id: "m5", label: "5MB 以内", mb: 5, hint: "微信 / 朋友圈" },
  { id: "m10", label: "10MB 以内", mb: 10, hint: "抖音 / 快手 高清上传" },
  { id: "m25", label: "25MB 以内", mb: 25, hint: "微信发送" },
  { id: "m50", label: "50MB 以内", mb: 50, hint: "通用小体积" },
];
const COMPRESS_HEIGHTS = [[0, "保持原样（推荐）"], [1080, "1080P"], [720, "720P"], [540, "540P"], [480, "480P"]];
const COMPRESS_AUDIO_KBPS = [64, 96, 128, 192];

/** 压缩选项在弹窗之间保留：连着压几条素材时不用每次重选 */
function compressOpts() {
  if (!state.compressOpts) {
    state.compressOpts = { preset: "m10", targetMB: 10, maxHeight: 0, audioKbps: 128, force: false };
  }
  return state.compressOpts;
}

/** 粗算这个目标能分到多少码率（与 src/compress.js 同口径，只用于弹窗里的提示） */
function compressEstimate(a, o) {
  const sec = Number(a?.duration_ms || 0) / 1000;
  if (!(sec > 0.5)) return null;
  const budget = Math.round((o.targetMB * 1048576 * 0.96) * 8 / sec / 1000);
  const isAudio = a.kind === "audio";
  const audio = isAudio ? Math.min(320, budget) : o.audioKbps;
  return { budget, audio, video: isAudio ? null : budget - audio };
}

async function reloadAssets(ctx) {
  try { state.assets = await api.assets({ kind: state.assetKind || undefined, limit: 300 }); }
  catch { /* 拉不到就保留旧列表，别把界面清空 */ }
  ctx.reload();
}

/**
 * 素材压缩弹窗：选目标大小 → 本机 ffmpeg 压一份小体积副本（原素材不动）。
 * 单条（点卡片上的「压缩」）和批量（工具栏「压缩选中」）共用这一个弹窗。
 */
function compressModal(ctx, asset, batch = null) {
  const o = compressOpts();
  const list = batch || (asset ? [asset] : []);
  const body = h("div");
  let busy = false;

  const title = batch ? `批量压缩 ${list.length} 个素材` : `压缩素材 · ${baseName(asset?.path || "")}`;

  const paint = () => {
    clear(body);
    if (!list.length) { body.append(h("div", { class: "muted" }, "没有可压缩的素材")); return; }
    const src = list[0];
    const srcMB = (Number(src.size_bytes) || 0) / 1048576;
    body.append(h("div", { class: "tiny muted", style: { marginBottom: "10px" } },
      batch
        ? `把勾选的 ${list.length} 个音频 / 视频各压一份，都用下面这套参数。原素材全部保留。`
        : `${baseName(src.path)} · ${fmtSize(src.size_bytes)}`
          + `${src.duration_ms ? ` · ${fmtDur(src.duration_ms)}` : ""}`
          + `${src.width && src.height ? ` · ${src.width}×${src.height}` : ""}`));

    const chips = h("div", { class: "chips" }, COMPRESS_PRESETS.map((p) =>
      h("span", {
        class: `chip ${o.preset === p.id ? "on" : ""}`, title: p.hint,
        onClick: () => { o.preset = p.id; o.targetMB = p.mb; paint(); },
      }, p.label)));
    const custom = h("input", {
      type: "number", min: 1, max: 4096, step: 1, value: String(o.targetMB), style: { width: "110px" },
    });
    custom.oninput = () => {
      const v = Number(custom.value);
      if (v > 0) { o.targetMB = v; o.preset = (COMPRESS_PRESETS.find((p) => p.mb === v) || {}).id || "custom"; }
    };
    body.append(h("div", { class: "field" }, h("label", null, "① 目标大小"), chips,
      h("div", { class: "row wrap", style: { gap: "8px", alignItems: "center", marginTop: "6px" } },
        h("span", { class: "tiny muted" }, "自定义"), custom, h("span", { class: "tiny muted" }, "MB"))));

    const anyVideo = list.some((x) => x.kind === "video");
    if (anyVideo) {
      const hSel = h("select", { style: { minWidth: "220px" } }, ...COMPRESS_HEIGHTS.map(([v, t]) =>
        h("option", { value: String(v), selected: Number(o.maxHeight) === v }, t)));
      hSel.onchange = () => { o.maxHeight = Number(hSel.value) || 0; paint(); };
      const aSel = h("select", null, ...COMPRESS_AUDIO_KBPS.map((k) =>
        h("option", { value: String(k), selected: Number(o.audioKbps) === k }, `${k} kbps${k === 128 ? "（推荐）" : ""}`)));
      aSel.onchange = () => { o.audioKbps = Number(aSel.value) || 128; paint(); };
      body.append(h("div", { class: "field" }, h("label", null, "② 视频参数"),
        h("div", { class: "row wrap", style: { gap: "10px", alignItems: "center" } },
          h("span", { class: "tiny muted" }, "输出分辨率"), hSel,
          h("span", { class: "tiny muted" }, "音轨码率"), aSel)));
    }

    const est = compressEstimate(src, o);
    if (est) {
      body.append(h("div", { class: "tiny muted", style: { marginTop: "2px" } },
        `预计码率：总 ${est.budget} kbps`
        + (est.video != null ? `（画面 ${est.video} kbps + 音频 ${est.audio} kbps）` : `（音频 ${est.audio} kbps）`)
        + (est.video != null && est.video < 120 ? "　⚠️ 画面码率偏低，建议调大目标或降一档分辨率" : "")));
    }

    if (!batch && srcMB <= o.targetMB) {
      const cb = h("input", { type: "checkbox" });
      cb.checked = !!o.force;
      cb.onchange = () => { o.force = cb.checked; };
      body.append(h("div", { class: "field" }, h("label", null, "③ 其它"),
        h("label", { class: "tiny muted", style: { display: "flex", gap: "6px", alignItems: "center" } },
          cb, `源文件本来就只有 ${srcMB.toFixed(2)} MB（不超过目标）；勾上就是照样重压一遍`)));
    }

    body.append(h("div", { class: "tiny muted", style: { marginTop: "8px" } },
      "压缩在本机用 ffmpeg 完成（视频两遍 ABR、音频 CBR mp3），不占 222 的显存；" +
      "产物按「项目名_视频 / 音频_流水号」存进素材库，原素材一个字节都不动。"));
  };

  const run = async (c) => {
    if (busy) return;
    busy = true;
    const payload = {
      target_mb: o.targetMB, max_height: o.maxHeight, audio_kbps: o.audioKbps,
      preset: o.preset, force: o.force === true,
    };
    let done = 0; const fails = [];
    for (const a of list) {
      toast(`正在压缩 ${baseName(a.path)}…（本机 ffmpeg，视频越长越慢）`, "info", 6000);
      try {
        const r = await api.compressAsset(a.id, { ...payload, project_id: a.project_id || null });
        done += 1;
        toast(`${baseName(a.path)}：${fmtSize(r.source_bytes)} → ${fmtSize(r.compressed_bytes)}`
          + (r.within_target === false ? "（没能压进目标，可再降一档）" : ""), "ok", 9000);
      } catch (e) {
        fails.push(`${baseName(a.path)}：${e.message}`);
      }
    }
    busy = false;
    if (c) c();
    state.assetSel = [];
    await reloadAssets(ctx);
    if (fails.length) toast(`有 ${fails.length} 个没压成：${fails[0]}`, "err", 11000);
    else if (done) toast(`已压缩 ${done} 个素材，新文件在素材库里（原素材保留）`, "ok", 8000);
  };

  paint();
  return modal(title, body, [
    { label: "关闭", onClick: (c) => c() },
    { label: batch ? `开始压缩（${list.length}）` : "开始压缩", primary: true, onClick: (c) => run(c) },
  ]);
}

/** 工具栏「压缩选中」：把勾选的音频 / 视频按同一套参数各压一份 */
function compressSelected(ctx) {
  const list = (state.assets || [])
    .filter((a) => state.assetSel.includes(a.id) && (a.kind === "video" || a.kind === "audio"));
  if (!list.length) { toast("先勾选要压缩的音频 / 视频素材（图片不参与压缩）", "warn", 6000); return; }
  compressModal(ctx, null, list);
}

// ============================================================ 素材库
const KIND_TEXT = { image: "图片", video: "视频", audio: "音频", file: "文件" };

function assets(ctx) {
  if (!state.assets) state.assets = [];
  if (!state.assetSel) state.assetSel = [];
  const box = h("div");
  const refresh = async () => {
    // limit 与启动时的预取（app.js 用 300）保持一致：不然切一次筛选，头部数量会从 219 变成 200
    try { state.assets = await api.assets({ kind: state.assetKind || undefined, limit: 300 }); }
    catch (e) { toast(e.message, "err"); }
    ctx.reload();
  };
  const toggle = (id) => {
    state.assetSel = state.assetSel.includes(id) ? state.assetSel.filter((x) => x !== id) : [...state.assetSel, id];
    ctx.reload();
  };

  // 全选 / 取消全选：只作用于当前筛选出来的这一批（切到「视频」再全选，选的就是这批视频）
  const allSelected = state.assets.length > 0 && state.assets.every((a) => state.assetSel.includes(a.id));
  const toggleAll = () => {
    state.assetSel = allSelected ? [] : state.assets.map((a) => a.id);
    ctx.reload();
  };
  const removeSelected = () => {
    const n = state.assetSel.length;
    if (!n) { toast("先在素材上点一下勾选（或按「全选」）再删", "warn", 5000); return; }
    confirmDialog("删除选中素材",
      `确定删除选中的 ${n} 个素材？删除后不可撤销。` +
      "被分镜 / 角色当作参考图的素材删掉后，对应分镜需要重新生成首帧。",
      async () => {
        try {
          const r = await api.deleteAssets(state.assetSel);
          state.assetSel = [];
          toast(`已删除 ${r.deleted} 个素材${r.files ? `，同时清掉 ${r.files} 个文件` : ""}` +
            (r.kept?.length ? `（${r.kept.length} 个文件被其它素材共用，已保留）` : ""), "ok", 6000);
          refresh();
        } catch (e) { toast(e.message, "err"); }
      });
  };

  box.append(h("div", { class: "row wrap", style: { justifyContent: "space-between", marginBottom: "14px", gap: "8px" } },
    h("div", null,
      h("h2", { style: { margin: 0 } }, "素材库"),
      h("div", { class: "tiny muted" }, `共 ${state.assets.length} 个素材 · 已选 ${state.assetSel.length} 个 · 全部为无水印 1080P 成片级素材`)),
    h("div", { class: "row wrap", style: { gap: "6px" } },
      h("button", { class: "sm", onClick: () => refresh() }, "刷新"),
      h("button", { class: "sm", onClick: toggleAll, title: "全选 / 取消全选当前列表" }, allSelected ? "取消全选" : "全选"),
      h("button", { class: "sm danger", onClick: removeSelected, title: "删除勾选的素材" },
        `删除选中${state.assetSel.length ? `（${state.assetSel.length}）` : ""}`),
      h("button", { class: "sm ghost", onClick: () => { state.assetSel = []; ctx.reload(); }, title: "清空勾选" }, "取消选择"),
      h("button", { class: "sm", onClick: async () => {
        try {
          const r = await api.exportCapcut({ project_id: state.projectId, asset_ids: state.assetSel });
          toast(`剪映草稿包已生成（${r.entries} 个文件，${Math.round(r.duration_s)} 秒）`, "ok");
          window.open(r.download_url, "_blank");
        } catch (e) { toast(e.message, "err"); }
      } }, "导出剪映草稿"),
      h("button", { class: "sm", onClick: () => compressSelected(ctx),
        title: "把勾选的音频 / 视频按同一套参数各压一份小体积副本" }, "🗜 压缩选中"),
      h("button", { class: "sm primary", onClick: () => {
        const picked = state.assets.filter((a) => state.assetSel.includes(a.id) && a.kind === "video");
        concatModal(ctx, { initial: picked, projectId: state.projectId });
      } }, "拼接成片"))));

  const KINDS = [["", "全部"], ["image", "图片"], ["video", "视频"], ["audio", "音频"]];
  box.append(h("div", { class: "chips" }, KINDS.map(([v, t]) =>
    h("span", { class: `chip ${(state.assetKind || "") === v ? "on" : ""}`, onClick: () => { state.assetKind = v; refresh(); } }, t))));

  const grid = h("div", { class: "asset-grid", style: { marginTop: "12px" } });
  if (!state.assets.length) grid.append(emptyNode("暂无素材，先去「创作台」生成吧"));
  for (const a of state.assets) {
    const on = state.assetSel.includes(a.id);
    grid.append(h("div", { class: `asset-card ${on ? "sel" : ""}` },
      h("div", { class: "thumb", onClick: () => toggle(a.id), title: on ? "点击取消选择" : "点击选择" },
        h("span", { class: `pick ${on ? "on" : ""}` }, "✓"),
        a.kind === "image" ? h("img", { src: a.url })
          : h("span", null, a.kind === "video" ? "🎬" : a.kind === "audio" ? "🎵" : "📄")),
      h("div", { class: "meta" },
        h("div", null, `${KIND_TEXT[a.kind] || a.kind} · ${fmtSize(a.size_bytes)}`),
        h("div", { class: "tiny muted" }, a.duration_ms ? fmtDur(a.duration_ms) : fmtTime(a.created_at)),
        // 带同步歌词的音频（出歌 / 重唱自动生成）：卡片上直接给一个歌词下载，别藏进预览里
        a.meta && a.meta.subtitle && a.meta.subtitle.files && a.meta.subtitle.files.lrc
          ? h("div", { class: "row wrap", style: { gap: "6px", alignItems: "center", marginTop: "4px" } },
              h("span", { class: "pill acc", style: { fontSize: "11px" } },
                `歌词 ${a.meta.subtitle.count} 行${subtitleConf(a.meta.subtitle) === "high" ? "" : " · 估算"}`),
              h("a", { class: "tiny", href: a.meta.subtitle.files.lrc.url, download: a.meta.subtitle.files.lrc.name,
                title: "下载 .lrc 歌词（.srt / .ass 点「预览」里有）" }, "⬇ 歌词"),
              h("button", { class: "sm", style: { fontSize: "11px", padding: "2px 6px" },
                title: "用现在的对齐算法重算一遍并覆盖这三份字幕",
                onClick: () => realignLyrics(a) }, "对齐"))
          : null),

      // 压缩：音频 / 视频都能按「目标大小」压一份小体积副本（本机 ffmpeg，原素材不动）
      a.kind === "video" || a.kind === "audio"
        ? h("div", { class: "row wrap", style: { gap: "6px", alignItems: "center", padding: "0 8px 4px" } },
            a.meta && a.meta.compressed
              ? h("span", { class: "pill acc", style: { fontSize: "11px" }, title: "由压缩产生，原文件仍保留在素材库里" },
                  `已压缩 ${(Number(a.meta.compressed.from_bytes || 0) / 1048576).toFixed(1)}→${(Number(a.size_bytes || 0) / 1048576).toFixed(1)}MB`)
              : null,
            h("button", { class: "sm", style: { fontSize: "11px", padding: "2px 6px" },
              title: "按目标大小压一份小体积副本（本机压缩，原素材不动）",
              onClick: () => compressModal(ctx, a) }, "🗜 压缩"))
        : null,

      h("div", { class: "row", style: { padding: "0 8px 8px", gap: "6px" } },
        h("button", { class: "sm", style: { flex: "1" }, title: PREVIEW_HINT[a.kind] || "预览", onClick: () => previewAsset(a.id) }, "预览"),
        h("a", { href: a.url, download: "", style: { flex: "1" } }, h("button", { class: "sm", style: { width: "100%" } }, "下载")),
        h("button", { class: "sm danger", onClick: () => confirmDialog("删除素材", "确定删除该素材？此操作不可撤销。", async () => {
          try {
            await api.deleteAsset(a.id);
            state.assetSel = state.assetSel.filter((x) => x !== a.id);
            toast("已删除", "ok");
            refresh();
          } catch (e) { toast(e.message, "err"); }
        }) }, "删除"))));
  }
  box.append(grid);
  return box;
}

// ============================================================ 任务中心/** 素材卡「预览」按钮的提示文案（图片看大图 / 视频播放 / 音频试听） */
const PREVIEW_HINT = { image: "放大看图", video: "播放视频", audio: "试听音频" };

/**
 * 素材预览：图片放大看、视频用播放器播、音频直接试听。
 *
 * · 弹窗里能「上一张 / 下一张」按当前筛选出来的顺序连着看，方便成批挑素材；
 * · 点画面本身（或「在新标签页打开」）直接看原文件；
 * · 切换素材时整个舞台节点被清空重建 —— 音频 / 视频靠这个自动停下来，不用手动 pause。
 */
function previewAsset(assetId) {
  const list = (state.assets || []).filter((x) => ["image", "video", "audio"].includes(x.kind));
  const idx0 = list.findIndex((x) => x.id === assetId);
  if (idx0 < 0) { toast("这个素材暂不支持预览，可以直接下载", "warn"); return; }
  let idx = idx0;
  const stage = h("div", { class: "preview-stage" });
  const meta = h("div", { class: "tiny muted", style: { marginTop: "10px", textAlign: "center" } });
  const lyricBox = h("div", { class: "row wrap", style: { gap: "10px", justifyContent: "center", alignItems: "center", marginTop: "10px" } });
  const open = (a) => window.open(a.url, "_blank");

  const paint = () => {
    const a = list[idx];
    clear(stage);
    if (a.kind === "image") {
      stage.append(h("img", { src: a.url, alt: "素材预览", title: "点击在新标签页看原图", onClick: () => open(a) }));
    } else if (a.kind === "video") {
      stage.append(h("video", { src: a.url, controls: true, autoplay: true, playsinline: true, title: "点击在新标签页打开", onClick: () => open(a) }));
    } else {
      stage.append(h("div", { style: { textAlign: "center", width: "100%" } },
        h("div", { style: { fontSize: "34px", marginBottom: "8px" } }, "🎵"),
        h("audio", { src: a.url, controls: true, autoplay: true, style: { width: "100%" } })));
    }
    meta.textContent = [
      `第 ${idx + 1} / ${list.length} 个`,
      KIND_TEXT[a.kind] || a.kind,
      fmtSize(a.size_bytes),
      a.width && a.height ? `${a.width}×${a.height}` : null,
      a.duration_ms ? fmtDur(a.duration_ms) : null,
      a.kind === "video" ? (a.has_audio ? "带音轨" : "无音轨") : null,
      fmtTime(a.created_at),
    ].filter(Boolean).join(" · ");
    // 带「同步歌词」的音频（出歌 / 重唱自动生成，或补生成的）在这里也能直接下载，见 src/lyrics.js
    clear(lyricBox);
    const sub = a.meta && a.meta.subtitle;
    if (sub && sub.files) {
      lyricBox.append(h("span", { class: "pill acc" }, `同步歌词 ${sub.count} 行 · ${sub.mode_label}`));
      lyricBox.append(h("span", { class: "tiny muted" }, subtitleConf(sub) === "high"
        ? "对齐可靠（按真人声标尺）"
        : "时间轴是估算的，点「重新对齐」可以按分离人声重算一遍"));
      for (const [k, label] of [["lrc", "⬇ .lrc 歌词"], ["srt", "⬇ .srt 字幕"], ["ass", "⬇ .ass 烧录用"]]) {
        const f = sub.files[k];
        if (f) lyricBox.append(h("a", { class: "sm", href: f.url, download: f.name }, label));
      }
      if (a.kind === "audio") lyricBox.append(h("button", { class: "sm", onClick: () => realignLyrics(a) }, "重新对齐"));
    }
  };
  paint();

  const step = (d) => { idx = (idx + d + list.length) % list.length; paint(); };
  modal("素材预览", h("div", null, stage, lyricBox, meta), [

    { label: "← 上一个", onClick: () => step(-1) },
    { label: "下一个 →", onClick: () => step(1) },
    { label: "在新标签页打开", onClick: () => open(list[idx]) },
  ]);
}


function jobs(ctx) {
  if (!state.jobs) state.jobs = [];
  clearInterval(state.__jobsTimer);
  const filter = state.jobFilter || "all";
  const box = h("div");
  const listBox = h("div", { style: { marginTop: "12px" } });

  const paint = () => {
    const list = filter === "all" ? state.jobs : state.jobs.filter((j) => j.status === filter);
    clear(listBox);
    if (!list.length) { listBox.append(emptyNode("暂无任务")); return; }
    for (const j of list) listBox.append(jobRow(ctx, j));
  };
  const load = async () => {
    try {
      state.jobs = await api.jobs({ limit: 60 });
      paint();
      ctx.refreshQueueBadge?.();
    } catch (e) { /* 静默重试 */ }
  };

  box.append(h("div", { class: "row wrap", style: { justifyContent: "space-between", gap: "8px" } },
    h("div", null,
      h("h2", { style: { margin: 0 } }, "任务中心"),
      h("div", { class: "tiny muted" }, (() => {
        const cap = state.pool?.capacity;
        const head = cap && cap.instances ? `已接入 ${cap.instances} 张显卡、可同时跑 ${cap.total} 个任务；` : "正在读取算力…；";
        return `${head}任务会自动铺到空闲的卡上，而配音这类纯 I/O 的活儿在本机完成、不占显卡；视频任务跑完、整机安静下来后会自动释放显存。`;
      })())),
    h("div", { class: "row wrap", style: { gap: "6px" } },
      h("button", { class: "sm", onClick: () => load() }, "刷新"),
      h("button", { class: "sm", onClick: async () => { try { await api.freeMemory(); toast("已请求释放显存", "ok"); } catch (e) { toast(e.message, "err"); } } }, "释放显存"))));

  const FILTERS = [["all", "全部"], ["running", "进行中"], ["queued", "排队中"], ["succeeded", "已完成"], ["failed", "失败"]];
  box.append(h("div", { class: "chips", style: { marginTop: "10px" } }, FILTERS.map(([v, t]) =>
    h("span", { class: `chip ${filter === v ? "on" : ""}`, onClick: () => { state.jobFilter = v; ctx.reload(); } }, t))));
  box.append(listBox);
  load();
  paint();
  state.__jobsTimer = setInterval(load, 3000);
  return box;
}

function jobRow(ctx, j) {
  const wf = state.capabilities?.workflows?.find((w) => w.id === j.workflow_id);
  const pct = Math.max(0, Math.min(100, Math.round(j.progress || 0)));
  return h("div", { class: "job-row", style: { cursor: "pointer" }, onClick: () => detailJob(j.id) },
    h("div", { class: "row wrap", style: { justifyContent: "space-between", gap: "6px" } },
      h("div", { class: "row wrap", style: { gap: "6px" } },
        statusPill(j.status),
        h("b", null, wf?.label || j.workflow_id),
        h("span", { class: "tiny muted" }, j.title || j.params?.prompt || ""),
      ),
      h("div", { class: "row wrap", style: { gap: "6px" } },
        h("span", { class: "tiny muted" }, fmtTime(j.created_at)),
        ["queued", "dispatching", "running"].includes(j.status)
          ? h("button", { class: "sm danger", onClick: async (e) => {
            e?.stopPropagation?.();
            try { await api.cancelJob(j.id); toast("已请求取消", "ok"); } catch (err) { toast(err.message, "err"); }
          } }, "取消")
          : h("button", { class: "sm" }, "详情"))),
    h("div", { class: "bar", style: { marginTop: "8px" } }, h("i", { style: { width: `${pct}%` } })),
    h("div", { class: "tiny muted", style: { marginTop: "4px" } },
      `${pct}%　·　${j.workflow_id}　·　${j.instance || (j.engine === "local" ? "本机处理" : "待调度")}${j.error ? `　·　❌ ${j.error}` : ""}`));
}

async function detailJob(jobId) {
  const body = h("div", null, loadingNode("正在读取任务详情…"));
  modal(`任务详情`, body);
  try {
    const j = await api.job(jobId);
    const wf = state.capabilities?.workflows?.find((w) => w.id === j.workflow_id);
    clear(body);
    body.append(
      h("div", { class: "row wrap", style: { gap: "6px", marginBottom: "8px" } },
        statusPill(j.status),
        h("span", { class: "pill" }, j.workflow_id || "-"),
        wf ? h("span", { class: "pill" }, wf.label) : null,
        j.engine === "local" ? h("span", { class: "pill" }, "本机处理（不占显卡）") : j.instance ? h("span", { class: "pill" }, j.instance) : null,
        h("span", { class: "pill" }, `${Math.round(j.progress || 0)}%`)),
      j.error ? h("div", { class: "pill err", style: { marginBottom: "8px" } }, j.error) : null,
      h("div", { class: "tiny muted" }, `创建 ${fmtTime(j.created_at)} · 更新 ${fmtTime(j.updated_at || j.created_at)}`),
      h("div", { class: "hr" }),
      h("b", null, "产出"),
      (j.assets || []).length
        ? h("div", { class: "asset-grid", style: { marginTop: "8px" } }, (j.assets || []).map(resultCard))
        : emptyNode("暂无产物"),
      h("div", { class: "hr" }),
      h("b", null, "生成参数"),
      h("pre", { class: "tiny", style: { whiteSpace: "pre-wrap", maxHeight: "180px", overflow: "auto", background: "#0d1119", padding: "8px", borderRadius: "8px" } },
        JSON.stringify(j.params || {}, null, 1)),
      h("b", null, "事件日志"),
      h("pre", { class: "tiny", style: { whiteSpace: "pre-wrap", maxHeight: "220px", overflow: "auto", background: "#0d1119", padding: "8px", borderRadius: "8px" } },
        (j.events || []).map((e) => `${fmtTime(e.created_at)}  [${e.level}]  ${e.message}`).join("\n") || "（无）"));
  } catch (e) {
    clear(body);
    body.append(h("div", { class: "pill err" }, e.message));
  }
}

// ============================================================ 工具
// ============================================================ AI 翻唱（本机 128）
/**
 * 「AI 翻唱」：与创作台平级的独立页面。
 *
 * 三条链路全部跑在**本机 192.168.0.128** 的 ComfyUI 上（RVC / Demucs / ACE-Step 1.5），
 * 因为权重只在那台机器上：
 *   · 换音色翻唱（RVC）—— 保留原唱旋律，只把音色换成选中的模型
 *   · 整首重唱（ACE-Step 1.5）—— 按新歌词重新唱，给一段参考音频会带上原来的音色与编曲感
 *   · 人声 / 伴奏分离（Demucs）—— 拆成两条独立素材
 * 歌可以上传，也可以直接从素材库里挑（挑到视频会自动把音轨抽出来）。
 * 生成完的资源由后端在任务结束后自动释放（与创作台同一套显存回收规则）。
 */

async function loadVocal(ctx) {
  if (state.vocalLoading) return;
  state.vocalLoading = true;
  try {
    state.vocalStatus = await api.vocalStatus();
    const vs = (state.vocalStatus && state.vocalStatus.voices) || [];
    if (!state.vocalVoice || !vs.some((v) => v.id === state.vocalVoice)) {
      const local = vs.filter((v) => v.local);
      state.vocalVoice = ((local[local.length - 1] || vs[0] || {}).id) || null;
    }
  } catch (e) {
    state.vocalStatus = { error: e.message, engines: [], voices: [], modes: [] };
  } finally {
    state.vocalLoading = false;
    if (ctx && ctx.reload) ctx.reload();
  }
}

/** 能当「歌」用的素材：音频直接可用，视频会由后端自动抽音轨 */
function vocalSongs() {
  return (state.assets || []).filter((a) => a.kind === "audio" || a.kind === "video");
}

function vocalEngineOf(modeId) {
  const st = state.vocalStatus || {};
  return (st.engines || []).find((e) => e.id === modeId) || null;
}

/** 一行滑杆（label + range + 当前值），返回 { node, get } */
function vSlider(label, value, { min, max, step = 1, unit = "", hint = "", onChange }) {
  const val = h("span", { class: "val" }, `${value}${unit}`);
  const input = h("input", {
    type: "range", min, max, step, value,
    oninput: (e) => { val.textContent = `${e.target.value}${unit}`; onChange(Number(e.target.value)); },
  });
  return h("div", { class: "field" },
    h("label", null, label, hint ? h("span", { class: "tiny muted" }, `　${hint}`) : null),
    h("div", { class: "slider" }, input, val));
}

/** 翻唱页：状态条 + ① 选歌 + ② 玩法与参数 + ③ 生成与结果 */
function vocal(ctx) {
  if (state.vocalStatus === null || state.vocalStatus === undefined) loadVocal(ctx);
  if (!state.llms) loadLlms().then(() => ctx && ctx.reload && ctx.reload()).catch(() => {});
  const st = state.vocalStatus;
  const box = h("div");
  // 模式要在「① 选歌」之前就知道：训练音色那一档选的是「样本」，不是「一首歌」
  const modeId = state.vocalMode || "rvc";

  // ---------------------------------------------------------- 状态条
  const statusCard = h("div", { class: "card" });
  if (!st) {
    statusCard.append(loadingNode("正在检查本机翻唱环境…"));
  } else if (st.error) {
    statusCard.append(h("div", { class: "pill err" }, `本机翻唱环境读取失败：${st.error}`));
  } else {
    const engines = st.engines || [];
    const okCount = engines.filter((e) => e.available).length;
    statusCard.append(
      h("div", { class: "row wrap", style: { gap: "10px", alignItems: "center" } },
        h("h3", { style: { margin: "0" } }, "🎤 AI 翻唱（跑在本机）"),
        h("span", { class: `pill ${st.online ? "ok" : "err"}` }, st.online ? "本机 ComfyUI 在线" : "本机 ComfyUI 离线"),
        h("span", { class: "pill acc" }, `${st.machine || "本机"}`),
        h("span", { class: "tiny muted" }, `${st.url || ""}${st.nodes ? ` · ${st.nodes} 个节点` : ""}`),
        h("span", { class: "tiny muted" }, `可用玩法 ${okCount}/${engines.length} · 音色 ${(st.voices || []).length} 个`),
        h("button", { class: "sm ghost", onClick: () => { state.vocalStatus = null; loadVocal(ctx); } }, "重新检测")),
      h("div", { class: "tiny muted", style: { marginTop: "6px" } },
        "翻唱用的权重（RVC 音色、人声分离、ACE-Step）只在你这台机器上，所以整条链路都在本机跑："
        + "不占用 192.168.0.222 的多卡资源，也不用等别人的任务排队。生成结束会自动释放显存。"));
    for (const e of engines) {
      if (e.available) continue;
      statusCard.append(h("div", { class: "pill warn", style: { display: "block", marginTop: "6px" } },
        `${e.id === "rvc" ? "换音色翻唱" : e.id === "ace" ? "整首重唱" : "人声/伴奏分离"}暂不可用：${(e.reasons || []).join("；")}`));
    }
  }
  box.append(statusCard);

  // ---------------------------------------------------------- ① 选歌
  const song = state.vocalSong;
  const songs = vocalSongs();
  const file = h("input", { type: "file", accept: "audio/*,video/*" });
  file.onchange = async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    try {
      const a = await api.upload(f, { projectId: state.projectId || "" });
      state.assets = [a, ...(state.assets || [])];
      state.vocalSong = a;
      toast(`已上传：${baseName(a.path)}`, "ok");
      ctx.reload();
    } catch (e) { toast(e.message, "err", 9000); }
  };

  const sel = h("select", { style: { minWidth: "360px" } }, h("option", { value: "" }, "从素材库选择歌曲 / 视频…"));
  for (const a of songs) {
    sel.append(h("option", { value: a.id, selected: !!song && a.id === song.id },
      `${baseName(a.path)} · ${a.kind === "video" ? "视频（自动抽音轨）" : "音频"} · ${a.size_bytes ? fmtSize(a.size_bytes) : ""} · ${ago(a.created_at)}`));
  }
  if (!songs.length) sel.append(h("option", { value: "" }, "（素材库里还没有音频）"));
  sel.onchange = () => {
    const a = songs.find((x) => x.id === sel.value);
    if (!a) return;
    state.vocalSong = a; ctx.reload();
  };

  const songPreview = h("div", { style: { marginTop: "10px" } });
  if (song) {
    songPreview.append(
      song.kind === "video"
        ? h("video", { src: song.url, controls: true, style: { maxHeight: "200px", borderRadius: "8px", background: "#000" } })
        : h("audio", { src: song.url, controls: true, style: { width: "100%", maxWidth: "520px" } }),
      h("div", { class: "tiny muted", style: { marginTop: "4px" } },
        `${baseName(song.path)}　${fmtSize(song.size_bytes)}`,
        song.kind === "video" ? "　用视频当歌曲时，后端会先用本机 ffmpeg 把音轨抽出来再翻唱" : "",
        "　", h("button", { class: "sm ghost", onClick: () => { state.vocalSong = null; ctx.reload(); } }, "换一首")));
  } else {
    songPreview.append(h("div", { class: "tiny muted" }, "还没选歌：上传一个音频/视频文件，或从素材库里挑一个（视频会自动抽音轨）。"));
  }

  if (modeId === "train") {
    box.append(h("div", { class: "card", style: { marginTop: "16px" } },
      h("h3", null, "① 录一段 / 传几段用来训练的声音"),
      h("div", { class: "tiny muted", style: { marginBottom: "8px" } },
        "训练的是「谁的声音」，不是「唱什么歌」：单人、安静、不混音乐最要紧。建议 3~10 分钟，"
        + "自然说话、念文章都行；多段会按顺序拼成一条再训练（视频里的音轨也能用，会上传到素材库）。"),
      trainSamplePicker(ctx)));
  } else {
    box.append(h("div", { class: "card", style: { marginTop: "16px" } },
      h("h3", null, "① 要翻唱哪一首"),
      h("div", { class: "row wrap", style: { gap: "10px", alignItems: "center" } }, file, sel),
      songPreview));
  }

  // ---------------------------------------------------------- ② 玩法 + 参数
  const modes = (st && st.modes) || [];
  const modeList = h("div");
  for (const m of modes) {
    const eng = vocalEngineOf(m.id);
    const available = !eng || eng.available;
    modeList.append(h("div", {
      class: `engine-opt ${available ? "" : "na"} ${modeId === m.id ? "on" : ""}`,
      style: { marginBottom: "8px" },
      onClick: () => {
        if (!available) { toast((eng.reasons || ["暂不可用"])[0], "warn"); return; }
        state.vocalMode = m.id; ctx.reload();
      },
    },
    h("div", { class: "row", style: { justifyContent: "space-between" } },
      h("b", null, `${m.icon || "🎵"} ${m.label}`),
      h("span", { class: `pill ${available ? "ok" : "err"}` }, available ? "可用" : "不可用")),
    h("div", { class: "tiny muted", style: { marginTop: "4px" } }, m.desc),
    available ? null : h("div", { class: "why" }, (eng.reasons || []).join("；"))));
  }

  const params = h("div");
  if (modeId === "rvc") {
    const vs = (st && st.voices) || [];
    const vsel = h("select", { style: { minWidth: "300px" } });
    if (!vs.length) vsel.append(h("option", null, "本机没有可用的 RVC 音色"));
    for (const v of vs) vsel.append(h("option", { value: v.id, selected: v.id === state.vocalVoice }, v.label));
    vsel.onchange = () => { state.vocalVoice = vsel.value; };
    params.append(
      h("div", { class: "field" }, h("label", null, "换成谁的声音（RVC 音色）"), vsel,
        h("div", { class: "tiny muted", style: { marginTop: "4px" } },
          "清单来自本机 ComfyUI 的 models/TTS/RVC 目录。想加新音色，把 .pth 放进那个目录再点上面的「重新检测」。")),
      vSlider("变调（半音）", state.vocalPitch || 0, { min: -12, max: 12, unit: " 半音", hint: "男声→女声约 +12，女声→男声约 -12", onChange: (v) => { state.vocalPitch = v; } }),
      vSlider("音色相似度", state.vocalIndexRatio ?? 0.75, { min: 0, max: 1, step: 0.05, hint: "越高越像目标音色，越低越保留原唱", onChange: (v) => { state.vocalIndexRatio = v; } }),
      vSlider("咬字保护", state.vocalConsonant ?? 0.25, { min: 0, max: 0.5, step: 0.05, hint: "越高越清楚（原唱咬字保留得多）", onChange: (v) => { state.vocalConsonant = v; } }),
      vSlider("音量包络", state.vocalEnvelope ?? 0.25, { min: 0, max: 1, step: 0.05, hint: "越高越跟原唱的起伏", onChange: (v) => { state.vocalEnvelope = v; } }),
      h("div", { class: "row wrap", style: { gap: "14px" } },
        vSlider("人声音量", state.vocalVocalDb || 0, { min: -12, max: 6, unit: " dB", onChange: (v) => { state.vocalVocalDb = v; } }),
        vSlider("伴奏音量", state.vocalInstDb || 0, { min: -12, max: 6, unit: " dB", onChange: (v) => { state.vocalInstDb = v; } })));
  } else if (modeId === "ace") {
    const ta = h("textarea", { rows: 7, placeholder: "[Verse]\n夜色落在窗台边\n手机亮了一整夜\n[Chorus]\n如果那天我勇敢一点" });
    ta.value = state.vocalLyrics || "";
    ta.oninput = () => { state.vocalLyrics = ta.value; };
    const cnt = h("span", { class: "tiny muted" }, `${(state.vocalLyrics || "").length} 字`);
    ta.addEventListener("input", () => { cnt.textContent = `${ta.value.length} 字`; });

    const tagsIn = h("input", { value: state.vocalTags || "", placeholder: "例如：mandarin pop, warm acoustic guitar, gentle female vocal" });
    tagsIn.oninput = () => { state.vocalTags = tagsIn.value; };

    const topic = h("input", { placeholder: "一句话主题，例如：毕业那天没说出口的喜欢" });
    const topicForTags = h("input", { placeholder: "一句话感觉，例如：深夜 emo、失恋后一个人开车" });

    const lyricsBtn = h("button", { class: "sm", onClick: async () => {
      if (!topic.value.trim()) return toast("先写一句歌曲主题", "warn");
      lyricsBtn.disabled = true; lyricsBtn.textContent = "写词中…";
      try {
        const r = await api.vocalPrompt({
          kind: "lyrics", topic: topic.value, style: state.vocalTags || "", llm: state.vocalLlm,
          style_preset: state.vocalStylePreset || null, imitate: state.vocalImitate || "",
          seconds: state.vocalSeconds || null, project_id: state.projectId || null,
        });
        ta.value = r.text; state.vocalLyrics = r.text; cnt.textContent = `${r.text.length} 字`;
        toast(`歌词已生成（${r.llm?.label || "模型"}）`, "ok", 6000);
      } catch (e) { toast(e.message, "err", 9000); }
      lyricsBtn.disabled = false; lyricsBtn.textContent = "AI 写词";
    } }, "AI 写词");

    const tagsBtn = h("button", { class: "sm", onClick: async () => {
      if (!topicForTags.value.trim()) return toast("先写一句你想要的感觉", "warn");
      tagsBtn.disabled = true; tagsBtn.textContent = "生成中…";
      try {
        const r = await api.vocalPrompt({
          kind: "tags", topic: topicForTags.value, llm: state.vocalLlm,
          style_preset: state.vocalStylePreset || null, imitate: state.vocalImitate || "",
          project_id: state.projectId || null,
        });
        tagsIn.value = r.text; state.vocalTags = r.text;
        toast("风格描述已生成", "ok", 6000);
      } catch (e) { toast(e.message, "err", 9000); }
      tagsBtn.disabled = false; tagsBtn.textContent = "AI 生成风格描述";
    } }, "AI 生成风格描述");

    const refChk = h("input", { type: "checkbox", checked: state.vocalUseRef !== false });
    refChk.onchange = () => { state.vocalUseRef = refChk.checked; };

    const langSel = h("select", null);
    for (const [v, t] of [["zh", "中文"], ["yue", "粤语"], ["en", "英文"], ["ja", "日文"], ["ko", "韩文"]]) {
      langSel.append(h("option", { value: v, selected: (state.vocalLang || "zh") === v }, t));
    }
    langSel.onchange = () => { state.vocalLang = langSel.value; };

    const keySel = h("select", null);
    for (const k of ["C major", "G major", "D major", "A major", "F major", "Bb major", "C minor", "A minor", "E minor", "D minor"]) {
      keySel.append(h("option", { value: k, selected: (state.vocalKey || "C major") === k }, k));
    }
    keySel.onchange = () => { state.vocalKey = keySel.value; };

    // 风格模仿（和音乐页共用同一份清单）+ 写词模型选择
    const styleList = (st && st.styles) || [];
    const presetSel = stylePresetPicker(ctx, styleList, "vocalStylePreset");
    const curPreset = styleList.find((s) => s.id === state.vocalStylePreset) || null;
    const imitateIn = h("input", {
      value: state.vocalImitate || "",
      placeholder: "想模仿谁？例如：像某位歌手的唱腔 / 90 年代粤语歌的感觉",
    });
    imitateIn.oninput = () => { state.vocalImitate = imitateIn.value; };
    const secNow = Math.min(600, Math.max(15, state.vocalSeconds ?? 180));
    state.vocalSeconds = secNow;

    params.append(
      h("div", { class: "field" },
        h("label", null, "AI 模型", h("span", { class: "tiny muted" }, "　写词 / 写风格用哪个大模型（和创作台各自独立）")),
        llmPicker(ctx, { key: "vocalLlm", presetKey: "vocalLlmPreset" })),
      h("div", { class: "field" },
        h("label", null, "风格模仿", h("span", { class: "tiny muted" }, "　曲风 / 歌星唱腔 / 场景情绪，选了就不用自己写英文")),
        h("div", { class: "row wrap", style: { gap: "8px", alignItems: "center" } }, presetSel),
        curPreset ? h("div", { class: "tiny muted", style: { marginTop: "4px" } }, `写作提示：${curPreset.hint}`) : null,
        curPreset && curPreset.tip
          ? h("div", { class: "pill warn", style: { display: "block", marginTop: "6px" } }, curPreset.tip)
          : null,
        h("div", { style: { marginTop: "6px" } }, imitateIn)),
      h("div", { class: "field" }, h("label", null, "歌词"), ta, h("div", { style: { marginTop: "4px" } }, cnt)),
      h("div", { class: "row wrap", style: { gap: "8px", alignItems: "center" } }, topic, lyricsBtn),
      h("div", { class: "field" }, h("label", null, "风格描述（tags）"), tagsIn),
      h("div", { class: "row wrap", style: { gap: "8px", alignItems: "center" } }, topicForTags, tagsBtn),
      h("div", { class: "row wrap", style: { gap: "14px" } },
        vSlider("时长", secNow, { min: 15, max: 600, step: 5, unit: " 秒", hint: "整首歌一般 150-240 秒", onChange: (v) => { state.vocalSeconds = v; } }),
        vSlider("速度 BPM", state.vocalBpm || 96, { min: 60, max: 180, unit: " BPM", onChange: (v) => { state.vocalBpm = v; } })),
      h("div", { class: "row wrap", style: { gap: "14px", alignItems: "center" } },
        h("span", { class: "tiny muted" }, "语言"), langSel,
        h("span", { class: "tiny muted" }, "调性"), keySel,
        h("label", { class: "tiny", style: { display: "inline-flex", gap: "4px", alignItems: "center", cursor: "pointer" } },
          refChk, "用这首歌当参考音色 / 编曲")),
      h("div", { class: "tiny muted" }, "参考开着的时候，模型会沿用原曲的音色和伴奏感，只把唱的部分换成你写的歌词 —— 也就是「同一首歌换唱法 / 换曲风」。"));
  } else if (modeId === "train") {
    const tr = (st && st.train) || {};
    const nameIn = h("input", {
      value: state.vocalTrainName || "",
      placeholder: "给这个音色起个名字，例如：小明 / 我的声音",
    });
    nameIn.oninput = () => { state.vocalTrainName = nameIn.value; };

    const rates = tr.sample_rates || [];
    if (!state.vocalTrainRate || !rates.includes(state.vocalTrainRate)) {
      state.vocalTrainRate = rates.includes("48k") ? "48k" : (rates[0] || "");
    }
    const rateSel = h("select");
    for (const r of rates) rateSel.append(h("option", { value: r, selected: r === state.vocalTrainRate }, `${Number(r.replace("k", ""))} Hz`));
    if (!rates.length) rateSel.append(h("option", null, "本机缺少预训练底模"));
    rateSel.onchange = () => { state.vocalTrainRate = rateSel.value; };

    const epIn = h("input", { type: "number", min: 10, max: 400, step: 10, value: state.vocalTrainEpochs || 50, style: { width: "96px" } });
    epIn.oninput = () => { state.vocalTrainEpochs = Number(epIn.value) || 50; };

    params.append(h("div", null,
      h("div", { class: "field" },
        h("label", null, "音色名字", h("span", { class: "tiny muted" }, "　训练完就按这个名字在音色列表里选")),
        nameIn),
      h("div", { class: "row wrap", style: { gap: "18px", alignItems: "center" } },
        h("label", { class: "tiny" }, "采样率 ", rateSel),
        h("label", { class: "tiny" }, "训练轮数 ", epIn)),
      h("div", { class: "tiny muted", style: { marginTop: "6px" } },
        "采样率越高细节越多，48 Hz 那一档用的是本机自带的预训练底模；轮数越多越像，但训练更久。"
        + "训练期间本机显卡会被占满，跑完自动释放显存。"),
      h("div", { class: "tiny muted", style: { marginTop: "4px" } },
        `产物：${tr.output_dir || "models/TTS/RVC"}\\<名字>_<采样率>.pth（训完自动出现在「换成谁的声音」下拉框里）`),
      !tr.available ? h("div", { class: "pill err", style: { display: "block", marginTop: "6px" } },
        "本机缺少 RVC 预训练底模（models/TTS/pretrained_v2 下的 f0G48k.pth + f0D48k.pth），暂时不能训练") : null));
  } else {
    params.append(h("div", { class: "tiny muted" }, "这条不用额外设置：把歌丢进来，人声和伴奏会分别存成两条素材，方便你拿去混音或当口播 BGM。"));
  }

  box.append(h("div", { class: "card", style: { marginTop: "16px" } },
    h("h3", null, "② 怎么翻"),
    h("div", { class: "row wrap", style: { gap: "14px", alignItems: "flex-start" } },
      h("div", { style: { flex: "1 1 420px", minWidth: "320px" } }, modeList),
      h("div", { style: { flex: "2 1 420px", minWidth: "320px" } }, params))));

  // ---------------------------------------------------------- ③ 生成 + 结果
  const trainMode = modeId === "train";
  const runBtn = h("button", { class: "primary", onClick: async () => {
    if (trainMode) {
      if (!(state.vocalTrainFiles || []).length) return toast("请先录一段、或上传至少一段人声样本", "warn");
      if (!String(state.vocalTrainName || "").trim()) return toast("请先给这个音色起个名字", "warn");
    } else {
      if (!song) return toast("请先选一首歌（上传或从素材库挑）", "warn");
      if (modeId === "rvc" && !state.vocalVoice) return toast("请先选一个 RVC 音色", "warn");
      if (modeId === "ace" && !(state.vocalLyrics || "").trim()) return toast("整首重唱要先有歌词：手填或点「AI 写词」", "warn");
    }
    runBtn.disabled = true; runBtn.textContent = "提交中…";
    try {
      const body = trainMode
        ? {
          mode: "train", project_id: state.projectId || null,
          voice_name: state.vocalTrainName,
          sample_rate: state.vocalTrainRate,
          asset_ids: state.vocalTrainFiles,
          epochs: state.vocalTrainEpochs || 50,
        }
        : {
          mode: modeId, song_asset_id: song.id, project_id: state.projectId || null,
          voice_model: state.vocalVoice,
          pitch: state.vocalPitch || 0, index_ratio: state.vocalIndexRatio ?? 0.75,
          consonant_protection: state.vocalConsonant ?? 0.25, volume_envelope: state.vocalEnvelope ?? 0.25,
          vocal_gain_db: state.vocalVocalDb || 0, inst_gain_db: state.vocalInstDb || 0,
          lyrics: state.vocalLyrics || "", tags: state.vocalTags || "",
          bpm: state.vocalBpm || 96, seconds: state.vocalSeconds || 180,
          style_preset: state.vocalStylePreset || null, imitate: state.vocalImitate || "",
          language: state.vocalLang || "zh", keyscale: state.vocalKey || "C major",
          use_reference: state.vocalUseRef !== false,
        };
      const r = await api.vocalCover(body);
      state.vocalJob = { id: r.job_id, status: "queued", progress: 0, note: r.note, mode: r.mode };
      state.vocalResult = [];
      toast(trainMode
        ? `已提交训练「${r.voice_name}」（${r.sample_rate} · ${r.samples} 段样本）`
        : `已提交到本机翻唱（${r.engine}）`, "ok", 8000);
      ctx.reload();
      watchVocal(ctx, r.job_id, r.note, trainMode ? { isTrain: true, voiceName: r.voice_name } : {});
    } catch (e) { toast(e.message, "err", 12000); }
    runBtn.disabled = false; runBtn.textContent = trainMode ? "开始训练" : "开始翻唱";
  } }, trainMode ? "开始训练" : "开始翻唱");

  const progressBox = h("div");
  if (state.vocalJob) {
    const j = state.vocalJob;
    // 注意用 h(...) 而不是原生 append(...)：原生 append 会把 null 变成字面量 "null" 显示出来
    const lines = [
      h("div", { class: "row wrap", style: { gap: "10px", alignItems: "center" } },
        h("span", { class: `pill ${j.status === "succeeded" ? "ok" : j.status === "failed" ? "err" : "acc"}` },
          j.status === "succeeded" ? "已完成" : j.status === "failed" ? "失败" : "生成中"),
        h("span", { class: "tiny muted" }, `任务 ${j.id}${j.instance ? ` · ${j.instance}` : ""}`)),
      h("div", { class: "progress", style: { marginTop: "8px" } }, h("i", { style: { width: `${j.progress || 0}%` } })),
      j.error ? h("div", { class: "pill err", style: { display: "block", marginTop: "6px" } }, j.error) : null,
      j.note ? h("div", { class: "tiny muted", style: { marginTop: "6px" } }, j.note) : null,
    ].filter(Boolean);
    for (const n of lines) progressBox.append(n);
  }


  const resultBox = h("div");
  for (const a of state.vocalResult || []) {
    resultBox.append(h("div", { style: { marginTop: "10px" } },
      h("audio", { src: a.url, controls: true, style: { width: "100%", maxWidth: "560px" } }),
      h("div", { class: "row wrap", style: { gap: "10px", alignItems: "center", marginTop: "4px" } },
        h("span", { class: "pill ok" }, "无水印 · 未压缩"),
        h("span", { class: "tiny muted" }, `${baseName(a.path)} · ${fmtSize(a.size_bytes)} · ${fmtTime(a.created_at)}`),
        h("a", { class: "sm", href: a.url, download: "" }, "⬇ 下载"),
        h("button", { class: "sm ghost", onClick: () => previewAsset(a.id) }, "预览"),
        h("button", { class: "sm ghost", onClick: () => ctx.go(`/assets`) }, "去素材库")),
      lrcRow(a)));
  }

  box.append(h("div", { class: "card", style: { marginTop: "16px" } },
    h("h3", null, trainMode ? "③ 开始训练" : "③ 出片"),
    h("div", { class: "row wrap", style: { gap: "10px", alignItems: "center" } },
      runBtn,
      h("span", { class: "tiny muted" }, trainMode
        ? `本次用：${(state.vocalTrainFiles || []).length} 段样本 · 训完自动出现在音色列表`
        : (song ? `本次用：${baseName(song.path)}` : "还没选歌"))),
    progressBox, resultBox));

  return box;
}

/** 能当「参考音乐」用的素材：音频直接可用，视频会由后端自动抽音轨 */
/**
 * 「风格模仿」选择器：曲风 / 歌星唱腔 / 场景情绪三组，清单来自 /api/music/status 的 styles。
 * 选了之后由后端把预置的英文风格串拼到用户自己写的风格前面；写词时也会带上对应的中文提示，
 * 让歌词的用词、句式、押韵跟着这个风格走。
 */
function stylePresetPicker(ctx, list, valueKey) {
  const sel = h("select", { style: { minWidth: "260px" } });
  sel.append(h("option", { value: "" }, "不指定（只用我自己写的风格）"));
  const groups = [...new Set((list || []).map((s) => s.group))];
  for (const g of groups) {
    const og = h("optgroup", { label: g });
    for (const s of (list || []).filter((x) => x.group === g)) {
      og.append(h("option", { value: s.id, selected: state[valueKey] === s.id }, s.label));
    }
    sel.append(og);
  }
  sel.onchange = () => { state[valueKey] = sel.value; ctx.reload(); };
  return sel;
}

/**
 * 音频卡片上的「同步歌词」一行：出歌 / 重唱完成后，后端会按成品时长自动生成
 * .lrc / .srt / .ass 三份标准歌词文件并挂到素材的 meta.subtitle 上（见 src/jobs.js 的 syncLyrics）。
 * 没有这份 meta（老的产物、纯音乐）就返回 null，什么都不显示。
 */
/** 歌词对齐的可信度（老产物没有这个字段，按 mode / aligned_by 反推） */
function subtitleConf(s) {
  const x = s || {};
  return x.confidence || (x.aligned_by === "stem" ? "high" : x.mode === "speech" ? "medium" : "low");
}

function lrcRow(a) {
  const s = a && a.meta && a.meta.subtitle;
  if (!s || !s.files) return null;
  const f = s.files;
  // 对齐可信度：拿分离出来的人声当标尺最准；只在混音上估、或干脆按字数均分，都可能偏
  const conf = subtitleConf(s);
  const quality = conf === "high" ? "对齐可靠（按真人声标尺）"
    : conf === "medium" ? "混音估算，可能偏差几秒"
      : "按字数均分，仅供参考";
  return h("div", { style: { display: "flex", flexDirection: "column", gap: "4px", marginTop: "4px" } },
    h("div", { class: "row wrap", style: { gap: "10px", alignItems: "center" } },
      h("span", { class: "pill acc" }, `同步歌词 ${s.count} 行 · ${s.mode_label}`),
      f.lrc ? h("a", { class: "sm", href: f.lrc.url, download: f.lrc.name }, "⬇ .lrc 歌词") : null,
      f.srt ? h("a", { class: "sm", href: f.srt.url, download: f.srt.name }, "⬇ .srt 字幕") : null,
      f.ass ? h("a", { class: "sm", href: f.ass.url, download: f.ass.name }, "⬇ .ass 烧录用") : null,
      a.kind === "audio"
        ? h("button", {
            class: "sm", title: "用现在的对齐算法把同一份歌词重算一遍，直接覆盖这三份字幕（不会多出新文件）",
            onClick: () => realignLyrics(a),
          }, "重新对齐")
        : null),
    h("span", { class: "tiny muted" }, s.speech_note ? `${quality} · ${s.speech_note}` : quality));
}

/**
 * 歌词重新对齐：出歌时自动算的那版如果偏了，点一下就用现在的算法（先分离人声再切分）重算，
 * 直接覆盖原来的 .lrc / .srt / .ass，歌词文本不改、素材库里也不会多出一串同名字幕。
 */
async function realignLyrics(a) {
  try {
    toast("正在重新对齐歌词（本机语音识别逐字对齐，约 20 秒）…", "ok", 8000);
    const r = await api.realignLyrics(a.id);
    state.lrcManifest = null;            // 行数 / 可信度会变，清单要重算
    toast(r.note || `已重新对齐 ${r.count} 行`, "ok", 9000);
    refresh();
  } catch (e) {
    toast(`重新对齐失败：${e.message}`, "err", 9000);
  }
}

function musicAssets(kinds = ["audio", "video"]) {
  return (state.assets || []).filter((a) => kinds.includes(a.kind));
}

function musicEngineOf(modeId) {
  const st = state.musicStatus || {};
  return (st.engines || []).find((e) => e.id === modeId) || null;
}

async function loadMusic(ctx) {
  if (state.musicLoading) return;
  state.musicLoading = true;
  try {
    state.musicStatus = await api.musicStatus();
  } catch (e) {
    state.musicStatus = { error: e.message, engines: [], modes: [] };
  } finally {
    state.musicLoading = false;
    if (ctx && ctx.reload) ctx.reload();
  }
}

/** AI 音乐页：状态条 + ① 怎么创作（选引擎 + 写字句）+ ② 出歌 + ③ 音乐后期 */
function music(ctx) {
  if (state.musicStatus === null || state.musicStatus === undefined) loadMusic(ctx);
  if (state.lrcManifest === null || state.lrcManifest === undefined) loadLyricManifest(ctx);
  if (!state.llms) loadLlms().then(() => ctx && ctx.reload && ctx.reload()).catch(() => {});
  const st = state.musicStatus;
  const box = h("div");

  // ---------------------------------------------------------- 状态条
  const statusCard = h("div", { class: "card" });
  if (!st) {
    statusCard.append(loadingNode("正在检查本机音乐环境…"));
  } else if (st.error) {
    statusCard.append(h("div", { class: "pill err" }, `本机音乐环境读取失败：${st.error}`));
  } else {
    const engines = st.engines || [];
    const okCount = engines.filter((e) => e.available).length;
    statusCard.append(
      h("div", { class: "row wrap", style: { gap: "10px", alignItems: "center" } },
        h("h3", { style: { margin: "0" } }, "🎵 AI 音乐（跑在本机）"),
        h("span", { class: `pill ${st.online ? "ok" : "err"}` }, st.online ? "本机 ComfyUI 在线" : "本机 ComfyUI 离线"),
        h("span", { class: "pill acc" }, `${st.machine || "本机"}`),
        h("span", { class: "tiny muted" }, `${st.url || ""}${st.nodes ? ` · ${st.nodes} 个节点` : ""}`),
        h("span", { class: "tiny muted" }, `可用引擎 ${okCount}/${engines.length}`),
        h("button", { class: "sm ghost", onClick: () => { state.musicStatus = null; loadMusic(ctx); } }, "重新检测")),
      h("div", { class: "tiny muted", style: { marginTop: "6px" } },
        "音乐权重（MiniMax Music 3 / YuE2 / ACE-Step）只在你这台机器上，所以整条链路都在本机跑："
        + "不占用 192.168.0.222 的多卡资源，也不用等别人的任务排队。生成的曲子会直接进素材库，"
        + "可以当 BGM 垫到成片上，也能在这里裁剪、接长、变速、统一响度。"));
    for (const e of engines) {
      if (e.available) continue;
      const mode = (st.modes || []).find((m) => m.id === e.id);
      statusCard.append(h("div", { class: "pill warn", style: { display: "block", marginTop: "6px" } },
        `${mode?.label || e.id} 暂不可用：${(e.reasons || []).join("；")}`));
    }
  }
  box.append(statusCard);

  // ---------------------------------------------------------- ② 选引擎
  const modes = (st && st.modes) || [];
  if (modes.length && !modes.some((m) => m.id === state.musicMode)) state.musicMode = modes[0].id;
  const modeId = state.musicMode || "mm3";
  const engine = musicEngineOf(modeId);
  const modeInfo = modes.find((m) => m.id === modeId) || null;
  const [secMin, secMax] = (modeInfo && modeInfo.seconds) || [10, 300];

  const modeList = h("div");
  for (const m of modes) {
    const en = musicEngineOf(m.id);
    const on = m.id === modeId;
    modeList.append(h("div", {
      class: `pick ${on ? "on" : ""}`, style: { cursor: "pointer", marginBottom: "8px" },
      onClick: () => { state.musicMode = m.id; state.musicSeconds = null; ctx.reload(); },
    },
      h("div", { class: "row wrap", style: { gap: "8px", alignItems: "center" } },
        h("b", null, `${m.icon || "🎵"} ${m.label}`),
        h("span", { class: `pill ${en?.available ? "ok" : "err"}` }, en?.available ? "可用" : "不可用")),
      h("div", { class: "tiny muted", style: { marginTop: "4px" } }, m.desc),
      en?.available ? h("div", { class: "tiny muted", style: { marginTop: "4px" } },
        `预计耗时 ≈ 成品秒数 × ${en.eta_per_second || m.etaPerSecond || 2}`) : null));
  }

  // ---------------------------------------------------------- ① 写需求
  const params = h("div");
  const topic = h("input", { type: "text", placeholder: "一句话主题，例如：毕业那天没说出口的喜欢", value: state.musicTopic || "" });
  topic.oninput = () => { state.musicTopic = topic.value; };

  const styleIn = h("textarea", {
    rows: 3,
    placeholder: modeId === "mm3"
      ? "英文风格描述（caption），例如：Global Metadata: Dreamy synth-pop, 112 BPM…\n也可以点下面的按钮让 AI 写"
      : "英文风格描述，例如：mandopop ballad, 86 BPM, warm analog, piano and strings, expressive female vocal",
  }, state.musicStyle || "");
  styleIn.oninput = () => { state.musicStyle = styleIn.value; };

  const ta = h("textarea", { rows: 8, placeholder: "[verse]\n写第一段主歌…\n\n[chorus]\n写副歌（高潮）…" }, state.musicLyrics || "");
  const cnt = h("span", { class: "tiny muted" }, `${(state.musicLyrics || "").length} 字`);
  ta.oninput = () => { state.musicLyrics = ta.value; cnt.textContent = `${ta.value.length} 字`; };

  const writeWordBtn = h("button", { class: "sm ghost", onClick: async () => {
    const t = (state.musicTopic || "").trim();
    if (!t) return toast("先写一句主题，例如：毕业那天没说出口的喜欢", "warn");
    writeWordBtn.disabled = true; writeWordBtn.textContent = "写词中…";
    try {
      const r = await api.musicPrompt({
        kind: "lyrics", topic: t, style: state.musicStyle || "", llm: state.musicLlm,
        style_preset: state.musicStylePreset || null, imitate: state.musicImitate || "",
        seconds: state.musicSeconds || null, project_id: state.projectId || null,
      });
      state.musicLyrics = r.text; ta.value = r.text; cnt.textContent = `${r.text.length} 字`;
      toast(`歌词已生成（${r.llm?.label || r.llm?.model || "本地模型"}）`, "ok", 5000);
    } catch (e) { toast(e.message, "err", 12000); }
    writeWordBtn.disabled = false; writeWordBtn.textContent = "AI 写词";
  } }, "AI 写词");

  const writeStyleBtn = h("button", { class: "sm ghost", onClick: async () => {
    const t = (state.musicTopic || "").trim();
    if (!t) return toast("先写一句你想要的感觉，例如：深夜 emo、一个人开车", "warn");
    writeStyleBtn.disabled = true; writeStyleBtn.textContent = "生成中…";
    try {
      const kind = modeId === "mm3" ? "caption" : "style";
      const r = await api.musicPrompt({
        kind, topic: t, llm: state.musicLlm,
        instrumental: !(state.musicLyrics || "").trim() && modeId === "mm3",
        style_preset: state.musicStylePreset || null, imitate: state.musicImitate || "",
        project_id: state.projectId || null,
      });
      state.musicStyle = r.text; styleIn.value = r.text;
      toast(kind === "caption" ? "风格描述（caption）已生成" : "风格标签已生成", "ok", 5000);
    } catch (e) { toast(e.message, "err", 12000); }
    writeStyleBtn.disabled = false; writeStyleBtn.textContent = "AI 写风格";
  } }, "AI 写风格");
  if (modeId === "mm3") writeStyleBtn.textContent = "AI 写 caption";

  // 风格模仿：选了之后后端会把预置英文风格串拼在用户自己写的风格前面，写词时也会带上中文提示
  const styleList = (st && st.styles) || [];
  const presetSel = stylePresetPicker(ctx, styleList, "musicStylePreset");
  const curPreset = styleList.find((s) => s.id === state.musicStylePreset) || null;
  const imitateIn = h("input", {
    value: state.musicImitate || "",
    placeholder: "想模仿谁？例如：像周杰伦那种中国风 / 90 年代粤语歌的感觉 / 某位歌手的唱腔",
  });
  imitateIn.oninput = () => { state.musicImitate = imitateIn.value; };
  const secondsNow = Math.min(secMax, Math.max(secMin, state.musicSeconds ?? (modeInfo?.defaultSeconds || 180)));
  state.musicSeconds = secondsNow;

  const refAssets = musicAssets(["audio", "video"]);
  const refSel = h("select", null);
  refSel.append(h("option", { value: "" }, "（锁旋律必须有参考音乐）"));
  for (const a of refAssets.slice(0, 200)) {
    refSel.append(h("option", { value: a.id, selected: (state.musicSong || {}).id === a.id }, `${baseName(a.path)} · ${fmtSize(a.size_bytes)}`));
  }
  refSel.onchange = () => {
    state.musicSong = refAssets.find((a) => a.id === refSel.value) || null;
  };

  // 参考音乐也可以直接从本机传：上传后登记成素材并自动选中（视频会由后端抽音轨）
  const refFile = h("input", { type: "file", accept: "audio/*,video/*" });
  refFile.onchange = async () => {
    const f = refFile.files && refFile.files[0];
    if (!f) return;
    try {
      refFile.disabled = true;
      const a = await api.upload(f, { projectId: state.projectId || "" });
      state.assets = [a, ...(state.assets || [])];
      state.musicSong = a;
      toast(`已上传参考音乐：${baseName(a.path)}`, "ok");
      ctx.reload();
    } catch (e) { toast(e.message, "err", 9000); }
    finally { refFile.disabled = false; }
  };

  const adv = h("details", { style: { marginTop: "6px" } },
    h("summary", { class: "tiny muted", style: { cursor: "pointer" } }, "高级（生成步数 / 随机种子）"),
    h("div", { class: "row wrap", style: { gap: "14px", marginTop: "8px" } },
      vSlider("生成步数", state.musicSteps ?? 0, { min: 0, max: 60, step: 1, hint: "0 = 用这类引擎的默认值", onChange: (v) => { state.musicSteps = v; } }),
      h("div", { class: "field" }, h("label", null, "随机种子（-1 = 每次随机）"),
        h("input", {
          type: "number", value: state.musicSeed ?? -1, style: { width: "160px" },
          oninput: (e) => { state.musicSeed = Number(e.target.value); },
        }))));

  params.append(
    h("div", { class: "field" }, h("label", null, "想要什么歌（一句话）"), topic),
    h("div", { class: "row wrap", style: { gap: "8px", alignItems: "center", marginTop: "6px" } },
      writeWordBtn, writeStyleBtn),
    h("div", { class: "field", style: { marginTop: "10px" } },
      h("label", null, "AI 模型", h("span", { class: "tiny muted" }, "　写词 / 写风格用哪个大模型（和创作台各自独立）")),
      llmPicker(ctx, { key: "musicLlm", presetKey: "musicLlmPreset" })),
    h("div", { class: "field", style: { marginTop: "10px" } },
      h("label", null, "风格模仿", h("span", { class: "tiny muted" }, "　曲风 / 歌星唱腔 / 场景情绪，选了就不用自己写英文")),
      h("div", { class: "row wrap", style: { gap: "8px", alignItems: "center" } }, presetSel),
      curPreset ? h("div", { class: "tiny muted", style: { marginTop: "4px" } }, `写作提示：${curPreset.hint}`) : null,
      curPreset ? h("div", { class: "tiny muted", style: { marginTop: "2px" } }, `将附加英文风格串：${curPreset.tags}`) : null,
      curPreset && (curPreset.bpm || curPreset.timesignature)
        ? h("div", { class: "tiny muted", style: { marginTop: "2px" } },
          `节奏：${curPreset.bpm ? `${curPreset.bpm} BPM` : ""}${curPreset.bpm && curPreset.timesignature ? " · " : ""}${curPreset.timesignature ? `${curPreset.timesignature}/4 拍` : ""}`)
        : null,
      curPreset && curPreset.tip
        ? h("div", { class: "pill warn", style: { display: "block", marginTop: "6px" } }, curPreset.tip)
        : null,
      h("div", { style: { marginTop: "6px" } }, imitateIn)),
    h("div", { class: "field", style: { marginTop: "10px" } },
      h("label", null, "风格描述", h("span", { class: "tiny muted" }, "　可以留空；填了就拼在风格模仿后面，写英文效果最好")), styleIn),
    h("div", { class: "field" },
      h("label", null, "歌词", h("span", { class: "tiny muted" }, modeId === "mm3" ? "　留空 = 直接出纯音乐（BGM）" : "　必填")), ta,
      h("div", { style: { marginTop: "4px" } }, cnt)),
    h("div", { class: "row wrap", style: { gap: "14px" } },
      vSlider("成品时长", secondsNow, {
        min: secMin, max: secMax, step: secMin >= 15 ? 5 : 1, unit: " 秒",
        hint: modeId === "mm3" ? "MiniMax 给的是上界，偶尔会提前收尾；不够长可以在 ③ 里接长" : "",
        onChange: (v) => { state.musicSeconds = v; },
      })),
    ...(modeId === "lock"
      ? [h("div", { class: "field" },
        h("label", null, "参考音乐（会锁住它的旋律）", h("span", { class: "tiny muted" }, "　从素材库选，或直接上传本地音频 / 视频")),
        h("div", { class: "row wrap", style: { gap: "10px", alignItems: "center" } }, refSel, refFile),
        state.musicSong
          ? h("div", { style: { marginTop: "8px" } },
            h("audio", { src: state.musicSong.url, controls: true, style: { width: "100%", maxWidth: "520px" } }),
            h("div", { class: "tiny muted", style: { marginTop: "4px" } },
              `${baseName(state.musicSong.path)}　会先用 SheetSage2 把这段音乐抽成谱子，再用同一段旋律配你的新词重唱`))
          : h("div", { class: "tiny muted", style: { marginTop: "4px" } }, "还没选参考音乐：直接上传一个，或从上面的下拉框里挑。"))
      ]
      : []),
    adv,
    h("div", { class: "tiny muted", style: { marginTop: "6px" } },
      modeId === "lock"
        ? "锁旋律：先把参考音乐的旋律抽成谱子（SheetSage2），再用同一段旋律配你的新词、换风格重新唱一版。"
        : modeId === "mm3"
          ? "MiniMax Music 3 一次把人声和伴奏都写出来，质量最好但最慢：大约要等「成品秒数 × 3」。它给的是时长上界，偶尔会提前收尾；不够长可以在 ③ 音乐后期里接长。"
          : modeId === "yue"
            ? "YuE2 按你的歌词演唱，风格描述越具体越像你要的味道。"
            : "ACE-Step 1.5 最省显存、最快，中文歌尤其稳。"),
  );

  box.append(h("div", { class: "card", style: { marginTop: "16px" } },
    h("h3", null, "① 怎么创作"),
    h("div", { class: "row wrap", style: { gap: "14px", alignItems: "flex-start" } },
      h("div", { style: { flex: "1 1 420px", minWidth: "320px" } }, modeList),
      h("div", { style: { flex: "2 1 460px", minWidth: "320px" } }, params))));

  // ---------------------------------------------------------- ② 出歌
  const runLabel = { mm3: "开始出歌", yue: "开始出歌", lock: "开始改编", ace: "开始出歌" }[modeId] || "开始出歌";
  const runBtn = h("button", { class: "primary", onClick: async () => {
    if (!(state.musicStyle || "").trim() && !(state.musicLyrics || "").trim()) {
      return toast("请至少写一句风格描述，或者填一段歌词", "warn");
    }
    if ((modeId === "yue" || modeId === "lock" || modeId === "ace") && !(state.musicLyrics || "").trim()) {
      return toast("这条引擎要先有歌词：手填，或点「AI 写词」", "warn");
    }
    if (modeId === "lock" && !state.musicSong) return toast("锁旋律改编要先选一段参考音乐", "warn");
    runBtn.disabled = true; runBtn.textContent = "提交中…";
    try {
      const body = {
        mode: modeId, project_id: state.projectId || null,
        style: state.musicStyle || "", lyrics: state.musicLyrics || "",
        style_preset: state.musicStylePreset || null, imitate: state.musicImitate || "",
        seconds: state.musicSeconds ?? secondsNow,
        song_asset_id: state.musicSong ? state.musicSong.id : null,
        seed: state.musicSeed ?? -1,
      };
      if (state.musicSteps) body.steps = state.musicSteps;
      const r = await api.musicCreate(body);
      state.musicJob = { id: r.job_id, status: "queued", progress: 0, note: r.note, mode: r.mode, eta: r.eta_seconds };
      state.musicResult = [];
      toast(`已提交到本机出歌（${r.engine}，预计 ${Math.round((r.eta_seconds || 0) / 60 * 10) / 10} 分钟内）`, "ok", 8000);
      ctx.reload();
      watchMusic(ctx, r.job_id, r.note);
    } catch (e) { toast(e.message, "err", 12000); }
    runBtn.disabled = false; runBtn.textContent = runLabel;
  } }, runLabel);

  const progressBox = h("div");
  if (state.musicJob) {
    const j = state.musicJob;
    const lines = [
      h("div", { class: "row wrap", style: { gap: "10px", alignItems: "center" } },
        h("span", { class: `pill ${j.status === "succeeded" ? "ok" : j.status === "failed" ? "err" : "acc"}` },
          j.status === "succeeded" ? "已完成" : j.status === "failed" ? "失败" : "生成中"),
        h("span", { class: "tiny muted" }, `任务 ${j.id}${j.instance ? ` · ${j.instance}` : ""}${j.eta ? ` · 预计 ${j.eta} 秒` : ""}`)),
      h("div", { class: "progress", style: { marginTop: "8px" } }, h("i", { style: { width: `${j.progress || 0}%` } })),
      j.error ? h("div", { class: "pill err", style: { display: "block", marginTop: "6px" } }, j.error) : null,
      j.note ? h("div", { class: "tiny muted", style: { marginTop: "6px" } }, j.note) : null,
    ].filter(Boolean);
    for (const n of lines) progressBox.append(n);
  }

  const resultBox = h("div");
  for (const a of state.musicResult || []) {
    resultBox.append(h("div", { style: { marginTop: "10px" } },
      h("audio", { src: a.url, controls: true, style: { width: "100%", maxWidth: "560px" } }),
      h("div", { class: "row wrap", style: { gap: "10px", alignItems: "center", marginTop: "4px" } },
        h("span", { class: "pill ok" }, "无水印 · 未压缩"),
        h("span", { class: "tiny muted" }, `${baseName(a.path)} · ${fmtSize(a.size_bytes)} · ${fmtTime(a.created_at)}`),
        h("a", { class: "sm", href: a.url, download: "" }, "⬇ 下载"),
        h("button", { class: "sm ghost", onClick: () => previewAsset(a.id) }, "预览"),
        h("button", { class: "sm ghost", onClick: () => ctx.go(`/assets`) }, "去素材库")),
      lrcRow(a)));
  }

  box.append(h("div", { class: "card", style: { marginTop: "16px" } },
    h("h3", null, "② 出歌"),
    h("div", { class: "row wrap", style: { gap: "10px", alignItems: "center" } },
      runBtn,
      h("span", { class: "tiny muted" }, engine?.available ? `本次用：${modeInfo?.label || modeId}` : "这个引擎现在不可用")),
    h("div", { class: "tiny muted", style: { marginTop: "6px" } },
      "填了歌词的话，出歌完成后会自动生成一份跟歌曲同步的歌词文件（.lrc 歌词 / .srt 字幕 / .ass 烧录用），" +
      "先在本机分离出纯人声，再用本机 Whisper 逐字对齐（间奏不会被算成演唱时间）；" +
      "后面把歌配到画面上时，歌词、歌曲、画面就是对齐的。纯音乐不生成。"),
    progressBox, resultBox));


  // ---------------------------------------------------------- ③ 音乐后期
  const editIds = state.musicEditIds || [];
  const audios = musicAssets(["audio", "video"]);
  const pickList = h("div", { style: { maxHeight: "230px", overflow: "auto", display: "flex", flexDirection: "column", gap: "6px" } });
  if (!audios.length) pickList.append(h("div", { class: "tiny muted" }, "素材库里还没有音频：先在上面出一首，或到素材库上传一段。"));
  for (const a of audios.slice(0, 80)) {
    const idx = editIds.indexOf(a.id);
    pickList.append(h("button", {
      class: `sm ${idx >= 0 ? "primary" : "ghost"}`,
      style: { textAlign: "left" },
      onClick: () => {
        state.musicEditIds = idx >= 0 ? editIds.filter((x) => x !== a.id) : [...editIds, a.id];
        ctx.reload();
      },
    }, `${idx >= 0 ? `${idx + 1}. ` : ""}${baseName(a.path)} · ${a.kind === "video" ? "视频（抽音轨）· " : ""}${fmtSize(a.size_bytes)}`));
  }

  const normChk = h("input", { type: "checkbox", checked: state.musicNormalize !== false });
  normChk.onchange = () => { state.musicNormalize = normChk.checked; };

  const editBtn = h("button", { class: "primary", onClick: async () => {
    if (!editIds.length) return toast("请先选至少一段音乐（点击顺序就是拼接顺序）", "warn");
    editBtn.disabled = true; editBtn.textContent = "处理中…";
    try {
      const r = await api.musicEdit({
        asset_ids: editIds, project_id: state.projectId || null,
        trim_start: state.musicTrimStart || 0, trim_seconds: state.musicTrimSeconds || null,
        speed: state.musicSpeed || 1, target_seconds: state.musicTarget || null,
        fade_in: state.musicFadeIn || 0, fade_out: state.musicFadeOut || 0,
        normalize: state.musicNormalize !== false, loudness: state.musicLoudness || "short_video",
      });
      state.musicEditResult = r.asset || null;
      if (r.asset) state.assets = [r.asset, ...(state.assets || [])];
      toast(`处理完成：${r.plan}`, "ok", 8000);
      ctx.reload();
    } catch (e) { toast(e.message, "err", 12000); }
    editBtn.disabled = false; editBtn.textContent = "开始处理";
  } }, "开始处理");

  const editResult = h("div");
  if (state.musicEditResult) {
    const a = state.musicEditResult;
    editResult.append(h("div", { style: { marginTop: "10px" } },
      h("audio", { src: a.url, controls: true, style: { width: "100%", maxWidth: "560px" } }),
      h("div", { class: "row wrap", style: { gap: "10px", alignItems: "center", marginTop: "4px" } },
        h("span", { class: "pill ok" }, "本机处理 · 未压缩"),
        h("span", { class: "tiny muted" }, `${baseName(a.path)} · ${fmtSize(a.size_bytes)}${a.duration_ms ? ` · ${fmtDur(a.duration_ms)}` : ""}`),
        h("a", { class: "sm", href: a.url, download: "" }, "⬇ 下载"),
        h("button", { class: "sm ghost", onClick: () => ctx.go(`/assets`) }, "去素材库"))));
  }

  box.append(h("div", { class: "card", style: { marginTop: "16px" } },
    h("h3", null, "③ 音乐后期（本机 ffmpeg，不占显卡）"),
    h("div", { class: "tiny muted", style: { marginBottom: "8px" } },
      "把生成的 BGM 裁剪、接长到视频长度、变速、拼接，或者把音量统一到 -14 LUFS（抖音通行标准）。"
      + "多选素材时，点击顺序就是拼接顺序；选到视频会自动抽音轨。"),
    h("div", { class: "row wrap", style: { gap: "14px", alignItems: "flex-start" } },
      h("div", { style: { flex: "1 1 380px", minWidth: "300px" } },
        h("div", { class: "tiny muted", style: { marginBottom: "6px" } }, `已选 ${editIds.length} 段`),
        pickList),
      h("div", { style: { flex: "2 1 440px", minWidth: "320px" } },
        h("div", { class: "row wrap", style: { gap: "14px" } },
          vSlider("裁剪起点", state.musicTrimStart || 0, { min: 0, max: 300, step: 1, unit: " 秒", onChange: (v) => { state.musicTrimStart = v; } }),
          vSlider("只留多长", state.musicTrimSeconds || 0, { min: 0, max: 600, step: 5, unit: " 秒", hint: "0 = 不裁剪", onChange: (v) => { state.musicTrimSeconds = v; } })),
        h("div", { class: "row wrap", style: { gap: "14px" } },
          vSlider("变速（不变调）", state.musicSpeed || 1, { min: 0.5, max: 2, step: 0.05, unit: "x", onChange: (v) => { state.musicSpeed = v; } }),
          vSlider("接长到", state.musicTarget || 0, { min: 0, max: 1800, step: 15, unit: " 秒", hint: "0 = 不接长；不够长会自动循环", onChange: (v) => { state.musicTarget = v; } })),
        h("div", { class: "row wrap", style: { gap: "14px" } },
          vSlider("淡入", state.musicFadeIn || 0, { min: 0, max: 10, step: 0.5, unit: " 秒", onChange: (v) => { state.musicFadeIn = v; } }),
          vSlider("淡出", state.musicFadeOut || 0, { min: 0, max: 10, step: 0.5, unit: " 秒", onChange: (v) => { state.musicFadeOut = v; } })),
        h("div", { class: "row wrap", style: { gap: "14px", alignItems: "center", marginTop: "4px" } },
          h("label", { class: "tiny", style: { display: "inline-flex", gap: "4px", alignItems: "center", cursor: "pointer" } },
            normChk, "响度归一（-14 LUFS，抖音高清发布不忽大忽小）"),
          editBtn),
        editResult))));

  // ---------------------------------------------------------- ④ 歌词下载清单
  box.append(lyricManifestCard(ctx));


  return box;
}

/** 拉一次歌词清单（懒加载：进音乐页才拉，拿到就重画那块卡片） */
async function loadLyricManifest(ctx, force = false) {
  if (state.lrcManifestLoading) return;
  if (state.lrcManifest && !force) return;
  state.lrcManifestLoading = true;
  try { state.lrcManifest = await api.lyricsManifest(); state.lrcManifestSel = []; }
  catch (e) { state.lrcManifest = { error: e.message, rows: [], count: 0, file_count: 0 }; }
  finally {
    state.lrcManifestLoading = false;
    if (ctx && ctx.reload) ctx.reload();
  }
}

/** 把清单 CSV 存成文件：走带 token 的 fetch 再落 Blob（<a href> 直连在开启鉴权时会 401） */
async function downloadLyricsCsv() {
  try {
    const token = getToken();
    const res = await fetch("/api/lyrics/manifest?format=csv", { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    const a = h("a", { href: url, download: "歌词下载清单.csv" });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) { toast(`下载清单失败：${e.message}`, "err", 9000); }
}

/**
 * ④ 歌词下载清单：所有出过的歌 + 「配音」页生成过的字幕，汇总成一张可下载的表。
 *
 * 以前「下载歌词」这件事散在每一行素材里，歌一多就得一首首翻；这里一次给全：
 * 每首单条下载 .lrc（播放器歌词）/ .srt（剪映与视频播放器通用）/ .ass（烧录用），
 * 也能一键打包成 zip —— 后端按项目分好目录，里面另附「歌词清单.csv」和纯文本歌词。
 */
function lyricManifestCard(ctx) {
  const m = state.lrcManifest;
  const card = h("div", { class: "card", style: { marginTop: "16px" } },
    h("h3", null, "④ 歌词下载清单"),
    h("div", { class: "tiny muted", style: { marginBottom: "8px" } },
      "把出过的歌、以及「配音」页生成过的字幕汇总成一张表：每首都能单独下载 .lrc（播放器歌词）/ "
      + ".srt（剪映与视频播放器通用）/ .ass（烧录用），也可以一键打包成一个 zip —— "
      + "解压后按项目分好目录，里面还有一份「歌词清单.csv」可以直接用 Excel 打开。"
      + "不要的可以随时删：勾选后「🗑 删除选中」，或点行尾的「🗑 删除」—— "
      + "默认只删 .lrc / .srt / .ass 三份字幕，歌曲 / 视频本身保留（需要连源素材一起删时才勾那个选项）。"));
  if (!m) {
    card.append(loadingNode("正在汇总歌词清单…"));
    return card;
  }
  if (m.error) {
    card.append(
      h("div", { class: "pill err" }, `读取歌词清单失败：${m.error}`),
      h("div", { style: { marginTop: "8px" } },
        h("button", { class: "sm", onClick: () => loadLyricManifest(ctx, true) }, "重试")));
    return card;
  }
  if (!m.count) {
    card.append(h("div", { class: "tiny muted" },
      "还没有带同步歌词的素材：在上面出一首歌（填了歌词就会自动生成跟歌同步的 .lrc / .srt / .ass），"
      + "或到「配音」页用「歌词 → 字幕」给一段音视频生成一份。"));
    return card;
  }

  // 对齐可信度：新产物直接读字段，老产物按对齐方式反推（口径与后端一致）
  const confOf = (x) => x.confidence || (x.aligned_by === "stem" ? "high" : x.mode === "speech" ? "medium" : "low");
  const confPill = (x) => {
    // 磁盘上直接扫出来的字幕没有对齐信息，别按「按字数均分」糊弄过去
    if (!x.confidence && !x.aligned_by && !x.mode) return h("span", { class: "pill warn" }, "对齐未知");
    const c = confOf(x);
    return h("span", { class: `pill ${c === "high" ? "ok" : c === "medium" ? "acc" : "warn"}` },
      c === "high" ? "对齐可靠" : c === "medium" ? "混音估算" : "按字数均分");
  };

  const listBox = h("div", { style: { maxHeight: "420px", overflow: "auto", display: "flex", flexDirection: "column", gap: "6px", marginTop: "10px" } });
  const shown = () => {
    const q = (state.lrcManifestQuery || "").trim().toLowerCase();
    return (m.rows || []).filter((r) => !q || `${r.media_name} ${r.project_title || ""}`.toLowerCase().includes(q));
  };

  const render = () => {
    clear(listBox);
    const rows = shown();
    if (!rows.length) {
      listBox.append(h("div", { class: "tiny muted" }, "没有匹配的歌曲，换个关键词试试"));
      return;
    }
    for (const r of rows) {
      const on = (state.lrcManifestSel || []).includes(r.key);
      listBox.append(h("div", { class: "pick", style: { padding: "8px 10px", background: on ? "#eef4ff" : undefined } },
        h("div", { class: "row wrap", style: { gap: "8px", alignItems: "center" } },
          h("input", { type: "checkbox", checked: on, title: "勾选后可批量删除",
            onChange: () => toggleRow(r.key) }),
          h("b", null, r.media_name),
          r.project_title ? h("span", { class: "tiny muted" }, r.project_title) : null,
          h("span", { class: "tiny muted" }, `歌词 ${r.lines || "-"} 行`),
          r.align.mode_label ? h("span", { class: "tiny muted" }, r.align.mode_label) : null,
          confPill(r.align),
          h("span", { class: "tiny muted" }, `时长 ${fmtDur(r.duration_ms)}`)),
        h("div", { class: "row wrap", style: { gap: "8px", alignItems: "center", marginTop: "4px" } },
          r.files.lrc ? h("a", { class: "sm", href: r.files.lrc.url, download: r.files.lrc.name }, "⬇ .lrc 歌词") : null,
          r.files.srt ? h("a", { class: "sm", href: r.files.srt.url, download: r.files.srt.name }, "⬇ .srt 字幕") : null,
          r.files.ass ? h("a", { class: "sm", href: r.files.ass.url, download: r.files.ass.name }, "⬇ .ass 烧录用") : null,
          r.media_ok && r.asset_id ? h("button", { class: "sm ghost", onClick: () => previewAsset(r.asset_id) }, "预览") : null,
          r.media_url ? h("a", { class: "sm ghost", href: r.media_url, target: "_blank", rel: "noreferrer" }, "▶ 打开源文件") : null,
          r.lyrics_text ? h("span", { class: "tiny muted" }, "含纯文本歌词") : null,
          h("button", { class: "sm danger", style: { marginLeft: "auto" },
            title: "删除这条歌词（清掉磁盘上的 .lrc / .srt / .ass；源歌曲 / 视频保留）",
            onClick: () => confirmDeleteLyrics(ctx, [r]) }, "🗑 删除"))));
    }
  };
  /** 勾选 / 取消勾选一行（只重画列表与按钮文字，不整页重载） */
  const toggleRow = (key) => {
    const cur = state.lrcManifestSel || [];
    state.lrcManifestSel = cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key];
    render(); paintSel();
  };
  const selBtn = h("button", { class: "sm danger", onClick: () => {
    const picked = shown().filter((r) => (state.lrcManifestSel || []).includes(r.key));
    if (!picked.length) { toast("先在列表里勾选要删除的歌词（也可以用行尾的「🗑 删除」单条删）", "warn", 6000); return; }
    confirmDeleteLyrics(ctx, picked);
  } }, "🗑 删除选中");
  const selAllBtn = h("button", { class: "sm ghost", onClick: () => {
    const rows = shown();
    const all = rows.length > 0 && rows.every((r) => (state.lrcManifestSel || []).includes(r.key));
    state.lrcManifestSel = all ? [] : rows.map((r) => r.key);
    render(); paintSel();
  } }, "全选");
  const paintSel = () => {
    const n = (state.lrcManifestSel || []).length;
    selBtn.textContent = `🗑 删除选中${n ? `（${n}）` : ""}`;
    selBtn.disabled = !n;
    const rows = shown();
    selAllBtn.textContent = rows.length && rows.every((r) => (state.lrcManifestSel || []).includes(r.key))
      ? "取消全选" : "全选";
  };

  render();
  paintSel();

  const allCount = (m.rows || []).length;
  const packLabel = () => (shown().length === allCount
    ? `⬇ 一键打包下载（全部 ${allCount} 首）`
    : `⬇ 打包下载（当前筛选 ${shown().length} 首）`);
  const packBtn = h("button", { class: "primary", onClick: async () => {
    const rows = shown();
    if (!rows.length) { toast("当前筛选没有可打包的歌曲", "warn"); return; }
    packBtn.disabled = true; const old = packBtn.textContent; packBtn.textContent = "打包中…";
    try {
      // 筛选过就只打包筛出来的那几首（传清单键 key），没筛选就全打包
      const r = await api.lyricsPack(rows.length === allCount ? [] : rows.map((x) => x.key));
      state.lrcPack = r;
      toast(r.note, "ok", 10000);
      ctx.reload();
    } catch (e) { toast(`打包失败：${e.message}`, "err", 10000); }
    packBtn.disabled = false; packBtn.textContent = old;
  } }, packLabel());

  const qInput = h("input", { type: "text", placeholder: "搜歌名 / 项目名", value: state.lrcManifestQuery || "", style: { minWidth: "180px" } });
  // 只重画列表、不整页重载：否则输入框会在每次敲键后丢焦点
  qInput.oninput = () => { state.lrcManifestQuery = qInput.value; render(); packBtn.textContent = packLabel(); };

  card.append(h("div", { class: "row wrap", style: { gap: "10px", alignItems: "center" } },
    packBtn, qInput, selBtn, selAllBtn,
    h("span", { class: "pill acc" }, `${m.count} 首 · ${m.file_count} 个字幕文件`),
    h("button", { class: "sm", onClick: () => downloadLyricsCsv() }, "⬇ 只要清单 .csv"),
    h("button", { class: "sm ghost", onClick: () => loadLyricManifest(ctx, true) }, "刷新清单")));

  if (state.lrcPack) {
    card.append(h("div", { class: "row wrap", style: { gap: "10px", alignItems: "center", marginTop: "8px" } },
      h("span", { class: "pill ok" }, `已打包 ${state.lrcPack.songs} 首 · ${fmtSize(state.lrcPack.bytes)}`),
      h("a", { class: "sm primary", href: state.lrcPack.download_url, download: state.lrcPack.name }, "⬇ 下载 zip"),
      h("a", { class: "sm", href: state.lrcPack.csv_url, download: "" }, "⬇ 打开清单 .csv"),
      h("button", { class: "sm ghost", onClick: () => { state.lrcPack = null; ctx.reload(); } }, "收起")));
  }

  card.append(listBox);
  return card;
}

/**
 * 删除歌词清单里的条目：**只删歌词**（磁盘上的 .lrc / .srt / .ass），歌曲 / 视频默认保留。
 * 选中的都是挂着素材记录的行时，才多给一个「同时删除源素材」的更狠选项（默认不勾）。
 */
function confirmDeleteLyrics(ctx, rows) {
  if (!rows || !rows.length) return;
  const keys = rows.map((r) => r.key);
  const names = rows.slice(0, 6).map((r) => r.media_name).join("、") + (rows.length > 6 ? ` 等 ${rows.length} 条` : "");
  const canAlsoMedia = rows.every((r) => r.asset_id);
  const box = h("div");
  let alsoMedia = false;
  box.append(
    h("p", { class: "muted", style: { marginTop: 0 } }, rows.length === 1
      ? `确定删除《${rows[0].media_name}》的歌词？`
      : `确定删除这 ${rows.length} 条歌词？`),
    h("div", { class: "tiny muted" }, `删掉磁盘上的字幕文件：${names}`),
    h("div", { class: "tiny muted", style: { marginTop: "6px" } }, "歌曲 / 视频本身保留，只是这条不再出现在歌词清单里。"));
  if (canAlsoMedia) {
    const cb = h("input", { type: "checkbox" });
    cb.onchange = () => { alsoMedia = cb.checked; };
    box.append(h("label", { class: "tiny", style: { display: "flex", gap: "6px", alignItems: "center", marginTop: "10px", color: "#b42318" } },
      cb, "同时删除源素材（音频 / 视频也一起删掉，不可恢复）"));
  }
  modal("删除歌词", box, [
    { label: "取消", onClick: (c) => c() },
    { label: "确定删除", primary: true, onClick: async (c) => {
      c();
      try {
        const r = await api.lyricsManifestDelete({ keys, also_media: alsoMedia });
        state.lrcManifestSel = [];
        state.lrcManifest = null;
        toast(r.note, "ok", 9000);
        await loadLyricManifest(ctx, true);
      } catch (e) { toast(`删除失败：${e.message}`, "err", 9000); }
    } },
  ]);
}

/** 盯住音乐任务：拿进度、拿产物，完成后把新素材塞进素材库索引 */
async function watchMusic(ctx, jobId, note) {
  const tick = (j) => {
    state.musicJob = { id: jobId, status: j.status, progress: j.progress || 0, error: j.error, instance: j.instance, note };
    const bar = document.querySelector("#view .progress i");
    if (bar) bar.style.width = `${j.progress || 0}%`;
  };
  let done = false;
  const seen = new Set();
  const pull = () => {
    for (const a of (state.assets || [])) seen.add(a.id);
  };
  pull();
  while (!done) {
    await new Promise((r) => setTimeout(r, 3000));
    let j;
    try { j = await api.job(jobId); } catch { continue; }
    tick(j);
    const fresh = (j.assets || []).filter((a) => !seen.has(a.id));
    if (fresh.length) {
      for (const a of fresh) seen.add(a.id);
      state.musicResult = [...fresh, ...(state.musicResult || [])];
      state.assets = [...fresh, ...(state.assets || [])];
      ctx.reload();
    }
    if (j.status === "succeeded" || j.status === "failed" || j.status === "canceled") {
      done = true;
      tick(j);
      if (j.status === "succeeded") {
        state.lrcManifest = null;          // 新歌进来了，下面那张「歌词下载清单」要重算
        toast("出歌完成，已经存进素材库", "ok", 6000);
      }
      else if (j.status === "failed") toast(`出歌失败：${j.error || "未知原因"}`, "err", 12000);
      ctx.reload();
    }
  }
}

/**
 * 训练样本的「录音 / 上传」控件（AI 翻唱 → 训练新音色）。
 *
 * 录音走浏览器 MediaRecorder（Chrome 给的是 webm/opus），上传后由后端统一转成 48k 单声道 wav，
 * 所以这里不挑格式：手机录的 m4a、剪映导出的 wav 都能直接传（见需求报告 附录 AK）。
 * 录音对象挂在 state.vocalRecorder 上：页面重绘了也还能「停止录音」。
 */
function trainSamplePicker(ctx) {
  const listBox = h("div", { style: { marginTop: "8px" } });
  const recBtn = h("button", { class: "sm" });
  const upIn = h("input", { type: "file", accept: "audio/*,video/*", multiple: true });
  const timer = h("span", { class: "tiny muted" });
  let tick = null;
  let t0 = 0;

  const recording = () => !!(state.vocalRecorder && state.vocalRecorder.state === "recording");

  const paint = () => {
    paintTrainList(listBox, state.vocalTrainFiles || [], ctx);
    recBtn.textContent = recording() ? "⏹ 停止录音" : "🎙 开始录音";
  };

  recBtn.onclick = async () => {
    if (recording()) {
      try { state.vocalRecorder.stop(); } catch { /* 已经停了 */ }
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false },
      });
      const chunks = [];
      const mime = window.MediaRecorder && MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus" : "";
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      state.vocalRecorder = rec;
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = async () => {
        for (const tr of stream.getTracks()) tr.stop();
        clearInterval(tick);
        tick = null;
        state.vocalRecorder = null;
        timer.textContent = "";
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        if (blob.size < 4096) { toast("这段录音太短、没录到声音，再来一次", "warn"); paint(); return; }
        try {
          const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, "");
          const f = new File([blob], `录音_${stamp}.webm`, { type: blob.type || "audio/webm" });
          const a = await api.upload(f, { projectId: state.projectId || "" });
          state.assets = [a, ...(state.assets || [])];
          state.vocalTrainFiles = [...(state.vocalTrainFiles || []), a.id];
          toast(`录音已加入训练样本（${Math.round(blob.size / 1024)} KB）`, "ok");
          ctx.reload();
        } catch (e) { toast(e.message, "err", 9000); }
      };
      rec.start(1000);
      t0 = Date.now();
      timer.textContent = "　录音中 0 秒（建议 3~10 分钟）";
      tick = setInterval(() => {
        timer.textContent = `　录音中 ${((Date.now() - t0) / 1000).toFixed(0)} 秒（建议 3~10 分钟）`;
      }, 500);
      paint();
    } catch (e) {
      toast(`打不开麦克风：${e.message}。可以用右边的「上传文件」代替录音`, "err", 12000);
    }
  };

  upIn.onchange = async () => {
    const files = [...(upIn.files || [])];
    upIn.value = "";
    if (!files.length) return;
    const added = [];
    for (const f of files) {
      try {
        const a = await api.upload(f, { projectId: state.projectId || "" });
        state.assets = [a, ...(state.assets || [])];
        added.push(a.id);
      } catch (e) { toast(`${f.name} 上传失败：${e.message}`, "err", 9000); }
    }
    if (!added.length) return;
    state.vocalTrainFiles = [...(state.vocalTrainFiles || []), ...added];
    toast(`已加入 ${added.length} 段样本`, "ok");
    ctx.reload();
  };

  if (recording() && !tick) timer.textContent = "　录音中…（点「停止录音」结束）";
  paint();
  return h("div", null,
    h("div", { class: "row wrap", style: { gap: "10px", alignItems: "center" } }, recBtn, upIn, timer),
    listBox,
    h("div", { class: "tiny muted", style: { marginTop: "6px" } },
      `已选 ${(state.vocalTrainFiles || []).length} 段。样本越干净越连续，训出来的音色越稳：`
      + "用同一支麦克风、同一个房间录最好，别混音乐、也别混别人的声音。"));
}

/** 训练样本清单：序号 + 名字 + 时长 + 试听 + 移除 */
function paintTrainList(box, ids, ctx) {
  box.innerHTML = "";
  const all = state.assets || [];
  ids.forEach((id, i) => {
    const a = all.find((x) => x.id === id);
    const secs = a && a.duration_ms ? `${(a.duration_ms / 1000).toFixed(0)} 秒` : "时长未知";
    box.append(h("div", { class: "row wrap", style: { gap: "10px", alignItems: "center", marginTop: "4px" } },
      h("span", { class: "pill acc" }, `#${i + 1}`),
      h("span", { class: "tiny" }, `${a ? baseName(a.path) : id} · ${secs}`),
      a ? h("audio", { src: a.url, controls: true, style: { height: "32px" } }) : null,
      h("button", {
        class: "sm ghost",
        onClick: () => {
          state.vocalTrainFiles = (state.vocalTrainFiles || []).filter((x) => x !== id);
          ctx.reload();
        },
      }, "移除")));
  });
  if (!ids.length) box.append(h("div", { class: "tiny muted" }, "还没有样本：先录音，或上传已有的录音文件。"));
}

/** 盯住翻唱任务：拿进度、拿产物，完成后把新素材塞进素材库索引 */

async function watchVocal(ctx, jobId, note, opts = {}) {
  const tick = (j) => {
    state.vocalJob = { id: jobId, status: j.status, progress: j.progress || 0, error: j.error, instance: j.instance, note };
    const box = document.querySelector("#view .progress i");
    if (box) box.style.width = `${j.progress || 0}%`;
  };
  try {
    const done = await awaitJob(jobId, tick);
    state.vocalJob = { id: jobId, status: done.status, progress: done.progress || 0, error: done.error, instance: done.instance, note };
    const produced = (done.assets || []).filter((a) => a.kind === "audio" || a.kind === "video");
    state.vocalResult = produced;
    if (produced.length) {
      try {
        const list = await api.assets({ limit: 2000 });
        state.assets = list;
        state.__assetIndex = Object.fromEntries(list.map((a) => [a.id, a]));
      } catch { /* 拉不到就先用任务里带的那几条 */ }
    }
    // 训练音色这条链路没有音频产物：成败就看「音色清单里有没有新模型」，
    // 所以这里强制重拉一次 status（voices() 会顺带扫目录，刚训好的 .pth 立刻能选）。
    if (opts.isTrain && done.status === "succeeded") {
      state.vocalStatus = null;
      await loadVocal(ctx);
      const want = String(opts.voiceName || "").trim();
      const hit = ((state.vocalStatus && state.vocalStatus.voices) || []).find((v) => want && v.id.includes(want));
      if (hit) state.vocalVoice = hit.id;
      state.vocalMode = "rvc";
      toast(hit
        ? `音色「${want}」训练完成，已经帮你选好，可以直接换音色翻唱了`
        : "音色训练完成：去「换成谁的声音」下拉框里选它", "ok", 15000);
    }
    ctx.reload();
  } catch (e) {
    state.vocalJob = { id: jobId, status: "failed", progress: 0, error: e.message, note };
    ctx.reload();
  }
}

function debounce(fn, ms) {

  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export const views = { home, create, music, vocal, dub, templates, characters, story, trending, assets, jobs };
