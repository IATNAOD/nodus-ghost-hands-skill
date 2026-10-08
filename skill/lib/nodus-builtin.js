// lib/nodus-builtin.js - [{ id, triggers }]
const DATA = `
#ambience
ambience_play,ambience_stop шум звук звуки noise sound sounds
#base
alarm_cancel отмени удали убери cancel delete remove
alarm_set будильник разбуди разбудить alarm wake
forget забудь удали сотри forget delete erase
get_date дата дату число date day день
get_time время времени time
house_journal происходило случилось happened
is_workday рабочий выходной праздник working holiday workday
list_memories знаешь перечисли know
recall вспомни помнишь recall
remember запомни запиши сохрани remember memorize
reminder_cancel удали отмени убери сотри cancel delete remove
reminder_set напоминание напомни напомнить remind reminder
run_scenario сценарий сценарии сценарию сценария сцена сцену scenario scene
stopwatch_start,stopwatch_status,stopwatch_stop секундомер секундомера секундомере stopwatch
stop_scenario сценарий сценарии сценария сценарию scenario scene
timer_cancel отмени отменить удали сбрось cancel delete
timer_start таймер timer
timer_status осталось left
volume громкость звук тише громче потише погромче volume louder quieter
weather погода погоду weather forecast
whats_new сообщения messages
who_is_home дома home
#briefing
briefing сводка сводку briefing
#home_automation
adjust_device_value прибавь убавь увеличь уменьши brighter dimmer louder quieter добавь снизь ярче темнее тусклее громче тише
get_device_status статус status check проверь
list_devices устройства приборы devices
list_rooms комнаты зоны rooms zones
set_device_value установи поставь выстави set задай
turn_off_device выключи погаси выруби закрой disable close
turn_off_room,turn_on_room всё все везде everywhere everything
turn_on_device включи зажги врубай открой раскрой enable open
whats_on включено работает горит on running
#lists
clear_list очисти очистить clear empty
read_list список list
#media
like_track лайк лайкни нравится like
next_track следующая следующую следующий переключи дальше next skip
pause_music останови пауза паузу stop pause
play_liked лайкнутые лайкнутых любимые любимую избранное liked favorite
play_music музыку музыка music
resume_music продолжи продолжай возобнови resume continue
#telegram
send_message напиши отправь сообщение телеграм write send message telegram`;

let skill;
module.exports = DATA.trim().split("\n").flatMap((line) => {
  if (line.startsWith("#")) return (skill = line.slice(1)), [];
  const [ids, ...triggers] = line.split(" ");
  return ids.split(",").map((id) => ({ id: `${skill}/${id}`, triggers }));
});
