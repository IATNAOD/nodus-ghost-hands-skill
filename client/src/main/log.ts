import log from "electron-log/main";

// %APPDATA%/Ghost Hands/logs/main.log, 2 MB with one rotation; keys and tokens never go here
log.transports.file.level = "info";
log.transports.file.maxSize = 2 * 1024 * 1024;
log.transports.console.level = process.env.NODE_ENV === "development" ? "debug" : "warn";

export default log;
