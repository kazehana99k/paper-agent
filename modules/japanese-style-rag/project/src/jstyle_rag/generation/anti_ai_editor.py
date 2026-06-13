from __future__ import annotations

import re


REPETITIVE_PHRASES = {
    "本レポートでは": ["本稿では", "ここでは"],
    "以上より": ["このことから", "以上の点を踏まえると"],
    "重要であると考えられる": ["重要である", "無視できない論点である"],
    "と言える": ["と考えられる", "とみられる"],
    "といえる": ["と考えられる", "とみられる"],
    "が必要である": ["が求められる", "を検討する必要がある"],
}


def soften_ai_repetition(text: str) -> str:
    edited = text
    for phrase, alternatives in REPETITIVE_PHRASES.items():
        edited = _replace_after_first(edited, phrase, alternatives)
    edited = _soften_sequence_markers(edited)
    edited = _collapse_repeated_endings(edited)
    return edited


def _replace_after_first(text: str, phrase: str, alternatives: list[str]) -> str:
    positions = [match.start() for match in re.finditer(re.escape(phrase), text)]
    if len(positions) <= 1:
        return text
    result: list[str] = []
    cursor = 0
    occurrence = 0
    for match in re.finditer(re.escape(phrase), text):
        result.append(text[cursor : match.start()])
        if occurrence == 0:
            result.append(phrase)
        else:
            result.append(alternatives[(occurrence - 1) % len(alternatives)])
        cursor = match.end()
        occurrence += 1
    result.append(text[cursor:])
    return "".join(result)


def _soften_sequence_markers(text: str) -> str:
    if all(marker in text for marker in ("まず", "次に", "最後に")):
        text = text.replace("まず、", "はじめに、", 1)
        text = text.replace("次に、", "また、", 1)
        text = text.replace("最後に、", "結論として、", 1)
    return text


def _collapse_repeated_endings(text: str) -> str:
    sentences = re.split(r"(?<=。)", text)
    edited: list[str] = []
    repetitive_count = 0
    for sentence in sentences:
        if sentence.endswith("と考えられる。"):
            repetitive_count += 1
            if repetitive_count > 1:
                sentence = sentence[: -len("と考えられる。")] + "である。"
        else:
            repetitive_count = 0
        edited.append(sentence)
    return "".join(edited)
