// Decides what pasted or dropped text is: a web address, HTML, code, or a note.
// These are plain functions with no page access, so the tests can import them.

export const URL_ONLY = /^https?:\/\/\S+$/i;

// HTML starts with a doctype, <html>, a comment or a common tag, and closes a tag somewhere.
const HTML_START = /^\s*(<!doctype html|<html[\s>]|<!--|<(div|section|main|header|footer|nav|article|aside|body|head|style|svg|button|form|ul|ol|table|h[1-6]|p|span|a|img|figure|label|input)[\s>/])/i;
export const isHtml = (text) => HTML_START.test(text) && /<\/[a-z][\w-]*\s*>|\/>/i.test(text);

// Text fenced with ``` is code, and the fence is dropped.
export const FENCE = /^```([\w+-]*)\n([\s\S]*?)\n?```\s*$/;

// Without a fence: code if at least half the lines look like code.
const CODE_LINE = /[;{}]\s*$|^\s{2,}\S|=>|^\s*(const|let|var|function|import|export|class|def|return|if|for|while)\b|^\s*<\/?\w|^\s*\/\/|^\s*@media\b/;
export function looksLikeCode(text) {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return /^(const|let|var|function|import|export|class|def)\b.*[;{=(]/.test(text.trim());
  return lines.filter((l) => CODE_LINE.test(l)).length / lines.length >= 0.5;
}

// The artboard name for pasted HTML: its <title>, else its first heading, else a plain name.
export function htmlName(html) {
  const raw = html.match(/<title[^>]*>([^<]{1,120})<\/title>/i)?.[1] || html.match(/<h[1-3][^>]*>([^<]{1,120})<\/h[1-3]>/i)?.[1] || '';
  const name = raw.replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
  return name ? `${name.slice(0, 100)} (pasted)` : 'Pasted HTML';
}
