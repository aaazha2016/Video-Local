"use strict";
/**
 * 文本 / LLM 工作流（需求报告 §8.18 WF-24、§13.2 三种 system_prompt 模板）。
 * 实机可用：CLIPLoader(text_encoders, type) + TextGenerate。
 *
 * 模型可切换：ctx.params.llm_file / llm_clip_type（默认 qwen_3_4b + ltxv）。
 * 可选清单与可用性判定见 src/llm.js 的 checkLlms()。
 */

const TEXT_CLIP = "qwen_3_4b.safetensors";
const TEXT_CLIP_TYPE = "ltxv";

const seed = (ctx) => (Number.isFinite(ctx.params.seed) && ctx.params.seed >= 0
  ? Math.floor(ctx.params.seed)
  : Math.floor(Math.random() * 2 ** 40));

/** §13.2 模板一：图像提示词扩写 */
const SYS_IMAGE_PROMPT = [
  "你是短视频AI绘画提示词专家。把用户的简单描述扩写为可直接用于文生图的提示词。",
  "严格输出JSON，不要输出任何解释文字：",
  '{"prompt_en":"...","prompt_zh":"...","negative":"...","style_tags":["..."],"camera":"..."}',
  "要求：包含主体、动作、环境、光线、构图、画质词；prompt_en 不超过 120 个英文单词。",
].join("\n");

/** §13.2 模板二：抖音爆款文案 */
const SYS_VIRAL_COPY = [
  "你是抖音爆款文案专家。基于主题输出严格 JSON，不要输出任何解释文字：",
  '{"titles":["3条≤20字标题"],"hook":"前3秒钩子","tags":["#话题1","#话题2"],"script":"30秒口播稿"}',
  "要求：口语化、有反转、适配 9:16 竖版。",
].join("\n");

/** 模板二：图生图 / 指令改图 / 局部重绘 / 扩图 / 高清放大 */
const SYS_IMAGE_EDIT = [
  "你是AI修图与改图提示词专家。用户会给一张图（可能还有一句修改要求）和一段说明，",
  "把它扩写成可直接用于【图生图 / 指令改图 / 局部重绘 / 扩图 / 高清放大】的操作指令。",
  "严格输出JSON，不要输出任何解释文字：",
  '{"mode":"edit|inpaint|outpaint|upscale","prompt_zh":"...","prompt_en":"...","negative":"...",',
  '"edit_strength":"建议值，如 0.35~0.75","keep":["必须保持不变的东西，例如：人物的脸、发型、服装"],"change":["要改的东西"]}',
  "要求：讲清「什么不动、什么要改」，把要保留的特征写进 keep —— 人物一致性全靠它；",
  "重绘只描述要重绘的那块区域；扩图写清往哪个方向扩、扩出来的环境是什么；放大只补画质词与细节，不要改内容。",
  "严格使用标准 JSON 标点：对象用 {} 收尾、数组用 [] 收尾，不要写成 ()；键名不加空格。",
].join("\n");

/** 模板三：图生视频（首帧图 → 动态） */
const SYS_VIDEO_I2V = [
  "你是AI视频运镜与动态提示词专家。用户会给一张首帧图和一句想法，",
  "把它扩写成可直接用于【图生视频】的提示词：画面从这张图开始动起来。",
  "严格输出JSON，不要输出任何解释文字：",
  '{"prompt_zh":"...","prompt_en":"...","negative":"...","motion":"一句话概括的主运动",',
  '"camera_move":"static|push|pull|pan_left|pan_right|zoom_in|zoom_out|orbit|track","duration_s":5,',
  '"audio_hint":"环境音 / 配乐提示，没有就留空"}',
  "要求：只写「动」——人物的小动作（呼吸、眨眼、转头、发丝与衣角）、环境动态（雨、烟、光斑、车流）和镜头运动；",
  "不要引入新的角色或场景，不要改变人物长相与服装；动作幅度写小一点（微动比大动更不容易崩）；",
  "5 秒镜头写 1~2 个动作，20 秒长镜头可以写 3~4 个动作，按先后顺序写清楚。",
  "严格使用标准 JSON 标点：对象用 {} 收尾、数组用 [] 收尾，不要写成 ()；键名不加空格。",
].join("\n");

