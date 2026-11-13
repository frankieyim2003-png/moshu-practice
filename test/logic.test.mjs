import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const marker = html.match(/\/\* LOGIC_START \*\/([\s\S]*?)\/\* LOGIC_END \*\//);
if (!marker) throw new Error("logic markers missing");

const context = {};
vm.createContext(context);
vm.runInContext(marker[1] + `
this.api = {
  cleanItemLine, parseItemLines, looksLikeSentence, splitClauses, alignChars,
  isPunctChar, classifyOCR, answersMatch, stripPunct, slowRate, shouldUseSlots,
  usesSentenceUI, expectedLen,
  setPunct(on) { punctMatch = !!on; }
};
`, context);
const {
  cleanItemLine, parseItemLines, looksLikeSentence, splitClauses, alignChars,
  isPunctChar, classifyOCR, answersMatch, stripPunct, slowRate, shouldUseSlots,
  usesSentenceUI, expectedLen, setPunct
} = context.api;

const plain = (v) => JSON.parse(JSON.stringify(v));

test("built-in word audio is unchanged", () => {
  const line = html.split("\n").find(l => l.startsWith("const ITEMS"));
  assert.ok(line, "ITEMS line missing");
  const hash = crypto.createHash("sha256").update(line, "utf8").digest("hex");
  assert.equal(hash, "2a8b474b3ef5198f2db0d0b87fce39e35086e8a4a60fac3f7165c562114231cd");
  assert.equal(line.split("data:audio/mpeg;base64,").length - 1, 34);
  assert.equal(line.includes('"a": null'), false);
  const words = [...line.matchAll(/"w": "([^"]*)"/g)].map(m => m[1]);
  assert.equal(words.length, 34);
  assert.deepEqual(words.slice(0, 3), ["遮掩", "心扉", "分享"]);
  assert.equal(words.filter(w => w.length > 4).length, 0);
});

test("custom parser keeps punctuation and strips leading numbers", () => {
  assert.equal(html.includes("[^\\u4e00-\\u9fffA-Za-z0-9]"), false);
  assert.equal(cleanItemLine("1. 今天天氣很好。"), "今天天氣很好。");
  assert.equal(cleanItemLine("1、今天天氣很好，我們去公園。"), "今天天氣很好，我們去公園。");
  assert.equal(cleanItemLine("（1）分享"), "分享");
  assert.equal(cleanItemLine("  心扉  "), "心扉");
  assert.equal(cleanItemLine("「小朋友」說：「你好。」"), "「小朋友」說：「你好。」");
  assert.equal(cleanItemLine("你完成功課了嗎？"), "你完成功課了嗎？");
  const lines = parseItemLines([
    "1. 今天天氣很好，我們去公園。",
    "1. 今天天氣很好，我們去公園。",
    "",
    "2、遮掩",
    "Hello",
    "……"
  ].join("\n"));
  assert.deepEqual(plain(lines), ["今天天氣很好，我們去公園。", "遮掩"]);
});

test("sentence shape and slots", () => {
  assert.equal(looksLikeSentence("遮掩"), false);
  assert.equal(looksLikeSentence("黑漆漆"), false);
  assert.equal(looksLikeSentence("今天天氣很好。"), true);
  assert.equal(shouldUseSlots({ w: "遮掩", kind: "word" }), true);
  assert.equal(shouldUseSlots({ w: "今天天氣很好。", kind: "word" }), false);
  assert.equal(shouldUseSlots({ w: "好", kind: "sentence" }), false);
  assert.equal(usesSentenceUI({ w: "好", kind: "sentence" }), true);
});

test("clause split keeps punctuation on the clause", () => {
  assert.deepEqual(plain(splitClauses("今天天氣很好，我們去公園。")), ["今天天氣很好，", "我們去公園。"]);
  assert.deepEqual(plain(splitClauses("你好嗎？我很好！")), ["你好嗎？", "我很好！"]);
  assert.deepEqual(plain(splitClauses("你好！！")), ["你好！！"]);
  assert.deepEqual(plain(splitClauses("遮掩")), ["遮掩"]);
});

test("character diff marks the wrong character", () => {
  const ops = alignChars("今天天氣很壞。", "今天天氣很好。");
  const bad = ops.filter(op => op.t !== "eq");
  assert.equal(bad.length, 1);
  assert.deepEqual(plain(bad[0]), { t: "sub", g: "壞", a: "好" });
  const missing = alignChars("今天天氣很好我們去公園。", "今天天氣很好，我們去公園。");
  assert.ok(missing.some(op => op.t === "del" && op.a === "，"));
  const rebuilt = alignChars("abc", "axc");
  assert.equal(rebuilt.map(op => op.g || "").join(""), "abc");
  assert.equal(rebuilt.map(op => op.a || "").join(""), "axc");
});

test("punctuation setting", () => {
  const item = { w: "今天天氣很好。", kind: "sentence" };
  setPunct(true);
  assert.equal(answersMatch("今天天氣很好", "今天天氣很好。", item), false);
  assert.equal(answersMatch("今天天氣很好。", "今天天氣很好。", item), true);
  setPunct(false);
  assert.equal(answersMatch("今天天氣很好", "今天天氣很好。", item), true);
  assert.equal(answersMatch("今天 天氣 很好", "今天天氣很好。", item), true);
  assert.equal(answersMatch("今天天氣很壞", "今天天氣很好。", item), false);
  assert.equal(stripPunct("「你好。」"), "你好");
  assert.equal(isPunctChar("，"), true);
  assert.equal(isPunctChar("好"), false);
  assert.equal(isPunctChar("々"), false);
  assert.equal(expectedLen(item), 6);
  setPunct(true);
  assert.equal(expectedLen(item), 7);
});

test("words still require an exact match", () => {
  setPunct(false);
  assert.equal(answersMatch("遮掩", "遮掩", { w: "遮掩", kind: "word" }), true);
  assert.equal(answersMatch("遮掩。", "遮掩", { w: "遮掩", kind: "word" }), false);
});

test("OCR keeps sentence punctuation and splits short words", () => {
  const mixed = classifyOCR("遮掩\n心扉\n今天天氣很好，我們去公園。\n");
  assert.deepEqual(plain(mixed.words), ["遮掩", "心扉"]);
  assert.deepEqual(plain(mixed.sents), ["今天天氣很好，我們去公園。"]);

  const listed = classifyOCR("1、遮掩、心扉、分享");
  assert.deepEqual(plain(listed.words), ["遮掩", "心扉", "分享"]);
  assert.deepEqual(plain(listed.sents), []);

  const two = classifyOCR("今天天氣很好。我們去公園。");
  assert.deepEqual(plain(two.sents), ["今天天氣很好。", "我們去公園。"]);
  assert.deepEqual(plain(two.words), []);

  const spaced = classifyOCR("遮掩 心扉 分享");
  assert.deepEqual(plain(spaced.words), ["遮掩", "心扉", "分享"]);

  const numberedSentence = classifyOCR("3. 你完成功課了嗎？");
  assert.deepEqual(plain(numberedSentence.sents), ["你完成功課了嗎？"]);
});

test("slow replay is slower than the chosen rate", () => {
  assert.equal(slowRate(1), 0.75);
  assert.equal(slowRate(0.7), 0.6);
  assert.ok(slowRate(1) < 1);
});

test("no invented school sentences", () => {
  assert.match(html, /const SENTENCES = \[\];/);
  assert.equal(html.includes("官方句子未加入") || html.includes("未有官方句子"), true);
});
