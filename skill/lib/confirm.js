/**
 * Answers to yes/no questions asked with ctx.askUser. A refusal anywhere wins
 * over consent ("Конечно нет." is "no"); silence is neither.
 */
"use strict";

const { wordsOf } = require("./text");

const YES = new Set([
  "да", "ага", "угу", "конечно", "верно", "давай", "хорошо", "ладно", "можно", "ок", "окей", "го",
  "выключай", "перезагружай", "закрывай", "запускай", "включай", "усыпляй", "блокируй", "подтверждаю",
  "yes", "yeah", "yep", "sure", "ok", "okay", "go", "please", "do", "confirm",
]);
const NO = new Set(["нет", "неа", "не", "отмена", "отмени", "стоп", "отбой", "no", "nope", "cancel", "stop", "dont", "don"]);

/** "yes" | "no" | "other" */
const answerKind = (text) => {
  const words = wordsOf(text);

  return words.some((word) => NO.has(word)) ? "no" : words.some((word) => YES.has(word)) ? "yes" : "other";
};

/** Cancel words in an answer to "which one?" questions. */
const isCancel = (text) => wordsOf(text).some((word) => ["отмена", "отмени", "отбой", "неважно", "никакой", "cancel", "nevermind", "never"].includes(word));

module.exports = { answerKind, isCancel, YES, NO };