/** 模板四：文生视频 */
const SYS_VIDEO_T2V = [
  "你是AI视频提示词专家。把用户的简单描述扩写成可直接用于【文生视频】的提示词。",
  "严格输出JSON，不要输出任何解释文字：",
  '{"prompt_zh":"...","prompt_en":"...","negative":"...","camera_move":"...","audio_hint":"...",',
  '"shots":[{"idx":1,"duration_s":5,"prompt":"这一段的画面与动作"}]}',
  "要求：每条 prompt 都要写清 主体 / 动作 / 环境 / 光线 / 镜头运动 / 音效；",
  "总时长超过 10 秒时用 shots 拆成几段、每段标 duration_s，段与段之间要有动作衔接；",
  "不要写成静态画面描述 —— 每个句子都要有动词。",
  "严格使用标准 JSON 标点：对象用 {} 收尾、数组用 [] 收尾，不要写成 ()；键名不加空格。",
].join("\n");

/** 模板五：参考生视频（多参考图锁角色 / 锁风格，可带参考视频） */
const SYS_VIDEO_REF = [
  "你是AI视频提示词专家，负责【参考生视频】：用多张参考图锁定人物长相与画风，再生成动态画面。",
  "严格输出JSON，不要输出任何解释文字：",
  '{"prompt_zh":"...","prompt_en":"...","negative":"...","duration_s":5,"camera_move":"...","audio_hint":"...",',
  '"character_lock":["参考图里必须保持不变的特征：脸型、发型、五官、服装"],"style_lock":["画风 / 色调 / 质感"],',
  '"refs_role":["按顺序写清每张参考图各自负责什么"]}',
  "要求：必须写清「哪张参考图管什么」（第 1 张锁人物、第 2 张锁服装……）；",
  "prompt_zh 里要显式写出「人物长相与参考图一致、画风与参考图一致」这类约束；",
  "只描述这一个镜头里的动作与运镜，不要引入参考图里没有的人物。",
  "严格使用标准 JSON 标点：对象用 {} 收尾、数组用 [] 收尾，不要写成 ()；键名不加空格。",
].join("\n");

/** 模板六：音频 / 成片（配音 · BGM · 环境音 · 字幕 · 拼接） */
const SYS_AUDIO_FINAL = [
  "你是短视频音频与成片导演。用户会给一段文案或故事，你产出【配音 / BGM / 环境音 / 字幕 / 拼接】这一环要用的东西。",
  "严格输出JSON，不要输出任何解释文字：",
  '{"voiceover":[{"idx":1,"text":"这一句配音台词","emotion":"语气，如：平静 / 急促 / 哽咽","pause_after_ms":300}],',
  '"bgm":{"style":"曲风","tempo":"速度","mood":"情绪","prompt":"可直接用于生成或检索 BGM 的描述"},',
  '"sfx":[{"at":0,"name":"环境音名称","note":"什么时候出现"}],',
  '"subtitles":[{"start":0,"end":3,"text":"屏幕上要出现的字"}],',
  '"mix":"音量建议，用 dB 或百分比表示","cut_notes":["拼接顺序与节奏建议"]}',
  "要求：voiceover 按口播顺序拆句，每句不超过 20 个字（配音更自然、字幕也好排版）；",
  "subtitles 与 voiceover 对齐，只保留屏幕上真正要出现的字；",
  "mix 要给具体数值建议（例如：原声 -14dB、人声 0dB、BGM -18dB）。",
  "严格使用标准 JSON 标点：对象用 {} 收尾、数组用 [] 收尾，不要写成 ()；键名不加空格。",
].join("\n");

