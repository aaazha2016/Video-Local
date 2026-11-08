"use strict";
/**
 * 内置风格模板库（需求报告 §13.3 A：≥30 个，覆盖 封面/场景/立绘/分镜/运镜/特效）。
 * 字段与 style_template 表一致：prompt_prefix / prompt_suffix / negative / engine_hint / params_json。
 * 官方 596 个模板由 API-19 单独扫描（src/templates.js）。
 */

const S = (id, name, category, prefix, suffix, negative, engine, params) => ({
  id, name, category, prompt_prefix: prefix, prompt_suffix: suffix, negative,
  engine_hint: engine, params_json: params || null, source: "builtin",
});

const BUILTIN_STYLES = [
  // ---------------- 封面（6）
  S("style_cover_bigtext", "大字爆款封面", "封面",
    "bold poster design, huge chinese headline typography space at top 30%, striking contrast, ",
    ", clean background, high readability, vertical 9:16", "messy text, cluttered composition",
    "qwen_image", { steps: 4, cfg: 1.0 }),
  S("style_cover_neon_clash", "高饱和撞色封面", "封面",
    "high saturation color clash poster, magenta vs cyan, glossy 3d shapes, ",
    ", eye-catching, commercial key visual", "desaturated, muddy colors", "qwen_image", null),
  S("style_cover_dark_suspense", "暗黑悬念封面", "封面",
    "dark moody poster, single hard rim light, deep shadows, mysterious silhouette, ",
    ", cinematic thriller key art, negative space for title", "flat lighting, bright cheerful", "qwen_image", null),
  S("style_cover_pet_healing", "萌宠治愈封面", "封面",
    "cute fluffy pet portrait, soft pastel palette, warm morning light, ",
    ", kawaii, gentle bokeh, cozy atmosphere", "scary, harsh shadows", "z_image", { steps: 8 }),
  S("style_cover_knowledge", "知识科普封面", "封面",
    "clean infographic key visual, flat vector shapes, soft blue and white, subtle grid, ",
    ", professional, minimal, clear focal point", "cluttered, low contrast", "qwen_image", null),
  S("style_cover_food", "吃播诱惑封面", "封面",
    "extreme close-up of steaming food, glistening sauce, steam rising, warm tungsten light, ",
    ", macro food photography, appetizing, shallow depth of field", "cold tones, dry looking", "qwen_image", null),

  // ---------------- 场景（8）
  S("style_cyber_neon", "赛博霓虹（抖音热门）", "场景",
    "cyberpunk city at night, neon signs, rain-slicked street, volumetric light, ",
    ", cinematic, ultra detailed, 8k, high contrast", "daylight, flat lighting, blurry", "qwen_image",
    { width: 720, height: 1280, steps: 4, cfg: 1.0 }),
  S("style_xianxia", "古风仙侠", "场景",
    "chinese xianxia fantasy, misty mountains, flowing hanfu, floating petals, ethereal light, ",
    ", ink wash influence, elegant, cinematic wide shot", "modern elements, western architecture", "qwen_image", null),
  S("style_urban_night", "都市夜景", "场景",
    "modern city skyline at blue hour, glass towers, light trails, ",
    ", cinematic color grading, teal and orange, ultra sharp", "daytime, overexposed", "qwen_image", null),
  S("style_pastoral", "田园治愈", "场景",
    "sunlit countryside, golden wheat field, soft breeze, lens flare, ",
    ", warm film tones, peaceful, ghibli inspired", "urban, dark, chaotic", "z_image", { steps: 8 }),
  S("style_wasteland", "废土末日", "场景",
    "post-apocalyptic wasteland, rusted metal, sandstorm, harsh sunlight, ",
    ", desaturated ochre palette, epic scale, dust particles", "clean, lush green", "qwen_image", null),
  S("style_scifi_space", "太空科幻", "场景",
    "deep space station interior, holographic displays, cool blue light, ",
    ", hard sci-fi, volumetric fog, ultra detailed, cinematic", "fantasy, cartoon", "qwen_image", null),
  S("style_campus_youth", "校园青春", "场景",
    "japanese style high school campus, cherry blossoms, warm afternoon light, ",
    ", soft pastel anime look, nostalgic, clean composition", "dark, gritty", "netayume", { steps: 30, cfg: 4.0 }),
  S("style_hk_film", "港风胶片", "场景",
    "1990s Hong Kong street, neon signs, film grain, tungsten and green mix, ",
    ", 35mm film look, cinematic, moody", "digital clean, modern", "qwen_image", null),

  // ---------------- 立绘（6）
  S("style_anime_girl", "二次元少女立绘", "立绘",
    "masterpiece anime illustration, cute girl character sheet, clean lineart, vibrant cel shading, ",
    ", full body, plain background, high detail", "realistic photo, messy lines", "netayume",
    { steps: 30, cfg: 4.0, width: 768, height: 1024 }),
  S("style_photo_realistic", "写实人像立绘", "立绘",
    "photorealistic portrait, 85mm lens, soft key light, natural skin texture, ",
    ", editorial photography, sharp eyes, shallow depth of field", "plastic skin, cartoon", "qwen_image", null),
  S("style_pixar3d", "3D 皮克斯", "立绘",
    "pixar style 3d character, big expressive eyes, subsurface skin, soft global illumination, ",
    ", octane render, playful, family friendly", "flat 2d, realistic", "qwen_image", null),
  S("style_american_comic", "美漫硬朗", "立绘",
    "american comic book hero, bold ink outlines, dramatic hatching, dynamic pose, ",
    ", halftone shading, high contrast, editorial", "soft pastel, cute", "qwen_image", null),
  S("style_guofeng_ink", "国风水墨", "立绘",
    "traditional chinese ink painting figure, flowing brush strokes, xuan paper texture, ",
    ", shuimo style, elegant negative space, muted ink tones", "neon, 3d render", "z_image", { steps: 8 }),
  S("style_mecha", "机甲战士", "立绘",
    "detailed mecha pilot suit, hard surface panel lines, weathered metal, rim light, ",
    ", concept art, industrial design, ultra detailed", "soft, fluffy, cute", "qwen_image", null),

  // ---------------- 分镜（6）
  S("style_cine_cool", "电影感冷调", "分镜",
    "cinematic frame, cool teal and steel blue grade, anamorphic flare, ",
    ", film still, shallow depth of field, 2.39:1 feel", "warm, flat", "wan22", null),
  S("style_warm_memory", "暖光回忆", "分镜",
    "warm golden hour memory, soft haze, gentle bloom, ",
    ", nostalgic film still, kodak portra tones", "cold, harsh", "wan22", null),
  S("style_chase_tense", "紧张追逐", "分镜",
    "high tension chase scene, motion blur, dutch angle, harsh practical lights, ",
    ", action film still, gritty, dynamic", "calm, static", "wan22", null),
  S("style_slowmo_beauty", "慢动作唯美", "分镜",
    "slow motion beauty shot, floating particles, soft backlight, ",
    ", dreamy, high speed camera look, elegant", "fast chaotic", "wan22", null),
  S("style_handheld_doc", "手持纪实", "分镜",
    "handheld documentary footage, natural available light, slight camera shake, ",
    ", realistic, unpolished, authentic", "studio lighting, perfect", "wan22", null),
  S("style_fpv", "第一人称视角", "分镜",
    "first person POV shot, hands visible, immersive, wide angle, ",
    ", action camera look, natural motion", "third person, distant", "wan22", null),

  // ---------------- 运镜（4）
  S("style_cam_zoom_in", "推近聚焦（Zoom In）", "运镜",
    "", ", camera slowly zooms in on the subject, smooth dolly in", "", "wan22",
    { camera: "Zoom In", camera_speed: 1.0 }),
  S("style_cam_zoom_out", "拉远揭示（Zoom Out）", "运镜",
    "", ", camera pulls back revealing the environment", "", "wan22",
    { camera: "Zoom Out", camera_speed: 1.0 }),
  S("style_cam_orbit", "环绕主角（Orbit）", "运镜",
    "", ", camera orbits around the character, smooth circular motion", "", "wan22",
    { camera: "ClockWise (CW)", camera_speed: 0.8 }),
  S("style_cam_pan_follow", "摇移跟随（Pan）", "运镜",
    "", ", camera pans and follows the moving subject", "", "wan22",
    { camera: "Pan Right", camera_speed: 0.8 }),

  // ---------------- 特效（4）
  S("style_fx_bullet_time", "子弹时间", "特效",
    "bullet time effect, frozen mid-air action, camera flies around, ",
    ", matrix style, extreme detail, slow motion", "static", "minimax_h3", null),
  S("style_fx_four_seasons", "四季流转", "特效",
    "time lapse of four seasons changing in one shot, cherry blossom to snow, ",
    ", seamless transition, poetic", "static season", "minimax_h3", null),
  S("style_fx_dark_magic", "暗黑魔法", "特效",
    "dark magic energy swirling, purple and black smoke, glowing runes, ",
    ", epic fantasy VFX, volumetric", "bright cheerful", "minimax_h3", null),
  S("style_fx_bloom", "花瓣绽放", "特效",
    "flowers blooming in fast motion, petals bursting outward, ",
    ", macro VFX, delicate, vibrant colors", "wilted, dull", "minimax_h3", null),
];

/** 特效模板 → MiniMax-H3 embedding 提示（报告 §8.10 / §13.3） */
const MINIMAX_EMBEDDINGS = {
  style_fx_bullet_time: "minimaxh3_bullet_time",
  style_fx_four_seasons: "minimaxh3_four_seasons",
  style_fx_dark_magic: "minimaxh3_dark_magic",
  style_fx_bloom: "minimaxh3_blooming_flowers",
  style_fx_kiss_camera: "minimaxh3_kiss_camera",
  style_fx_spiral: "minimaxh3_spiral_ascent",
  style_fx_storm: "minimaxh3_storm_magic",
  style_fx_fire: "minimaxh3_fire_breath",
  style_fx_truman: "minimaxh3_truman_show",
  style_fx_art_boom: "minimaxh3_art_is_explosion",
};

module.exports = { BUILTIN_STYLES, MINIMAX_EMBEDDINGS };
