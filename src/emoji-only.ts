// Match complete emoji sequences, including skin tones, joined emoji, flags and keycaps.
const emoji = /(?:\p{Extended_Pictographic}(?:\uFE0F)?(?:\p{Emoji_Modifier})?(?:[\u{E0020}-\u{E007E}]+\u{E007F})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F)?(?:\p{Emoji_Modifier})?)*|\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3)/gu;

export function isEmojiOnly(text: string): boolean {
  return text.trim().length > 0 && text.replace(emoji, '').trim().length === 0;
}