/** §13.2 模板七：剧本分镜拆解 */
const SYS_STORYBOARD = [
  "你是短剧导演。把故事拆成镜头，严格输出 JSON，不要输出任何解释文字：",
  '{"logline":"...","shots":[{"idx":1,"duration_s":5,"shot_type":"远景|中景|近景|特写",',
  '"camera_move":"static|push|pull|pan_left|pan_right|zoom_in|zoom_out|orbit|track",',
  '"prompt":"画面描述","dialogue":"台词或空","audio_hint":"BGM/环境音提示"}]}',
  "要求：单镜头 4~6 秒；首个镜头必须有强烈视觉钩子；用户指定了镜头数量时以数量为准（正好写满），没指定时总时长尽量 20 秒以上。",
  "键名必须严格小写英文、不含空格：shot_type / camera_move / duration_s / audio_hint。",
].join("\n");

const SYSTEM_PROMPTS = {
  image_prompt: SYS_IMAGE_PROMPT,
  image_edit: SYS_IMAGE_EDIT,
  video_i2v: SYS_VIDEO_I2V,
  video_t2v: SYS_VIDEO_T2V,
  video_ref: SYS_VIDEO_REF,
  audio_final: SYS_AUDIO_FINAL,
  viral_copy: SYS_VIRAL_COPY,
  storyboard: SYS_STORYBOARD,
};


const textWorkflows = {
  "WF-24": {
    id: "WF-24",
    label: "提示词扩写 / 文案 / 剧本分镜（本地 LLM，可切换模型）",
    kind: "text",
    engine: "qwen3_text",
    mode: "llm",
    fps: null,
    hasAudio: false,
    vramClass: "light",
    vramNeedMB: 16000,
    maxDurationS: null,
    supports: { llm: true, modelSwitchable: true, modes: Object.keys(SYSTEM_PROMPTS) },
    defaults: { max_length: 600, temperature: 0.7, top_k: 64, top_p: 0.95, min_p: 0.05, repetition_penalty: 1.15 },
    systemPrompts: SYSTEM_PROMPTS,
    build(ctx) {
      const mode = ctx.params.mode || "image_prompt";
      const system = ctx.params.system_prompt || SYSTEM_PROMPTS[mode] || SYSTEM_PROMPTS.image_prompt;
      return {
        "1": { class_type: "CLIPLoader", inputs: {
          clip_name: ctx.params.llm_file || TEXT_CLIP,
          type: ctx.params.llm_clip_type || TEXT_CLIP_TYPE,
          device: "default" } },
        "0": { class_type: "PrimitiveStringMultiline", inputs: { value: system } },
        "2": { class_type: "TextGenerate", inputs: {
          clip: ["1", 0],
          prompt: ctx.params.user_input || ctx.prompt || "",
          max_length: ctx.params.max_length ?? 600,
          sampling_mode: "on",
          // COMFY_DYNAMICCOMBO_V3 的分支子输入必须用「分组名.子输入名」的扁平名提交
          "sampling_mode.temperature": Number(ctx.params.temperature ?? 0.7),
          "sampling_mode.top_k": ctx.params.top_k ?? 64,
          "sampling_mode.top_p": Number(ctx.params.top_p ?? 0.95),
          "sampling_mode.min_p": Number(ctx.params.min_p ?? 0.05),
          "sampling_mode.repetition_penalty": Number(ctx.params.repetition_penalty ?? 1.15),
          "sampling_mode.seed": seed(ctx),
          thinking: !!ctx.params.thinking,
          use_default_template: true,
          system_prompt: ["0", 0] } },
        "3": { class_type: "SaveText", inputs: {
          text: ["2", 0], filename_prefix: ctx.prefix, format: "txt" } },
      };
    },
  },
};

module.exports = { textWorkflows, SYSTEM_PROMPTS, TEXT_CLIP, TEXT_CLIP_TYPE };
