// «какие компьютеры в сети», «что запущено на компьютере»
const { runCommand } = require("../../lib/command");

module.exports = {
  id: "pc_status",
  label: "intents.pc_status.label",
  // no triggers: "компьютер" alone means too many things ("сколько стоит компьютер")
  triggers: [],
  phrases: [
    "какие компьютеры в сети",
    "что запущено на компьютере",
    "какие компьютеры включены",
    "включен ли компьютер",
    "какие программы открыты на компьютере",
    "which computers are online",
    "what is running on the computer",
    "is my computer on",
  ],
  // one form per stem: forms with one stem would be counted twice
  context: ["компьютеры", "запущено", "сети", "онлайн", "computers", "online", "running"],
  antipatterns: [
    "выключи", "перезагрузи", "запусти", "закрой", "открой", "громче", "тише", "найди",
    "сколько", "стоит", "купить", "цена", "shut", "launch", "close", "price", "buy",
  ],
  priority: 5,
  errorResponse: "intents.pc_status.error",
  handler: async (params, ctx, configs) => runCommand(ctx, configs, "pc_status", params),
};
