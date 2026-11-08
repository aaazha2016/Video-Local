"use strict";
/**
 * 「风格模仿」预设表（AI 音乐 / AI 翻唱共用）。
 *
 * 单独放一个文件是为了让 src/music.js 和 src/vocal.js 都能 require，
 * 又不会因为互相 require 形成循环依赖。
 */

/**
 * 「风格模仿」预设：曲风 / 歌星唱腔 / 场景情绪三大类。
 *
 *   tags = 交给音乐模型的英文风格串（生成时会拼在用户自己写的风格描述前面）
 *   hint = 交给大模型写词时的中文提示：让歌词的用词、句式、押韵、情绪也跟着这个风格走
 *
 * 前端从 GET /api/music/status 的 styles 字段拿到这份清单直接渲染，
 * 不需要在页面上写死任何一条。
 */
const STYLE_PRESETS = [
  // ------------------------------------------------------------ 曲风
  { id: "mandopop_ballad", group: "曲风", label: "华语流行情歌", tags: "mandopop ballad, 78 BPM, warm piano and lush strings, expressive lead vocal, modern studio production", hint: "标准华语情歌：主歌克制铺陈、副歌情绪爆发，句子押韵工整，副歌要有一句能记住的记忆点" },
  { id: "guofeng", group: "曲风", label: "中国风 / 古风", tags: "chinese traditional pop, guofeng, 84 BPM, guzheng, erhu, dizi, pipa, poetic male vocal", hint: "古风歌词：多用意象（月、舟、剑、长安、旧梦），文白相间、对仗工整，避免现代口语词" },
  { id: "hiphop", group: "曲风", label: "说唱 / 嘻哈", tags: "mandarin hip hop, trap, 90 BPM, deep 808 bass, crisp hi-hats, confident rap flow", hint: "说唱歌词：长短句交错、押韵密集、有 punchline，主歌是 flow 感强的叙述，副歌是短句口号" },
  { id: "edm", group: "曲风", label: "电子舞曲", tags: "EDM dance pop, 128 BPM, supersaw synth lead, four-on-the-floor kick, big drop, catchy vocal chops", hint: "舞曲歌词：句子短、重复多、适合全场跟唱，副歌用同一句反复强化" },
  { id: "rock", group: "曲风", label: "摇滚", tags: "mandarin rock, 132 BPM, overdriven electric guitar, live drums, anthemic chorus", hint: "摇滚歌词：直白有力、有呐喊感，副歌高音拉长，情绪从压抑走向释放" },
  { id: "folk", group: "曲风", label: "民谣", tags: "acoustic folk, 92 BPM, fingerpicked guitar, harmonica, intimate close-mic vocal", hint: "民谣歌词：像讲故事，细节具体（地名、天气、旧物件），口语化、不堆砌辞藻" },
  { id: "rnb", group: "曲风", label: "R&B / 灵魂", tags: "contemporary R&B, 84 BPM, smooth electric piano, sub bass, layered harmonies, melismatic vocal", hint: "R&B 歌词：暧昧慵懒、留白多，句子短，副歌有转音发挥的空间" },
  { id: "jazz", group: "曲风", label: "爵士", tags: "jazz pop, 108 BPM, upright bass, brushed drums, jazz piano, smoky female vocal", hint: "爵士歌词：用词讲究、画面优雅，可以带一点暧昧与自嘲" },
  { id: "acg", group: "曲风", label: "二次元 / 日系", tags: "anime pop, J-pop, 160 BPM, bright synth arpeggio, energetic female vocal", hint: "日系 ACG 歌词：元气、跳跃，副歌堆叠情绪冲到最高点，句子短促有力" },
  { id: "citypop", group: "曲风", label: "复古 City Pop", tags: "city pop, 100 BPM, retro electric piano, slap bass, glossy chorus guitar", hint: "City Pop 歌词：都市夜景、霓虹、海风、开车兜风，复古而浪漫" },
  { id: "lofi", group: "曲风", label: "Lo-Fi 治愈", tags: "lofi chill hip hop, 72 BPM, dusty drums, mellow rhodes, vinyl noise, soft spoken vocal", hint: "Lo-Fi 歌词：轻声碎念、生活碎片感，像深夜日记，句子短而松弛" },
  { id: "epic", group: "曲风", label: "史诗 / 大片配乐", tags: "epic cinematic orchestral, 90 BPM, taiko drums, brass section, choir, huge build to climax", hint: "史诗歌词：宏大叙事、命运与征途，用词有分量，副歌像号角" },
  { id: "children", group: "曲风", label: "儿歌 / 童声", tags: "children's song, 120 BPM, ukulele, glockenspiel, cheerful kids choir, simple singable melody", hint: "儿歌歌词：句子短、押韵上口、重复多，用词必须是小朋友听得懂的日常词" },
  { id: "ethnic_dance", group: "曲风", label: "民族流行 / 广场舞", tags: "chinese ethnic dance pop, 128 BPM, erhu lead, punchy drums, festive atmosphere", hint: "民族流行歌词：喜庆热闹、朗朗上口，副歌重复度高，适合跟跳" },
  { id: "earworm", group: "曲风", label: "短视频神曲（抓耳）", tags: "upbeat mandopop earworm, 124 BPM, catchy repeated hook, punchy drums, bright synth", hint: "短视频神曲歌词：前 15 秒就要抓住人，副歌一句反复唱，句子极短、记忆点极强" },
  {
    id: "medieval_waltz2", group: "曲风", label: "中世纪 · 第二圆舞曲（肖斯塔科维奇）",
    // 圆舞曲的骨架（3/4 拍、168 BPM）必须用结构化参数给到模型，光写在标签里会被默认的 4/4 压掉
    bpm: 168, timesignature: "3",
    tags: "waltz, 3/4 time, 168 BPM, bittersweet romantic waltz melody, oom-pah-pah waltz accompaniment, Shostakovich Waltz No. 2 style, melancholic minor key, medieval folk timbre, lute, hurdy-gurdy, recorder, vielle, frame drum, modal harmony, warm stone-hall reverb",
    hint: "中世纪民谣气质的圆舞曲：3/4 拍，旋律要有肖斯塔科维奇《第二圆舞曲》那种优雅又哀伤的起伏；歌词用古朴克制的意象（烛火、石堡、钟声、旧信、冬夜、旅人），避免现代口语",
    tip: "文本模型只会模仿「圆舞曲风格」，不会复刻原曲旋律。想要第二圆舞曲的原旋律，请用「锁旋律改编」上传一段参考音频。",
  },

  // ------------------------------------------------------------ 歌星唱腔
  { id: "artist_guofeng_rnb", group: "歌星唱腔", label: "周杰伦式中国风", tags: "jay-chou-style mandopop, R&B groove with guofeng arrangement, 88 BPM, guzheng and strings, laid-back nasal male vocal, rhythmic rap-like verses", hint: "周杰伦式中国风：主歌半念半唱、节奏切分，副歌旋律悠长；词偏古典意象与含蓄情绪" },
  { id: "artist_belting_female", group: "歌星唱腔", label: "邓紫棋式高音情歌", tags: "powerhouse female mandopop ballad, 76 BPM, piano and strings build, huge belting high notes, wide vocal range", hint: "大嗓女声情歌：主歌压抑低语，副歌连续高音爆发，情绪层层递进不退让" },
  { id: "artist_smooth_tenor", group: "歌星唱腔", label: "林俊杰式抒情", tags: "jj-lin-style mandopop ballad, 80 BPM, lush strings and piano, smooth tenor with bright high notes", hint: "抒情男声：旋律线条流畅，副歌高音温暖不嘶吼；词写得细腻、有呼吸感" },
  { id: "artist_sad_male", group: "歌星唱腔", label: "薛之谦式伤感", tags: "emotional mandopop, 72 BPM, sparse piano, breathy vulnerable male vocal, whispered verses", hint: "伤感男声：主歌近乎耳语，副歌用假声往上走；词写失恋的细节与自我拉扯" },
  { id: "artist_narrative_folk", group: "歌星唱腔", label: "毛不易式叙事民谣", tags: "narrative folk pop, 76 BPM, acoustic guitar, plain-spoken deep male vocal, storytelling", hint: "叙事民谣：像在讲一个普通人的故事，用词朴素白描，不抒情而更打动人" },
  { id: "artist_youth_rock", group: "歌星唱腔", label: "五月天式热血摇滚", tags: "stadium mandarin rock, 140 BPM, driving guitars, passionate male vocal, big singalong chorus", hint: "热血摇滚：青春、朋友、不服输；副歌要能全场大合唱" },
  { id: "artist_cantopop", group: "歌星唱腔", label: "陈奕迅式粤语情歌", tags: "cantopop ballad, 74 BPM, warm piano, intimate baritone, restrained emotion", hint: "粤语情歌：克制、克制、再克制，情绪藏在细节里；词写成年人的体面与遗憾（用粤语语感）" },
  { id: "artist_pop_storytelling", group: "歌星唱腔", label: "Taylor Swift 式流行叙事", tags: "taylor-swift-style pop storytelling, 104 BPM, acoustic guitar into synth pop, warm female vocal, detailed narrative", hint: "欧美流行叙事：具体的时间地点与场景细节，像在讲一段亲身经历的故事" },
  { id: "artist_ethereal", group: "歌星唱腔", label: "周深式空灵高音", tags: "ethereal high voice, 70 BPM, ambient pads and strings, soaring falsetto, cinematic", hint: "空灵高音：歌词要有画面与光感，副歌拉长音、飘在空中，少用重字" },
  { id: "artist_retro_diva", group: "歌星唱腔", label: "邓丽君式怀旧", tags: "retro mandopop, 92 BPM, warm strings, gentle vibrato female vocal, 1980s analog production", hint: "怀旧金曲：词浅情深、句子规整，多用「你/我/月/花」这类经典意象" },
  { id: "artist_ethnic_duet", group: "歌星唱腔", label: "凤凰传奇式民族流行", tags: "ethnic pop, 126 BPM, erhu and synth, powerful duet: male rap verses + soaring female high vocal", hint: "民族流行对唱：主歌男声念白式铺陈，副歌女声高亢长音，气势要大" },

  // ------------------------------------------------------------ 场景情绪
  { id: "mood_graduation", group: "场景情绪", label: "毕业 / 青春", tags: "nostalgic youth mandopop, 84 BPM, acoustic guitar and strings, warm group vocal", hint: "毕业青春：教室、校服、操场、最后一节课、没说出口的喜欢" },
  { id: "mood_breakup", group: "场景情绪", label: "失恋 / 深夜 emo", tags: "emotional mandopop, 70 BPM, sparse piano, breathy vocal, late-night atmosphere", hint: "失恋 emo：失眠、旧照片、删了又写的消息、假装没事" },
  { id: "mood_night_drive", group: "场景情绪", label: "深夜开车", tags: "night drive synth pop, 100 BPM, warm analog synth, mellow bass, soft vocal", hint: "深夜开车：路灯、收音机、高架桥、一个人不想回家" },
  { id: "mood_healing", group: "场景情绪", label: "治愈 / 温暖", tags: "warm healing acoustic pop, 80 BPM, ukulele and soft strings, gentle vocal", hint: "治愈温暖：小确幸、慢慢来、没关系、被接住的瞬间" },
  { id: "mood_festive", group: "场景情绪", label: "新年 / 喜庆", tags: "festive chinese pop, 128 BPM, suona and drums, celebratory choir", hint: "新年喜庆：团圆、鞭炮、红包、好运，热闹讨喜" },
  { id: "mood_inspirational", group: "场景情绪", label: "励志 / 燃", tags: "uplifting inspirational pop rock, 120 BPM, piano into full band, powerful chorus", hint: "励志燃向：不认输、爬起来、再试一次，副歌要给人力量" },
];

const getStylePreset = (id) => STYLE_PRESETS.find((s) => s.id === id) || null;

/** 把「风格预设 + 用户自己写的风格 + 自定义模仿对象」拼成一条给模型的英文风格串 */
function composeStyle(preset, style, imitate) {
  return [preset && preset.tags, style, imitate].map((x) => String(x || "").trim()).filter(Boolean).join(", ");
}

module.exports = { STYLE_PRESETS, getStylePreset, composeStyle };
