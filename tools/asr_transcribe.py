# -*- coding: utf-8 -*-
"""把一段人声轨转成「带时间戳的字符流」，交给 Node 侧做歌词强制对齐。

为什么不用「找出人声段落、按字数摊开」那套：歌曲里有间奏（没人唱），
分离出来的人声轨在间奏里仍有伴奏残响，于是那段时间会被当成「在唱」，
歌词就被摊进间奏里，整段时间轴往后错好几秒（实测差到 9 秒）。
让 ASR 听一遍、再从识别结果里认歌词，才谈得上对齐。

用法：
    python asr_transcribe.py <音频/视频> <模型目录> <输出json> [--language zh]

输出 JSON：
    {"words": [{"w": "阳光", "s": 15.58, "e": 16.10}, ...],
     "segments": [{"start": 15.58, "end": 18.80, "text": "..."}, ...]}

--prompt 传歌词开头的几句当 initial_prompt：唱词容易被整段听成幻觉文案，
带上它开头几句才认得出来（时间戳才有意义）。
"""
import json
import os
import sys
import warnings

warnings.filterwarnings("ignore")


def shim():
    """pkg_resources 在 Python 3.12+ 上会炸（引用了已经没有的 pkgutil.ImpImporter），
    ctranslate2 又在 import 时用它。这里补两个占位属性绕过去，不改动环境。"""
    import pkgutil
    if not hasattr(pkgutil, "ImpImporter"):
        class _ImpImporter:  # noqa: D401
            def __init__(self, path=None):
                self.path = path
        pkgutil.ImpImporter = _ImpImporter
    if not hasattr(pkgutil, "ImpLoader"):
        class _ImpLoader:
            def __init__(self, *a, **k):
                pass
        pkgutil.ImpLoader = _ImpLoader


def main():
    argv = sys.argv[1:]
    positionals, language, prompt = [], "zh", ""
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--language" and i + 1 < len(argv):
            language = argv[i + 1]; i += 2; continue
        if a == "--prompt" and i + 1 < len(argv):
            prompt = argv[i + 1]; i += 2; continue
        positionals.append(a); i += 1
    if len(positionals) < 3:
        print("usage: asr_transcribe.py <audio> <model_dir> <out.json>"
              " [--language zh] [--prompt 歌词开头几句]", file=sys.stderr)
        return 2
    audio, model_dir, out_path = positionals[0], positionals[1], positionals[2]

    shim()
    from faster_whisper import WhisperModel

    device = os.environ.get("AVS_ASR_DEVICE", "cuda")
    compute = os.environ.get("AVS_ASR_COMPUTE", "float16")
    model = WhisperModel(model_dir, device=device, compute_type=compute)

    segments, _info = model.transcribe(
        audio,
        language=language,
        beam_size=5,
        word_timestamps=True,
        vad_filter=False,                 # 唱歌不是「说话」，VAD 会整段丢掉
        condition_on_previous_text=False,  # 关掉，否则间奏上容易复读上一句（实测整段复读）
        # 带上歌词开头几句当提示：唱词对语音识别是「非母语」内容，
        # 不给提示时开头几句会被整段听成幻觉（实测听成「词曲 李宗盛」，那几行就没时间戳了）。
        initial_prompt=(prompt or None),
    )

    words, segs = [], []
    for s in segments:
        segs.append({"start": round(s.start, 3), "end": round(s.end, 3), "text": s.text.strip()})
        for w in (s.words or []):
            tok = (w.word or "").strip()
            if not tok:
                continue
            words.append({"w": tok, "s": round(w.start, 3), "e": round(w.end, 3)})

    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump({"words": words, "segments": segs}, fh, ensure_ascii=False)
    print(f"ok words={len(words)} segments={len(segs)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())