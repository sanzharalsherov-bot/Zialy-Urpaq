"use client";

import { ChangeEvent, FormEvent, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { ApiError, ATTEMPT_KEY, TOKEN_KEY, answerText, automaticScoreRate, isManualQuestion, readStorage, requestJson, validPoints, writeStorage } from './client-utils';
import { StudentMonitor, TeacherMonitor } from './live-monitor';
import { StudentRoomV2 } from './student-room-v2';

const TeacherScreenMonitor = dynamic(() => import('./room-screen-sharing').then(module => module.TeacherScreenMonitor), { ssr: false });

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? '/api';

type User = { id: string; email: string; firstName?: string; lastName?: string; role: string };
type OptionDraft = { text: string; isCorrect: boolean };
type QuestionDraft = { type: 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE' | 'SHORT_TEXT' | 'LONG_TEXT' | 'NUMERIC'; prompt: string; points: number; options: OptionDraft[]; correctValue: number; tolerance: number };
const newQuestion = (): QuestionDraft => ({
  type: 'SINGLE_CHOICE', prompt: '', points: 1, correctValue: 0, tolerance: 0,
  options: [{ text: '', isCorrect: true }, { text: '', isCorrect: false }],
});

export default function Home() {
  type Language = 'kk' | 'ru' | 'en';
  const [language, setLanguage] = useState<Language>('ru');
  const [languageLoaded, setLanguageLoaded] = useState(false);
  const phrases: Record<string, [string, string]> = {
    'Язык':['Тіл','Language'],'УЧЕБНАЯ ПЛАТФОРМА':['ОҚУ ПЛАТФОРМАСЫ','LEARNING PLATFORM'],'Войти в систему':['Жүйеге кіру','Sign in'],'Одна платформа для заданий, ответов и учебных результатов.':['Тапсырмалар, жауаптар және оқу нәтижелеріне арналған бір платформа.','One place for assignments, answers, and learning results.'],'Преподаватель':['Мұғалім','Teacher'],'Ученик':['Оқушы','Student'],'Входим…':['Кіруде…','Signing in…'],'Войти':['Кіру','Sign in'],'ПЛАТФОРМА':['ПЛАТФОРМА','PLATFORM'],'Обзор':['Шолу','Overview'],'Тесты и задания':['Тесттер мен тапсырмалар','Tests and assignments'],'Результаты':['Нәтижелер','Results'],'Мои задания':['Менің тапсырмаларым','My assignments'],'Управление школой':['Мектепті басқару','School management'],'Выйти из системы ↗':['Жүйеден шығу ↗','Sign out ↗'],'Создать задание':['Тапсырма жасау','Create assignment'],'Администратор':['Әкімші','Administrator'],'Всё для обучения.':['Оқу үшін бәрі.','Everything for learning.'],'В одном месте.':['Бір жерде.','In one place.'],'Создавайте задания, проверяйте работы и отслеживайте учебный прогресс.':['Тапсырмалар жасап, жұмыстарды тексеріп, оқу барысын бақылаңыз.','Create assignments, grade work, and track learning progress.'],'Рабочее пространство':['Жұмыс кеңістігі','Workspace'],'Активные задания':['Белсенді тапсырмалар','Active assignments'],'Всего попыток':['Барлық әрекеттер','Total attempts'],'На проверке':['Тексерілуде','Awaiting review'],'Проверенные работы':['Тексерілген жұмыстар','Graded submissions'],'Добавить преподавателя':['Мұғалім қосу','Add teacher'],'Имя':['Аты','First name'],'Фамилия':['Тегі','Last name'],'Последние задания':['Соңғы тапсырмалар','Recent assignments'],'Состояние API':['API күйі','API status'],'Конструктор задания':['Тапсырма құрастырушысы','Assignment builder'],'Название задания':['Тапсырма атауы','Assignment title'],'Предмет':['Пән','Subject'],'Описание':['Сипаттама','Description'],'Отмена':['Болдырмау','Cancel'],'Сохранить и опубликовать':['Сақтау және жариялау','Save and publish'],'Доступные задания':['Қолжетімді тапсырмалар','Available assignments'],'Начать':['Бастау','Start'],'Отправить ответы':['Жауаптарды жіберу','Submit answers'],'Аналитика результатов':['Нәтижелер аналитикасы','Results analytics'],'ОТЧЁТ ПО КЛАССУ':['СЫНЫП ЕСЕБІ','CLASS REPORT'],'Сводка помогает увидеть общий прогресс и вопросы, требующие повторения.':['Жиынтық есеп жалпы үлгерімді және қайталауды қажет ететін сұрақтарды көрсетеді.','See overall progress and questions that may need review.'],'Отправлено работ':['Жіберілген жұмыстар','Submissions sent'],'из':['ішінен','of'],'попыток':['әрекет','attempts'],'Средний результат':['Орташа нәтиже','Average score'],'среди оценённых работ ·':['бағаланған жұмыстардан ·','among graded submissions ·'],'Ответов оценено':['Бағаланған жауаптар','Answers graded'],'по всем вопросам':['барлық сұрақ бойынша','across all questions'],'Успеваемость по вопросам':['Сұрақтар бойынша үлгерім','Performance by question'],'Доля набранных баллов среди оценённых ответов':['Бағаланған жауаптардағы жиналған ұпай үлесі','Earned points across graded answers'],'Вопрос':['Сұрақ','Question'],'баллов':['ұпай','points'],'Распределение результатов':['Нәтижелер үлестірімі','Score distribution'],'Доля от максимального балла по попытке':['Әрекеттегі ең жоғары балдың үлесі','Percent of maximum score per attempt'],'Диаграмма появится после оценивания ответов.':['Жауаптар бағаланғаннан кейін диаграмма көрсетіледі.','The chart will appear once answers are graded.'],'Распределение появится после выставления оценок.':['Бағалар қойылғаннан кейін үлестірім көрсетіледі.','The distribution will appear once submissions are graded.'],'Столбцы учитывают только ответы, которым уже начислены баллы. Более низкий процент показывает темы, которым может понадобиться дополнительное объяснение.':['Бағандар ұпай қойылған жауаптарды ғана есептейді. Төмен пайыз қосымша түсіндіру қажет тақырыптарды көрсетеді.','Bars include answers that have been scored. Lower percentages point to topics that may need more explanation.']
  };
  const extraPhrases: Record<string, [string, string]> = {
    'Вернуть на исправление':['Қайта түзетуге қайтару','Return for revision'],
    'Кому назначить':['Кімге тағайындау','Assign to'],
    'Выбрано учеников':['Таңдалған оқушылар','Students selected'],
    'Если не выбирать учеников, задание получит весь класс.':['Оқушыларды таңдамасаңыз, тапсырманы бүкіл сынып алады.','If no students are selected, the whole class will receive the assignment.'],
    'В выбранном классе нет активных учеников.':['Таңдалған сыныпта белсенді оқушылар жоқ.','There are no active students in the selected class.'],
    'Не удалось загрузить учеников класса':['Сынып оқушыларын жүктеу мүмкін болмады','Could not load students in this class'],
    'Выбраны отдельные ученики':['Жеке оқушылар таңдалды','Individual students selected'],
    'Весь класс':['Бүкіл сынып','Whole class'],
    'Все ученики':['Барлық оқушылар','All students'],

    'Работа возвращена ученику на исправление':['Жұмыс оқушыға түзетуге қайтарылды','Work returned to the student for revision'],
    'Работа возвращена на исправление':['Жұмыс түзетуге қайтарылды','Work returned for revision'],
    'Исправьте ответы и отправьте работу повторно.':['Жауаптарды түзетіп, жұмысты қайта жіберіңіз.','Correct your answers and resubmit the work.'],
    'Исправить работу':['Жұмысты түзету','Revise work'],
    'Работа открыта для исправления. После изменений отправьте её повторно.':['Жұмыс түзету үшін ашылды. Өзгерістерден кейін қайта жіберіңіз.','The work is open for revision. Resubmit it after making changes.'],
    'Не удалось вернуть работу':['Жұмысты қайтару мүмкін болмады','Could not return the work'],
    'Не удалось открыть работу для исправления':['Жұмысты түзету үшін ашу мүмкін болмады','Could not reopen the work for revision'],
    'Войти по коду теста':['Тест коды бойынша кіру','Join with a test code'],
    'Настройки новых комнат':['Жаңа бөлме параметрлері','New room settings'],'Участников в лобби':['Лоббидегі қатысушылар','Lobby capacity'],'Длительность, минут':['Ұзақтығы, минут','Duration, minutes'],'Без ограничения времени':['Уақыт шектеусіз','No time limit'],'Новая комната':['Жаңа бөлме','New room'],'Код комнаты':['Бөлме коды','Room code'],'Участники':['Қатысушылар','Participants'],'Запустить сейчас':['Қазір іске қосу','Start now'],'Ожидание':['Күтуде','Waiting'],'Идёт тест':['Тест жүріп жатыр','Test in progress'],'Создана комната':['Бөлме құрылды','Room created'],'Не удалось создать комнату':['Бөлме жасау мүмкін болмады','Could not create room'],
    'Экспорт результатов CSV':['Нәтижелерді CSV ретінде экспорттау','Export results as CSV'],'Начало':['Басталу уақыты','Started at'],'Статус':['Күйі','Status'],'Попытка':['Әрекет','Attempt'],
    'Вкладка была скрыта':['Қойынды жасырылды','Tab was hidden'],'Страница была закрыта':['Бет жабылды','Page was closed'],
    'Текстовые ответы проверяет преподаватель. Результат обновится автоматически после проверки.':['Мәтіндік жауаптарды мұғалім тексереді. Тексерілгеннен кейін нәтиже автоматты түрде жаңартылады.','The teacher grades text answers. This result updates automatically after review.'],
    'К заданиям':['Тапсырмаларға','Back to assignments'],'Баллы':['Ұпай','Points'],'Сохранено':['Сақталды','Saved'],'Нет связи: черновик сохранён в этой вкладке.':['Байланыс жоқ: жауаптар осы қойындыда сақталған.','Offline: answers are saved in this tab.'],'правильных':['дұрыс жауап','correct answers'],'Таблица лидеров появится после оценивания результатов.':['Нәтижелер бағаланған соң көшбасшылар кестесі шығады.','The leaderboard appears after submissions are graded.'],'Преподаватель запустит тест, когда соберётся нужное количество учеников.':['Оқушылар саны жеткілікті болғанда мұғалім тестті іске қосады.','The teacher will start the test once enough students have joined.'],'Попытка завершена: три предупреждения о переключении вкладки.':['Қойынды ауыстыру туралы үш ескертуден кейін әрекет аяқталды.','The attempt ended after three tab-switch warnings.'],'Подключаемся…':['Қосылуда…','Joining…'],
    'Размер лобби, учеников':['Лоббидегі оқушы саны','Students in lobby'],'Без лобби':['Лобби жоқ','No lobby'],'Пусто — тест запускается сразу после входа ученика.':['Бос қалса — оқушы кірген кезде тест бірден басталады.','Leave empty to start the test as soon as a student joins.'],'Перемешивать вопросы для каждого ученика':['Әр оқушыға сұрақтарды араластыру','Shuffle questions for each student'],'Перемешивать варианты ответов':['Жауап нұсқаларын араластыру','Shuffle answer options'],'Код теста':['Тест коды','Test code'],'Лобби':['Лобби','Lobby'],'Запустить комнату':['Бөлмені іске қосу','Start room'],'Тест запущен для учеников':['Тест оқушылар үшін іске қосылды','Test started for students'],'Ожидаем запуск преподавателя':['Мұғалімнің тесті іске қосуын күтіп отырмыз','Waiting for the teacher to start'],'Не удалось подключиться к комнате':['Бөлмеге қосылу мүмкін болмады','Could not join the room'],'Не удалось запустить тест':['Тестті іске қосу мүмкін болмады','Could not start the test'],'Введите код теста, который сообщил преподаватель.':['Мұғалім берген тест кодын енгізіңіз.','Enter the test code provided by your teacher.'],'Подключиться к тесту':['Тестке қосылу','Join test'],'Ожидание запуска теста':['Тесттің іске қосылуын күту','Waiting for the test to start'],'Предупреждения о переключении вкладки':['Қойынды ауыстыру ескертулері','Tab-switch warnings'],'Ответы сохранены на сервере автоматически.':['Жауаптар серверде автоматты түрде сақталады.','Answers are autosaved to the server.'],'Результат теста':['Тест нәтижесі','Test result'],'Место в рейтинге':['Рейтингтегі орын','Leaderboard rank'],'Правильных ответов':['Дұрыс жауаптар','Correct answers'],'Время прохождения':['Орындау уақыты','Completion time'],'Топ учеников':['Үздік оқушылар','Top students'],
    'Импорт из Word':['Word құжатынан импорттау','Import from Word'],'Загрузите заполненный шаблон DOCX — вопросы появятся в конструкторе для проверки.':['Толтырылған DOCX үлгісін жүктеңіз — сұрақтар тексеру үшін құрастырушыда көрсетіледі.','Upload a filled DOCX template to review its questions in the builder.'],'Скачать шаблон':['Үлгіні жүктеу','Download template'],'Загрузить .docx':['.docx жүктеу','Upload .docx'],'Загружаем…':['Жүктелуде…','Importing…'],'Шаблон загружен. Проверьте вопросы и ответы, затем опубликуйте задание.':['Үлгі жүктелді. Сұрақтар мен жауаптарды тексеріп, тапсырманы жариялаңыз.','Template imported. Review the questions and answers, then publish the assignment.'],'Не удалось прочитать шаблон Word':['Word үлгісін оқу мүмкін болмады','Could not read the Word template'],
    'Задания':['Тапсырмалар','Assignments'],'Результаты':['Нәтижелер','Results'],'Прогресс':['Үлгерім','Progress'],'Общий код школы':['Мектептің ортақ коды','School access code'],'Пароль':['Құпиясөз','Password'],'Аккаунты':['Тіркелгілер','Accounts'],'УЧЕБНЫЙ ПРОЦЕСС':['ОҚУ ҮДЕРІСІ','LEARNING PROCESS'],
    'Планируй.':['Жоспарла.','Plan.'],'Проверяй.':['Тексер.','Review.'],'Развивай.':['Дамыт.','Grow.'],'Данные из подключённой базы':['Қосылған дерекқордан алынған деректер','Data from the connected database'],'+ Создать задание':['+ Тапсырма жасау','+ Create assignment'],'Опубликованные тесты':['Жарияланған тесттер','Published tests'],'Сохранённые работы':['Сақталған жұмыстар','Saved submissions'],'Нужна проверка преподавателя':['Мұғалім тексеруі қажет','Teacher review needed'],'Оценка выставлена':['Баға қойылды','Graded'],'АДМИНИСТРИРОВАНИЕ':['ӘКІМШІЛІК БАСҚАРУ','ADMINISTRATION'],
    'Учётные записи сотрудников':['Қызметкерлер тіркелгілері','Staff accounts'],'Создавайте личные аккаунты преподавателей и меняйте общий код для учеников.':['Мұғалімдерге жеке тіркелгі жасап, оқушылардың ортақ кодын өзгертіңіз.','Create teacher accounts and change the shared student access code.'],'аккаунтов в списке':['тіркелгі тізімде','accounts listed'],'Управлять доступом →':['Қолжетімділікті басқару →','Manage access →'],'Управление публикациями':['Жарияланымдарды басқару','Manage publishing'],'Все задания →':['Барлық тапсырмалар →','All assignments →'],'попыток':['әрекет','attempts'],'Пока нет заданий. Создай первое, чтобы ученики могли начать.':['Әзірге тапсырма жоқ. Оқушылар бастауы үшін біріншісін жасаңыз.','No assignments yet. Create one so students can get started.'],'Backend и PostgreSQL':['Сервер бөлігі және PostgreSQL','Backend and PostgreSQL'],'Панель использует реальные данные сервера. Если соединение потеряно, появится сообщение об ошибке.':['Панель сервердегі нақты деректерді пайдаланады. Байланыс үзілсе, қате туралы хабарлама шығады.','This dashboard uses live server data. A message appears if the connection is lost.'],'Открыть проверку API ↗':['API күйін тексеру ↗','Open API health check ↗'],'Создавай тесты и открывай результаты каждой попытки.':['Тесттер жасап, әр әрекеттің нәтижесін қараңыз.','Create tests and review each attempt.'],'+ Новое задание':['+ Жаңа тапсырма','+ New assignment'],'вопросов ·':['сұрақ ·','questions ·'],'Удалить':['Жою','Delete'],'Заданий пока нет.':['Әзірге тапсырма жоқ.','No assignments yet.'],
    'Создать аккаунт преподавателя':['Мұғалім тіркелгісін жасау','Create teacher account'],'Ученикам аккаунт не нужен: они входят по общему коду и ФИО.':['Оқушыларға тіркелгі қажет емес: олар ортақ кодты, аты мен тегін енгізіп кіреді.','Students do not need accounts; they sign in with the shared code and their name.'],'Не менее 12 символов. Сообщите пароль пользователю безопасным способом.':['Кемінде 12 таңба. Құпиясөзді пайдаланушыға қауіпсіз жолмен жеткізіңіз.','At least 12 characters. Share the password securely.'],'Общий код входа учеников':['Оқушыларға арналған ортақ кіру коды','Shared student sign-in code'],'Новый код':['Жаңа код','New code'],'После смены новый код понадобится для следующих входов. Ученики указывают имя и фамилию при каждом входе.':['Код өзгергеннен кейін келесі кірулер үшін жаңа код қажет болады. Оқушылар әр кірген сайын аты мен тегін енгізеді.','After changing the code, students will need the new one next time. They enter their name each time they sign in.'],'Преподаватели':['Мұғалімдер','Teachers'],'Личные аккаунты сотрудников школы':['Мектеп қызметкерлерінің жеке тіркелгілері','Personal accounts for school staff'],'Преподавателей пока нет. Создайте первую учётную запись.':['Әзірге мұғалімдер жоқ. Алғашқы тіркелгіні жасаңыз.','No teachers yet. Create the first account.'],'Здесь показаны последние 200 аккаунтов.':['Мұнда соңғы 200 тіркелгі көрсетілген.','The 200 most recent accounts are shown here.'],
    'Сначала предмет и название, затем вопросы и настройки прохождения.':['Алдымен пән мен атауды, содан кейін сұрақтар мен өту параметрлерін толтырыңыз.','Start with the subject and title, then add questions and test settings.'],'Вопросы':['Сұрақтар','Questions'],'Сформулируйте вопрос, выберите тип ответа и укажите баллы.':['Сұрақты жазыңыз, жауап түрін таңдап, ұпай санын көрсетіңіз.','Write the question, choose an answer type, and set its points.'],'Удалить вопрос':['Сұрақты жою','Remove question'],'Текст вопроса':['Сұрақ мәтіні','Question text'],'Тип ответа':['Жауап түрі','Answer type'],'Один правильный вариант':['Бір дұрыс жауап','Single correct answer'],'Несколько правильных вариантов':['Бірнеше дұрыс жауап','Multiple correct answers'],'Текст — проверяет преподаватель':['Мәтін — мұғалім тексереді','Text — teacher graded'],'Максимум баллов':['Ең жоғары ұпай','Maximum points'],'Варианты ответов':['Жауап нұсқалары','Answer options'],'Отметьте правильный вариант':['Дұрыс жауапты белгілеңіз','Mark the correct answer'],'+ Добавить вариант':['+ Нұсқа қосу','+ Add option'],'Здесь задаётся только максимум. Фактический балл преподаватель выставит при проверке ответа.':['Мұнда тек ең жоғары ұпай беріледі. Мұғалім нақты ұпайды жауапты тексергенде қояды.','Set only the maximum here. The teacher awards the actual points when grading the answer.'],'+ Добавить вопрос':['+ Сұрақ қосу','+ Add question'],'Дополнительные настройки':['Қосымша параметрлер','Additional settings'],'Ограничения применяются ко всему тесту.':['Шектеулер бүкіл тестке қолданылады.','These limits apply to the entire test.'],'Лимит времени, минут':['Уақыт шегі, минут','Time limit, minutes'],'Попытки на весь тест для одного ФИО':['Бір оқушыға бүкіл тест бойынша әрекет саны','Attempts per student for the entire test'],'Считается каждое запущенное прохождение теста целиком.':['Тестті басталған әрбір толық өту есептеледі.','Each started test attempt counts in full.'],
    'Результаты попыток':['Тест әрекеттерінің нәтижелері','Attempt results'],'Выбери задание, чтобы открыть ответы учеников.':['Оқушылардың жауаптарын көру үшін тапсырманы таңдаңыз.','Choose an assignment to view student answers.'],'Открыть результаты':['Нәтижелерді ашу','Open results'],'сохранённых попыток':['сақталған әрекет','saved attempts'],'← Все задания':['← Барлық тапсырма','← All assignments'],'· Начало:':['· Басталды:','· Started:'],'· Отправлено:':['· Жіберілді:','· Submitted:'],'Правильные варианты:':['Дұрыс жауаптар:','Correct options:'],'Баллы:':['Ұпай:','Points:'],'Оценка преподавателя':['Мұғалім бағасы','Teacher grade'],'Максимум за ответ:':['Жауап үшін ең жоғары ұпай:','Maximum points for this answer:'],'Засчитать полностью':['Толық ұпай беру','Award full points'],'Не засчитывать · 0':['Есептемеу · 0','Do not award · 0'],'Проверка работы':['Жұмысты тексеру','Grade submission'],'Введите баллы за каждый текстовый ответ, затем сохраните оценку.':['Әр мәтіндік жауапқа ұпай енгізіп, бағалауды сақтаңыз.','Enter points for each text answer, then save the grade.'],'Попыток пока нет.':['Әзірге әрекет жоқ.','No attempts yet.'],
    '· До':['· Мерзімі:','· Due:'],'Сейчас нет опубликованных доступных заданий.':['Қазір қолжетімді жарияланған тапсырмалар жоқ.','There are no published assignments available right now.'],'· Ученик:':['· Оқушы:','· Student:'],'Ответы сохранятся после отправки. Не закрывай страницу до завершения.':['Жауаптар жіберілгеннен кейін сақталады. Аяқтамайынша бетті жаппаңыз.','Your answers are saved when submitted. Keep this page open until you finish.'],'балл(ов) ·':['ұпай ·','points ·'],'Выйти из теста':['Тесттен шығу','Exit test'],'Учебная платформа':['Оқу платформасы','Learning platform'],'Реальные данные из PostgreSQL':['PostgreSQL дерекқорындағы нақты деректер','Live data from PostgreSQL'],'Закрыть уведомление':['Хабарламаны жабу','Dismiss notification'],'Тип входа':['Кіру түрі','Sign-in type'],'Например, Математика':['Мысалы, математика','For example, Mathematics'],'Например, Дроби: контрольная работа':['Мысалы, бөлшектер: бақылау жұмысы','For example, Fractions: unit test'],'Сформулируйте вопрос для ученика':['Оқушыға арналған сұрақты жазыңыз','Write a question for the student'],'Ответ не дан':['Жауап берілмеді','No answer provided'],'не заданы':['көрсетілмеген','not set'],'Не отправлено':['Жіберілмеген','Not submitted'],'В процессе':['Орындалуда','In progress'],'Отправлено':['Жіберілді','Submitted'],'Проверено':['Тексерілді','Graded'],'Время истекло':['Уақыт аяқталды','Time expired'],'Возвращено':['Қайтарылды','Returned'],'Опубликовано':['Жарияланды','Published'],'Черновик':['Жоба','Draft'],'Отключён':['Өшірілген','Disabled'],'Активен':['Белсенді','Active'],'Настроен':['Бапталған','Configured'],'Не задан':['Орнатылмаған','Not set'],'Без предмета':['Пән көрсетілмеген','No subject'],'Без лимита времени':['Уақыт шектеусіз','No time limit'],'без срока':['мерзімсіз','no due date'],'Введи число':['Санды енгізіңіз','Enter a number'],'Твой ответ':['Жауабыңыз','Your answer'],'Необязательный':['Міндетті емес','Optional'],'Обязательный вопрос':['Міндетті сұрақ','Required question'],'Сохранить изменения':['Өзгерістерді сақтау','Save changes'],'Сохранить оценку':['Бағаны сақтау','Save grade'],'Сохраняем…':['Сақталуда…','Saving…'],'Отправляем…':['Жіберілуде…','Submitting…'],'Создаём…':['Жасалуда…','Creating…'],'Сменить код':['Кодты өзгерту','Change code'],'Сохранить код':['Кодты сақтау','Save code'],'Код настроен. Введите новый, чтобы заменить текущий.':['Код бапталған. Ағымдағы кодты ауыстыру үшін жаңасын енгізіңіз.','Code is configured. Enter a new one to replace it.'],'Код ещё не настроен. Задайте его, чтобы ученики могли войти.':['Код әлі бапталмаған. Оқушылар кіруі үшін код орнатыңыз.','The code is not set yet. Set one so students can sign in.'],'Не менее 6 символов':['Кемінде 6 таңба','At least 6 characters'],'Без лимита':['Шектеусіз','No limit'],'мин.':['мин.','min.'],'минут':['минут','minutes'],'Нужно оставить минимум два варианта':['Кемінде екі нұсқа қалдыру керек','Keep at least two options'],'Удалить вариант':['Нұсқаны жою','Remove option']
  };
  Object.assign(extraPhrases, {
    'Введите общий код школы, имя и фамилию.':['Мектептің ортақ кодын, аты-жөніңізді енгізіңіз.','Enter the school access code and your first and last name.'],'Введите email и пароль, которые выдал администратор.':['Әкімші берген email мен құпиясөзді енгізіңіз.','Enter the email and password provided by your administrator.'],'Ученикам нужен общий код школы. Его выдаёт учитель или администратор.':['Оқушыларға мектептің ортақ коды қажет. Оны мұғалім немесе әкімші береді.','Students need the school access code provided by a teacher or administrator.'],'Нет аккаунта сотрудника? Обратитесь к администратору школы.':['Қызметкер тіркелгісі жоқ па? Мектеп әкімшісіне хабарласыңыз.','Need a staff account? Contact your school administrator.'],'ЛИЧНЫЙ КАБИНЕТ УЧЕНИКА':['ОҚУШЫНЫҢ ЖЕКЕ КАБИНЕТІ','STUDENT PORTAL'],'Личный аккаунт ученика':['Оқушының жеке тіркелгісі','Student account'],'Попытка №':['Әрекет №','Attempt #'],'не отправлено':['жіберілмеген','not submitted'],'не выставлены':['қойылмаған','not graded'],'Балл будет начислен после проверки.':['Ұпай жауап тексерілгеннен кейін қойылады.','Points are awarded after the answer is reviewed.'],'Введите баллы':['Ұпайды енгізіңіз','Enter points'],'Вопрос':['Сұрақ','Question'],'баллов':['ұпай','points'],'Баллы':['Ұпай','Points'],'Вариант':['Нұсқа','Option'],'Необязательное описание для учеников':['Оқушыларға арналған қосымша сипаттама','Optional description for students'],'SCHOOL MANAGEMENT':['МЕКТЕПТІ БАСҚАРУ','SCHOOL MANAGEMENT'],'попыток':['талпыныс','attempts'],', выберите задание для начала.':[', бастау үшін тапсырманы таңдаңыз.',', choose an assignment to get started.'],'Максимум':['Ең жоғары ұпай','Maximum'],'Удалить тест':['Тестті жою','Delete test'],'и все его попытки и результаты? Это действие нельзя отменить.':['және оның барлық әрекеті мен нәтижесін жойғыңыз келе ме? Бұл әрекетті болдырмау мүмкін емес.','and all its attempts and results? This cannot be undone.'],'Активные задания':['Белсенді тапсырмалар','Active assignments'],
    'Аккаунт создан. Передайте пользователю email и пароль.':['Тіркелгі жасалды. Пайдаланушыға email мен құпиясөзді беріңіз.','Account created. Share the email and password with the user.'],'Учётная запись создана. Передайте пользователю email и пароль.':['Тіркелгі жасалды. Пайдаланушыға email мен құпиясөзді беріңіз.','Account created. Share the email and password with the user.'],'Общий код входа учеников обновлён':['Оқушылардың ортақ кіру коды жаңартылды','The shared student access code was updated'],'Задание создано и опубликовано':['Тапсырма жасалып, жарияланды','Assignment created and published'],'Тест удалён':['Тест жойылды','Test deleted'],'Оценка сохранена':['Баға сақталды','Grade saved'],'Вы вышли из системы':['Жүйеден шықтыңыз','You have signed out'],'Не удалось войти':['Кіру мүмкін болмады','Sign-in failed'],'Не удалось загрузить данные':['Деректерді жүктеу мүмкін болмады','Could not load data'],'Не удалось создать задание':['Тапсырма жасау мүмкін болмады','Could not create assignment'],'Не удалось создать учётную запись':['Тіркелгі жасау мүмкін болмады','Could not create account'],'Не удалось сохранить код':['Кодты сақтау мүмкін болмады','Could not save code'],'Не удалось удалить тест':['Тестті жою мүмкін болмады','Could not delete test'],'Не удалось загрузить результаты':['Нәтижелерді жүктеу мүмкін болмады','Could not load results'],'Не удалось начать тест':['Тестті бастау мүмкін болмады','Could not start test'],'Не удалось отправить ответы':['Жауаптарды жіберу мүмкін болмады','Could not submit answers'],'Не удалось сохранить оценку':['Бағаны сақтау мүмкін болмады','Could not save grade'],'Ошибка авторизации':['Кіру қатесі','Sign-in error'],'Ошибка API':['API қатесі','API error'],'В этой работе нет ответов, требующих ручной проверки':['Бұл жұмыста қолмен тексерілетін жауаптар жоқ','This submission has no answers requiring manual grading'],'Оцени каждый текстовый ответ: укажи баллы или нажми «Не засчитывать» для нуля.':['Әр мәтіндік жауапты бағалаңыз: ұпай енгізіңіз немесе нөл қою үшін «Есептемеу» түймесін басыңыз.','Grade each text answer: enter points or choose “Do not award” for zero.'],'Создаём аккаунт преподавателя':['Мұғалім тіркелгісі жасалуда…','Creating teacher account…'],'Создать аккаунт преподавателя':['Мұғалім тіркелгісін жасау','Create teacher account'],'Сохранить оценку':['Бағаны сақтау','Save grade'],'Сохранить изменения':['Өзгерістерді сақтау','Save changes'],'Сохраняем…':['Сақталуда…','Saving…'],'Отправляем…':['Жіберілуде…','Submitting…'],'Создаём…':['Жасалуда…','Creating…'],'Отправляем ответы…':['Жауаптар жіберілуде…','Submitting answers…'],'Загрузка…':['Жүктелуде…','Loading…'],'Пожалуйста, попробуйте ещё раз.':['Қайталап көріңіз.','Please try again.'],'Опубликовано':['Жарияланды','Published'],'Черновик':['Жоба','Draft'],'На проверке':['Тексерілуде','Awaiting review'],'В процессе':['Орындалуда','In progress'],'Отправлено':['Жіберілді','Submitted'],'Проверено':['Тексерілді','Graded'],'Время истекло':['Уақыт аяқталды','Time expired'],'Возвращено':['Қайтарылды','Returned'],'Отключён':['Өшірілген','Disabled'],'Активен':['Белсенді','Active'],'Настроен':['Бапталған','Configured'],'Не задан':['Орнатылмаған','Not set']
  });
  Object.assign(extraPhrases, {
    'Учётная запись преподавателя создана':['Мұғалім тіркелгісі жасалды','Teacher account created'],'Пользователь с таким email уже существует':['Бұл email мекенжайы бұрыннан тіркелген','A user with this email already exists'],'Неверный email или пароль':['Email немесе құпиясөз қате','Incorrect email or password'],'Ученики входят по общему коду школы, имени и фамилии':['Оқушылар мектептің ортақ кодын, аты мен тегін енгізіп кіреді','Students sign in with the school code and their first and last name'],'Неверный общий код школы':['Мектептің ортақ коды қате','Incorrect school access code'],'Введите имя и фамилию':['Аты мен тегін енгізіңіз','Enter a first and last name'],'Аккаунт недоступен':['Тіркелгі қолжетімсіз','Account unavailable'],'Доступ только для преподавателя':['Тек мұғалімдерге қолжетімді','Teachers only'],'Войдите по общему коду школы, имени и фамилии':['Мектептің ортақ кодын, аты мен тегін енгізіп кіріңіз','Sign in with the school access code and your first and last name'],'Для вопросов с выбором нужно минимум два варианта':['Таңдау сұрағында кемінде екі нұсқа болуы керек','Choice questions need at least two options'],'В вопросе с одним вариантом должен быть ровно один правильный ответ':['Бір жауапты сұрақта дәл бір дұрыс жауап болуы керек','Single-choice questions must have exactly one correct answer'],'Отметьте хотя бы один правильный вариант':['Кемінде бір дұрыс жауапты белгілеңіз','Mark at least one correct answer'],'Задание не найдено':['Тапсырма табылмады','Assignment not found'],'Нельзя опубликовать задание без вопросов':['Сұрақсыз тапсырманы жариялау мүмкін емес','An assignment must have questions before it can be published'],'Удалять тесты может только администратор':['Тесттерді тек әкімші жоя алады','Only an administrator can delete tests'],'Опубликованное задание не найдено':['Жарияланған тапсырма табылмады','Published assignment not found'],'Задание ещё недоступно':['Тапсырма әлі қолжетімді емес','Assignment is not available yet'],'Срок выполнения задания истёк':['Тапсырманы орындау мерзімі аяқталды','The assignment deadline has passed'],'Вы использовали все попытки для этого задания':['Бұл тапсырма бойынша барлық әрекет қолданылды','You have used all attempts for this assignment'],'Активная попытка не найдена':['Белсенді әрекет табылмады','Active attempt not found'],'Ответ содержит неизвестный вопрос':['Жауапта белгісіз сұрақ бар','The answer contains an unknown question'],'Работа не найдена':['Жұмыс табылмады','Submission not found'],'Передан ответ из другой работы':['Басқа жұмысқа тиесілі жауап жіберілді','An answer from another submission was provided'],'Недостаточно прав':['Құқық жеткіліксіз','Insufficient permissions'],'Требуется авторизация':['Авторизация қажет','Authentication required'],'Недействительный или просроченный токен':['Токен жарамсыз немесе мерзімі өткен','Invalid or expired token'],'Слишком много запросов. Повторите позже.':['Сұраулар тым көп. Кейінірек қайталаңыз.','Too many requests. Please try again later.'],'Общий код должен содержать не менее 6 символов':['Ортақ код кемінде 6 таңбадан тұруы керек','The shared code must contain at least 6 characters'],'Первый администратор уже создан; bootstrap отключён':['Бірінші әкімші бұрыннан жасалған; бастапқы баптау өшірілді','The first administrator already exists; bootstrap is disabled'],'Неверный ключ первоначальной настройки':['Бастапқы баптау кілті қате','Invalid initial setup key'],'Ответы отправлены преподавателю на проверку.':['Жауаптар тексеру үшін мұғалімге жіберілді.','Answers sent to the teacher for review.'],'Ответы проверены автоматически.':['Жауаптар автоматты түрде тексерілді.','Answers were graded automatically.'],'Время вышло. Ответы сохранены, но попытка отмечена как просроченная.':['Уақыт аяқталды. Жауаптар сақталды, бірақ әрекет мерзімі өткен деп белгіленді.','Time is up. Answers were saved, but the attempt was marked as expired.'],'Первый администратор создан':['Бірінші әкімші жасалды','The first administrator was created'],'Тест и все его попытки удалены':['Тест және оның барлық әрекеттері жойылды','The test and all its attempts were deleted']
  });
  extraPhrases['максимум'] = ['ең көбі', 'maximum'];
  extraPhrases['Всего попыток'] = ['Барлық талпыныс', 'Total attempts'];
  extraPhrases['сохранённых попыток'] = ['сақталған талпыныс', 'saved attempts'];
  extraPhrases['Предупреждения о списывании в комнатах'] = ['Бөлмелердегі ереже бұзу ескертулері', 'Proctoring warnings in rooms'];
  extraPhrases['Смотреть трансляцию'] = ['Трансляцияны көру', 'Watch screen shares'];
  extraPhrases['Скрыть трансляцию'] = ['Трансляцияны жасыру', 'Hide screen shares'];
  extraPhrases['Выберите комнату для аналитики'] = ['Талдау үшін бөлмені таңдаңыз', 'Select a room for analytics'];
  extraPhrases['Показать аналитику'] = ['Талдауды көрсету', 'Show analytics'];
  extraPhrases['Аналитика комнаты'] = ['Бөлме талдауы', 'Room analytics'];
  extraPhrases['Средний результат'] = ['Орташа нәтиже', 'Average score'];
  extraPhrases['Медианное время'] = ['Медианалық уақыт', 'Median time'];
  extraPhrases['Частые ошибки по вопросам'] = ['Сұрақтар бойынша жиі қателер', 'Common question errors'];
  extraPhrases['завершённых попыток'] = ['аяқталған әрекет', 'completed attempts'];
  extraPhrases['без ответа'] = ['жауапсыз', 'unanswered'];
  extraPhrases['Ученик? Войти в тест по коду комнаты'] = ['Оқушысыз ба? Тестке бөлме коды арқылы кіріңіз', 'Student? Join a test with a room code'];
  extraPhrases['Код комнаты выдаёт преподаватель'] = ['Бөлме кодын мұғалім береді', 'Your teacher provides the room code'];
  extraPhrases['Войти в школьный кабинет по общему коду'] = ['Жалпы кодпен мектеп кабинетіне кіру', 'Sign in to the school portal with a school code'];
  extraPhrases['Вход сотрудника'] = ['Қызметкерге кіру', 'Staff sign in'];
  extraPhrases['Попытка завершена: три предупреждения о переключении вкладки. Сохранённые ответы проверены.'] = ['Қойындыдан шығу туралы үшінші ескертуден кейін әрекет аяқталды. Сақталған жауаптар тексерілді.', 'The attempt ended after three tab-switch warnings. Saved answers were graded.'];
  Object.assign(extraPhrases, {
    'Сессия завершена': ['Сеанс аяқталды', 'Session ended'],
    'Сессия завершена. Войдите снова.': ['Сеанс аяқталды. Қайта кіріңіз.', 'Your session has ended. Sign in again.'],
    'Проверяем вход…': ['Кіру тексерілуде…', 'Restoring session…'],
    'Нет связи с сервером. Проверьте подключение и повторите попытку.': ['Сервермен байланыс жоқ. Байланысты тексеріп, қайталап көріңіз.', 'Cannot reach the server. Check your connection and try again.'],
    'Сервер не ответил вовремя. Повторите попытку.': ['Сервер уақытында жауап бермеді. Қайталап көріңіз.', 'The server did not respond in time. Please try again.'],
    'Сервер вернул некорректный ответ': ['Сервер жарамсыз жауап қайтарды', 'The server returned an invalid response'],
    'Выйти? Неотправленные ответы будут удалены.': ['Шығасыз ба? Жіберілмеген жауаптар жойылады.', 'Exit? Answers that have not been submitted will be discarded.'],
    'Введите предмет, название и текст каждого вопроса': ['Пәнді, атауды және әр сұрақтың мәтінін енгізіңіз', 'Enter the subject, title, and text of each question'],
    'Укажите баллы от 0.01 до 10000, не более двух знаков после запятой': ['0.01 мен 10000 аралығында, үтірден кейін екі таңбадан аспайтын ұпай енгізіңіз', 'Enter points from 0.01 to 10000 with at most two decimal places'],
    'Укажите баллы от 0 до 10000, не более двух знаков после запятой': ['0 мен 10000 аралығында, үтірден кейін екі таңбадан аспайтын ұпай енгізіңіз', 'Enter points from 0 to 10000 with at most two decimal places'],
    'Задание сохранено как черновик. Нажмите «Опубликовать» в списке заданий.': ['Тапсырма жоба ретінде сақталды. Тапсырмалар тізіміндегі «Жариялау» түймесін басыңыз.', 'The assignment was saved as a draft. Choose Publish in the assignment list.'],
    'Опубликовать': ['Жариялау', 'Publish'], 'Задание опубликовано': ['Тапсырма жарияланды', 'Assignment published'],
    'Баллы за текстовый ответ преподаватель выставляет при проверке.': ['Мәтіндік жауапқа ұпайды мұғалім тексеру кезінде қояды.', 'The teacher awards points for text answers when grading.'],
    'Засчитать · 1 балл': ['Есептеу · 1 ұпай', 'Award · 1 point'],
    'Можно выставить от 0 до 10000 баллов.': ['0 мен 10000 аралығында ұпай қоюға болады.', 'You can award from 0 to 10000 points.'],
    'Проценты рассчитаны по вопросам с автоматической проверкой. Баллы за текстовые ответы входят в итоговую оценку.': ['Пайыздар автоматты тексерілетін сұрақтар бойынша есептеледі. Мәтіндік жауаптардың ұпайлары қорытынды бағаға кіреді.', 'Percentages cover automatically graded questions. Points for text answers are included in the total score.'],
    'Осталось': ['Қалды', 'Time left'],
    'Средний результат автопроверки': ['Автоматты тексерудің орташа нәтижесі', 'Average automatic score'],
    'Автоматических ответов оценено': ['Автоматты бағаланған жауаптар', 'Automatically scored answers'],
    'Процентные диаграммы доступны для оценённых вопросов с автоматической проверкой.': ['Пайыздық диаграммалар автоматты тексерілген сұрақтар үшін қолжетімді.', 'Percentage charts are available for scored, automatically graded questions.'],
    'Введите предмет и название задания': ['Пән мен тапсырма атауын енгізіңіз', 'Enter the subject and assignment title'],
    'Этот тип вопроса пока не поддерживается': ['Бұл сұрақ түріне әзірге қолдау жоқ', 'This question type is not supported yet'],
    'Текст вопроса и вариантов не может быть пустым': ['Сұрақ пен нұсқалардың мәтіні бос болмауы керек', 'Question and option text cannot be empty'],
    'Сумма баллов не может превышать 999999.99': ['Жалпы ұпай 999999.99 санынан аспауы керек', 'Total points cannot exceed 999999.99'],
    'Класс не найден': ['Сынып табылмады', 'Class not found'],
    'Нельзя отправить несколько ответов на один вопрос': ['Бір сұраққа бірнеше жауап жіберуге болмайды', 'You cannot submit multiple answers for one question'],
    'Выбран недопустимый вариант ответа': ['Жарамсыз жауап нұсқасы таңдалды', 'An invalid answer option was selected'],
    'Выбраны недопустимые варианты ответа': ['Жарамсыз жауап нұсқалары таңдалды', 'Invalid answer options were selected'],
    'Укажите допустимый числовой ответ': ['Жарамды сандық жауапты енгізіңіз', 'Enter a valid numeric answer'],
    'Для текстового вопроса отправьте текст': ['Мәтіндік сұраққа мәтін жіберіңіз', 'Submit text for a text question'],
    'Нельзя оценить незавершённую попытку': ['Аяқталмаған әрекетті бағалауға болмайды', 'An unfinished attempt cannot be graded'],
    'Ответ повторяется в оценке': ['Бағалауда жауап қайталанған', 'An answer is repeated in the grade'],
    'Оцените каждый ответ перед сохранением': ['Сақтамас бұрын әр жауапты бағалаңыз', 'Grade every answer before saving'],
    'Работа отправлена после окончания времени. Проверьте ответы и подтвердите оценку.': ['Жұмыс уақыт аяқталғаннан кейін жіберілді. Жауаптарды тексеріп, бағаны растаңыз.', 'This work was submitted after the time limit. Review the answers and confirm the grade.'],
    'Ответы временно сохраняются в этой вкладке. Для сдачи работы нажмите «Отправить ответы».': ['Жауаптар осы қойындыда уақытша сақталады. Жұмысты тапсыру үшін «Жауаптарды жіберу» түймесін басыңыз.', 'Answers are saved temporarily in this tab. Select Submit answers to hand in your work.'],
  });
  const t = (text: string) => {
    if (language === 'ru') return text;
    const gradeError = text.match(/^Баллы за вопрос не могут превышать (.+)$/);
    if (gradeError) return language === 'kk' ? `Сұрақ ұпайы ${gradeError[1]} ұпайдан аспауы керек` : `Points for a question cannot exceed ${gradeError[1]}`;
    const reviewError = text.match(/^Баллы должны быть от 0 до (.+) за вопрос «(.+)»$/);
    if (reviewError) return language === 'kk' ? `«${reviewError[2]}» сұрағы бойынша ұпай 0 мен ${reviewError[1]} аралығында болуы керек` : `Points for “${reviewError[2]}” must be between 0 and ${reviewError[1]}`;
    const apiError = text.match(/^Ошибка API \((\d+)\)$/);
    if (apiError) return language === 'kk' ? `API қатесі (${apiError[1]})` : `API error (${apiError[1]})`;
    return (extraPhrases[text] || phrases[text])?.[language === 'kk' ? 0 : 1] || text;
  };
  const [token, setToken] = useState('');
  const [user, setUser] = useState<User | null>(null);
  const [loginMode, setLoginMode] = useState<'student' | 'staff'>('staff');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [studentCode, setStudentCode] = useState('');
  const [studentFirstName, setStudentFirstName] = useState('');
  const [studentLastName, setStudentLastName] = useState('');
  const [view, setView] = useState<'overview' | 'assignments' | 'create' | 'results' | 'student' | 'users' | 'school'>('overview');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [dashboard, setDashboard] = useState({ activeAssignments: 0, submissionsAwaitingReview: 0, gradedSubmissions: 0, totalSubmissions: 0 });
  const [assignments, setAssignments] = useState<any[]>([]);
  const [roomsByAssignment, setRoomsByAssignment] = useState<Record<string, any[]>>({});
  const [selectedAnalyticsRoom, setSelectedAnalyticsRoom] = useState('');
  const [roomAnalytics, setRoomAnalytics] = useState<any | null>(null);
  const [watchingLiveRoom, setWatchingLiveRoom] = useState('');
  const [roomTargetDraft, setRoomTargetDraft] = useState('30');
  const [roomDurationDraft, setRoomDurationDraft] = useState('');
  const [available, setAvailable] = useState<any[]>([]);
  const [studentHistory, setStudentHistory] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [selectedResults, setSelectedResults] = useState<any | null>(null);
  const [monitorOpen, setMonitorOpen] = useState(false);
  const [studentResult, setStudentResult] = useState<any | null>(null);
  const [selectedAssignment, setSelectedAssignment] = useState<any | null>(null);
  const [submission, setSubmission] = useState<any | null>(null);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [roomCode, setRoomCode] = useState('');
  const [draftStatus, setDraftStatus] = useState<'saved' | 'saving' | 'error'>('saved');
  const [title, setTitle] = useState('');
  const [subjectName, setSubjectName] = useState('');
  const [description, setDescription] = useState('');
  const [timeLimit, setTimeLimit] = useState('');
  const [availableFrom, setAvailableFrom] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [maxAttempts, setMaxAttempts] = useState('1');
  const [lobbyTarget, setLobbyTarget] = useState('');
  const [shuffleQuestions, setShuffleQuestions] = useState(true);
  const [shuffleOptions, setShuffleOptions] = useState(true);
  const [importingWord, setImportingWord] = useState(false);
  const [questions, setQuestions] = useState<QuestionDraft[]>([newQuestion()]);
  const [accountFirstName, setAccountFirstName] = useState('');
  const [accountLastName, setAccountLastName] = useState('');
  const [accountEmail, setAccountEmail] = useState('');
  const [accountPassword, setAccountPassword] = useState('');
  const [studentAccessCodeInput, setStudentAccessCodeInput] = useState('');
  const [studentAccessCodeConfigured, setStudentAccessCodeConfigured] = useState(false);
  const [schoolClasses, setSchoolClasses] = useState<any[]>([]);
  const [schoolStudents, setSchoolStudents] = useState<any[]>([]);
  const [classNameDraft, setClassNameDraft] = useState('');
  const [academicYearDraft, setAcademicYearDraft] = useState(String(new Date().getFullYear()) + '-' + String(new Date().getFullYear() + 1));
  const [newStudentFirstName, setNewStudentFirstName] = useState('');
  const [newStudentLastName, setNewStudentLastName] = useState('');
  const [newStudentNo, setNewStudentNo] = useState('');
  const [newStudentClassId, setNewStudentClassId] = useState('');
  const [assignmentClassId, setAssignmentClassId] = useState('');
  const [assignmentRoster, setAssignmentRoster] = useState<any[]>([]);
  const [assignmentStudentIds, setAssignmentStudentIds] = useState<string[]>([]);
  const [manualGrades, setManualGrades] = useState<Record<string, string>>({});
  const [manualComments, setManualComments] = useState<Record<string, string>>({});
  const [submissionFeedback, setSubmissionFeedback] = useState<Record<string, string>>({});
  const [restoringSession, setRestoringSession] = useState(true);
  const [clock, setClock] = useState(Date.now());
  const [onlineRetry, setOnlineRetry] = useState(0);
  const sessionVersion = useRef(0);
  const submissionInFlight = useRef(false);
  const lastAutosavedAnswers = useRef<Record<string, string>>({});

  useEffect(() => {
    const saved = readStorage(window.localStorage, 'school-crm-language');
    if (saved === 'kk' || saved === 'ru' || saved === 'en') setLanguage(saved);
    setLanguageLoaded(true);
  }, []);
  useEffect(() => {
    if (!languageLoaded) return;
    writeStorage(window.localStorage, 'school-crm-language', language);
    document.documentElement.lang = language;
    document.title = language === 'kk' ? 'Zialy Urpaq мектебі | Оқу платформасы' : language === 'en' ? 'Zialy Urpaq School | Learning Platform' : 'Zialy Urpaq мектебі | Учебная платформа';
  }, [language, languageLoaded]);

  const isStaff = user?.role === 'ADMIN' || user?.role === 'TEACHER';
  const clearSession = () => {
    sessionVersion.current++;
    writeStorage(window.sessionStorage, TOKEN_KEY, null);
    writeStorage(window.sessionStorage, ATTEMPT_KEY, null);
    writeStorage(window.localStorage, TOKEN_KEY, null);
    setToken(''); setUser(null); setSubmission(null); setSelectedAssignment(null); setSelectedResults(null); setStudentResult(null);
    setAssignments([]); setAvailable([]); setStudentHistory([]); setAccounts([]); setAnswers({}); setManualGrades({}); setManualComments({}); setSubmissionFeedback({});
    setPassword(''); setStudentCode(''); setStudentFirstName(''); setStudentLastName(''); setEmail('');
    setAccountPassword(''); setAccountEmail(''); setAccountFirstName(''); setAccountLastName('');
    setStudentAccessCodeInput(''); setStudentAccessCodeConfigured(false); setSchoolClasses([]); setSchoolStudents([]); setClassNameDraft(''); setNewStudentFirstName(''); setNewStudentLastName(''); setNewStudentNo(''); setNewStudentClassId(''); setAssignmentClassId('');
    setTitle(''); setSubjectName(''); setDescription(''); setQuestions([newQuestion()]);
    setTimeLimit(''); setAvailableFrom(''); setDueAt(''); setMaxAttempts('1'); setLobbyTarget(''); setShuffleQuestions(true); setShuffleOptions(true); setRoomCode('');
    setDashboard({ activeAssignments: 0, submissionsAwaitingReview: 0, gradedSubmissions: 0, totalSubmissions: 0 });
  };
  const request = async (path: string, options: RequestInit = {}) => {
    const version = sessionVersion.current;
    try {
      const data = await requestJson(apiUrl, path, token, options);
      if (version !== sessionVersion.current) throw new Error('Сессия завершена');
      return data;
    } catch (error) {
      if (version === sessionVersion.current && error instanceof ApiError && error.status === 401 && token) {
        clearSession();
        throw new Error('Сессия завершена. Войдите снова.');
      }
      throw error;
    }
  };

  useEffect(() => {
    let cancelled = false;
    // A school PC must not retain a login after the browser session is closed.
    writeStorage(window.localStorage, TOKEN_KEY, null);
    const savedToken = readStorage(window.sessionStorage, TOKEN_KEY);
    if (!savedToken) { setRestoringSession(false); return; }
    requestJson(apiUrl, '/auth/me', savedToken)
      .then((savedUser: User) => {
        if (cancelled) return;
        setToken(savedToken); setUser(savedUser); setView(savedUser.role === 'STUDENT' ? 'student' : 'overview');
        try {
          const saved = JSON.parse(readStorage(window.sessionStorage, ATTEMPT_KEY) || 'null');
          if (savedUser.role === 'STUDENT' && saved?.userId === savedUser.id && saved.assignment?.id && Array.isArray(saved.assignment.questions) && saved.submission?.id) {
            setSelectedAssignment(saved.assignment); setSubmission(saved.submission); setAnswers(saved.answers || {});
          }
        } catch { writeStorage(window.sessionStorage, ATTEMPT_KEY, null); }
      })
      .catch(error => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) clearSession();
        setMessage(error instanceof Error ? error.message : 'Не удалось загрузить данные');
      })
      .finally(() => { if (!cancelled) setRestoringSession(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!user || user.role !== 'STUDENT') return;
    writeStorage(window.sessionStorage, ATTEMPT_KEY, selectedAssignment && submission
      ? JSON.stringify({ userId: user.id, assignment: selectedAssignment, submission, answers }) : null);
  }, [user, selectedAssignment, submission, answers]);

  useEffect(() => {
    if (!submission) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warnBeforeUnload);
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => { window.removeEventListener('beforeunload', warnBeforeUnload); window.clearInterval(timer); };
  }, [submission]);

  useEffect(() => {
    if (!token || !user) return;
    let cancelled = false;
    const load = async () => {
      try {
        if (user.role === 'STUDENT') {
          const [list, history] = await Promise.all([request('/student/assignments'), request('/student/results')]);
          if (!cancelled) { setAvailable(list); setStudentHistory(history); }
        } else {
          const [stats, list, userList, classes] = await Promise.all([
            request('/dashboard'), request('/assignments'), user.role === 'ADMIN' ? request('/auth/users') : Promise.resolve(null), request('/school/classes'),
          ]);
          if (!cancelled) { setDashboard(stats); setAssignments(list); setSchoolClasses(classes); if (userList) setAccounts(userList); if (!newStudentClassId && classes.length) setNewStudentClassId(classes[0].id); }
          if (!cancelled) await loadTestRooms(list);
          if (user.role === 'ADMIN') {
            const [codeStatus, students] = await Promise.all([request('/auth/student-access-code'), request('/school/students')]);
            if (!cancelled) { setStudentAccessCodeConfigured(codeStatus.configured); setSchoolStudents(students); }
          }
        }
      } catch (error) {
        if (!cancelled) setMessage(error instanceof Error ? error.message : 'Не удалось загрузить данные');
      }
    };
    load();
    return () => { cancelled = true; };
  }, [token, user]);

  const login = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || restoringSession) return;
    setBusy(true); setMessage('');
    try {
      const student = loginMode === 'student';
      const data = await requestJson(apiUrl, `/auth/${student ? 'student-access' : 'login'}`, '', {
        method: 'POST',
        body: JSON.stringify(student
          ? { accessCode: studentCode, firstName: studentFirstName, lastName: studentLastName }
          : { email, password }),
      });
      if (typeof data.accessToken !== 'string' || !data.user?.id) throw new Error('Сервер вернул некорректный ответ');
      sessionVersion.current++;
      writeStorage(window.sessionStorage, TOKEN_KEY, data.accessToken);
      setPassword(''); setStudentCode('');
      setToken(data.accessToken); setUser(data.user); setView(data.user.role === 'STUDENT' ? 'student' : 'overview'); setMessage('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Ошибка авторизации');
    } finally { setBusy(false); }
  };

  const logout = () => {
    if (busy || (submission && !window.confirm(t('Выйти? Неотправленные ответы будут удалены.')))) return;
    clearSession(); setMessage('Вы вышли из системы');
  };

  const exitTest = () => {
    if (busy || !window.confirm(t('Выйти? Неотправленные ответы будут удалены.'))) return;
    setSelectedAssignment(null); setSubmission(null); setAnswers({});
  };

  const refreshStaff = async () => {
    const [stats, list, userList] = await Promise.all([
      request('/dashboard'), request('/assignments'), user?.role === 'ADMIN' ? request('/auth/users') : Promise.resolve(null),
    ]);
    setDashboard(stats); setAssignments(list); if (userList) setAccounts(userList);
    await loadTestRooms(list);
  };

  const loadTestRooms = async (list: any[]) => {
    const roomRows = await Promise.all(list.filter((item: any) => item.status === 'PUBLISHED').map(async (item: any) => {
      try { return [item.id, await request(`/assignments/${item.id}/rooms`)] as const; }
      catch { return [item.id, []] as const; }
    }));
    setRoomsByAssignment(Object.fromEntries(roomRows));
  };

  const createTestRoom = async (assignment: any) => {
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      const room = await request(`/assignments/${assignment.id}/rooms`, { method: 'POST', body: JSON.stringify({
        lobbyTarget: Number(roomTargetDraft), durationMinutes: roomDurationDraft ? Number(roomDurationDraft) : undefined,
      }) });
      setRoomsByAssignment(old => ({ ...old, [assignment.id]: [room, ...(old[assignment.id] || [])] }));
      setMessage(`${t('Создана комната')}: ${room.joinCode}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : t('Не удалось создать комнату')); }
    finally { setBusy(false); }
  };

  const startTestRoom = async (room: any) => {
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      const updated = await request(`/rooms/${room.id}/start`, { method: 'POST', body: JSON.stringify({}) });
      setRoomsByAssignment(old => ({ ...old, [room.assignmentId]: (old[room.assignmentId] || []).map(item => item.id === room.id ? { ...item, ...updated } : item) }));
      setMessage(t('Тест запущен для учеников'));
    } catch (error) { setMessage(error instanceof Error ? error.message : t('Не удалось запустить тест')); }
    finally { setBusy(false); }
  };

  const loadRoomAnalytics = async () => {
    if (!selectedAnalyticsRoom || busy) return;
    setBusy(true); setMessage('');
    try { setRoomAnalytics(await request(`/rooms/${selectedAnalyticsRoom}/analytics`)); }
    catch (error) { setMessage(error instanceof Error ? error.message : t('Не удалось загрузить аналитику')); }
    finally { setBusy(false); }
  };

  const refreshRoomSummaries = async () => {
    const rooms = await request('/assignment-rooms');
    const byId = new Map(rooms.map((room: any) => [room.id, room]));
    setAssignments(current => current.map(item => {
      const room: any = byId.get(item.id);
      return room ? { ...item, waitingCount: room.waitingCount, roomStartedAt: room.roomStartedAt } : item;
    }));
  };

  const createAssignment = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setMessage('');
    let createdId: string | null = null;
    try {
      if (!subjectName.trim() || !title.trim() || questions.some(q => !q.prompt.trim())) throw new Error('Введите предмет, название и текст каждого вопроса');
      if (questions.some(q => !['SHORT_TEXT', 'LONG_TEXT'].includes(q.type) && !validPoints(Number(q.points), 0.01))) throw new Error('Укажите баллы от 0.01 до 10000, не более двух знаков после запятой');
      if (questions.some(q => q.type === 'NUMERIC' && (!Number.isFinite(q.correctValue) || Math.abs(q.correctValue) > 9999999999.9999 || Math.abs(q.correctValue * 10000 - Math.round(q.correctValue * 10000)) > 1e-7 || !Number.isFinite(q.tolerance) || q.tolerance < 0))) throw new Error('Проверьте правильный числовой ответ и допустимую погрешность');
      if (availableFrom && dueAt && new Date(dueAt).getTime() <= new Date(availableFrom).getTime()) throw new Error('Срок сдачи должен быть позже даты открытия задания');
      const payload = {
        title: title.trim(), subjectName: subjectName.trim(), description: description.trim() || undefined, classId: assignmentClassId || undefined,
        studentIds: assignmentStudentIds.length ? assignmentStudentIds : undefined,
        timeLimitMinutes: timeLimit ? Number(timeLimit) : undefined,
        availableFrom: availableFrom ? new Date(availableFrom).toISOString() : undefined,
        dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
        maxAttempts: Number(maxAttempts),
        lobbyTarget: lobbyTarget ? Number(lobbyTarget) : undefined,
        shuffleQuestions,
        shuffleOptions,
        questions: questions.map(q => ({
          type: q.type, prompt: q.prompt.trim(), ...(!['SHORT_TEXT', 'LONG_TEXT'].includes(q.type) ? { points: Number(q.points) } : {}),
          ...(q.type === 'NUMERIC' ? { config: { correctValue: Number(q.correctValue), tolerance: Number(q.tolerance) } } : {}),
          ...(q.type === 'SINGLE_CHOICE' || q.type === 'MULTIPLE_CHOICE'
            ? { options: q.options.map(o => ({ text: o.text.trim(), isCorrect: o.isCorrect })) }
            : {}),
        })),
      };
      const created = await request('/assignments', { method: 'POST', body: JSON.stringify(payload) });
      createdId = created.id;
      setTitle(''); setSubjectName(''); setDescription(''); setAssignmentClassId(''); setAssignmentRoster([]); setAssignmentStudentIds([]); setTimeLimit(''); setAvailableFrom(''); setDueAt(''); setMaxAttempts('1'); setLobbyTarget(''); setShuffleQuestions(true); setShuffleOptions(true); setQuestions([newQuestion()]);
      setAssignments(old => [created, ...old]); setView('assignments');
      await request(`/assignments/${created.id}/publish`, { method: 'PATCH' });
      createdId = null;
      setAssignments(old => old.map(item => item.id === created.id ? { ...item, status: 'PUBLISHED' } : item));
      setMessage('Задание создано и опубликовано');
      await refreshStaff();
    } catch (error) {
      setMessage(createdId ? 'Задание сохранено как черновик. Нажмите «Опубликовать» в списке заданий.' : error instanceof Error ? error.message : 'Не удалось создать задание');
    } finally { setBusy(false); }
  };

  const importWordTemplate = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setImportingWord(true); setMessage('');
    try {
      const form = new FormData(); form.append('file', file);
      const imported = await request('/assignments/import-template', { method: 'POST', body: form });
      setTitle(imported.title);
      setSubjectName(imported.subjectName);
      setDescription(imported.description || '');
      setTimeLimit(imported.timeLimitMinutes ? String(imported.timeLimitMinutes) : '');
      setMaxAttempts(String(imported.maxAttempts || 1));
      setLobbyTarget(imported.lobbyTarget ? String(imported.lobbyTarget) : '');
      setShuffleQuestions(imported.shuffleQuestions !== false);
      setShuffleOptions(imported.shuffleOptions !== false);
      setQuestions(imported.questions.map((question: any) => ({
        type: question.type,
        prompt: question.prompt,
        points: question.points ?? 1,
        options: question.options?.length ? question.options : [{ text: '', isCorrect: true }, { text: '', isCorrect: false }],
      })));
      setMessage(t('Шаблон загружен. Проверьте вопросы и ответы, затем опубликуйте задание.'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('Не удалось прочитать шаблон Word'));
    } finally {
      setImportingWord(false);
      input.value = '';
    }
  };

  const publishAssignment = async (assignment: any) => {
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      await request(`/assignments/${assignment.id}/publish`, { method: 'PATCH' });
      setAssignments(old => old.map(item => item.id === assignment.id ? { ...item, status: 'PUBLISHED' } : item));
      setMessage('Задание опубликовано');
      await refreshStaff();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Не удалось создать задание'); }
    finally { setBusy(false); }
  };

  const launchRoom = async (assignment: any) => {
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      const result = await request(`/assignments/${assignment.id}/room/start`, { method: 'POST', body: JSON.stringify({}) });
      setMessage(`${t('Тест запущен для учеников')}: ${result.students}`);
      await refreshStaff();
    } catch (error) { setMessage(error instanceof Error ? error.message : t('Не удалось запустить тест')); }
    finally { setBusy(false); }
  };

  const exportResultsCsv = () => {
    if (!selectedResults) return;
    const submissions = selectedResults.submissions as any[];
    const questions = selectedResults.assignment.questions || [];
    const cell = (value: unknown) => {
      let text = value == null ? '' : String(value);
      if (/^[=+\-@\t\r]/u.test(text)) text = `'${text}`;
      return `"${text.replace(/"/gu, '""')}"`;
    };
    const rows = [[t('Имя'), t('Фамилия'), t('Попытка'), t('Статус'), t('Баллы'), t('Правильных ответов'), t('Начало'), t('Отправлено'), t('Предупреждения о переключении вкладки'), ...questions.map((question: any) => question.prompt)], ...submissions.map(item => [
      item.studentFirstName, item.studentLastName, item.attemptNo, item.status, item.totalScore ?? '', item.answers.filter((answer: any) => answer.isCorrect).length,
      new Date(item.startedAt).toLocaleString(dateLocale), item.submittedAt ? new Date(item.submittedAt).toLocaleString(dateLocale) : '', item.proctorWarnings,
      ...questions.map((question: any) => answerText(item.answers.find((answer: any) => answer.questionId === question.id) || { question: { options: [] } }, '')),
    ])];
    const csv = '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `${String(selectedResults.assignment.title).replace(/[^\p{L}\p{N}-]+/gu, '-').slice(0, 80) || 'test'}-results.csv`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const exportResultsDatabase = async () => {
    if (!selectedResults || busy) return;
    setBusy(true); setMessage('');
    const abort = new AbortController(); const timer = window.setTimeout(() => abort.abort(), 45000);
    try {
      const response = await fetch(`${apiUrl}/assignments/${selectedResults.assignment.id}/results.sqlite`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: abort.signal });
      if (!response.ok) { const problem = await response.json().catch(() => null); throw new Error(problem?.message || `Export: ${response.status}`); }
      const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a');
      link.href = url; link.download = `test-results-${new Date().toISOString().slice(0,10)}.sqlite`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Export failed'); }
    finally { window.clearTimeout(timer); setBusy(false); }
  };

  const createAccount = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      const result = await request('/auth/users', { method: 'POST', body: JSON.stringify({ role: 'TEACHER', firstName: accountFirstName, lastName: accountLastName, email: accountEmail, password: accountPassword }) });
      setAccountFirstName(''); setAccountLastName(''); setAccountEmail(''); setAccountPassword('');
      await refreshStaff();
      setMessage(result.message || 'Учётная запись создана. Передайте пользователю email и пароль.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Не удалось создать учётную запись'); }
    finally { setBusy(false); }
  };

  const createSchoolClass = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      await request('/school/classes', { method: 'POST', body: JSON.stringify({ name: classNameDraft, academicYear: academicYearDraft }) });
      setClassNameDraft('');
      const classes = await request('/school/classes');
      setSchoolClasses(classes);
      if (classes.length && !newStudentClassId) setNewStudentClassId(classes[0].id);
      setMessage('Класс создан');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Не удалось создать класс'); }
    finally { setBusy(false); }
  };

  const createSchoolStudent = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      const result = await request('/school/students', { method: 'POST', body: JSON.stringify({ firstName: newStudentFirstName, lastName: newStudentLastName, classId: newStudentClassId, ...(newStudentNo.trim() ? { studentNo: newStudentNo.trim() } : {}) }) });
      setNewStudentFirstName(''); setNewStudentLastName(''); setNewStudentNo('');
      setSchoolStudents(await request('/school/students'));
      setMessage('Ученик ' + result.lastName + ' ' + result.firstName + ' добавлен в список. Для входа ему нужен общий код школы.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Не удалось добавить ученика'); }
    finally { setBusy(false); }
  };

  const saveStudentAccessCode = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setMessage('');
    try {
      const result = await request('/auth/student-access-code', { method: 'POST', body: JSON.stringify({ accessCode: studentAccessCodeInput }) });
      setStudentAccessCodeInput(''); setStudentAccessCodeConfigured(true);
      setMessage(result.message || 'Общий код входа учеников обновлён');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Не удалось сохранить код'); }
    finally { setBusy(false); }
  };

  const deleteAssignment = async (assignment: any) => {
    if (user?.role !== 'ADMIN' || !window.confirm(`${t('Удалить тест')} «${assignment.title}» ${t('и все его попытки и результаты? Это действие нельзя отменить.')}`)) return;
    setBusy(true); setMessage('');
    try {
      const result = await request(`/assignments/${assignment.id}`, { method: 'DELETE' });
      await refreshStaff();
      if (selectedResults?.assignment?.id === assignment.id) setSelectedResults(null);
      setMessage(result.message || 'Тест удалён');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Не удалось удалить тест'); }
    finally { setBusy(false); }
  };

  const openResults = async (assignment: any) => {
    setBusy(true); setMessage('');
    try {
      const result = await request(`/assignments/${assignment.id}/results`);
      setSelectedResults(result); setManualGrades({}); setManualComments({}); setSubmissionFeedback({}); setMonitorOpen(false); setView('results');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Не удалось загрузить результаты'); }
    finally { setBusy(false); }
  };

  const openStudentResult = async (submissionId: string) => {
    setBusy(true); setMessage('');
    try {
      const result = await request(`/student/submissions/${submissionId}/result`);
      setStudentResult(result);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось загрузить результат');
    } finally { setBusy(false); }
  };

  const startTest = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      const result = await request('/student/rooms/join', { method: 'POST', body: JSON.stringify({ code: roomCode }) });
      const restoredAnswers = Object.fromEntries((result.answers || []).map((answer: any) => [
        answer.questionId, answer.jsonValue ?? (answer.numericValue === null ? answer.textValue ?? '' : String(answer.numericValue)),
      ]));
      setSelectedAssignment(result.assignment); setSubmission({ ...result.submission, room: result.room }); setAnswers(restoredAnswers);
      lastAutosavedAnswers.current = Object.fromEntries(Object.entries(restoredAnswers).map(([id, value]) => [id, JSON.stringify(value)]));
      setStudentResult(null); setRoomCode('');
      if (result.room?.waiting) setMessage(`${t('Ожидаем запуск преподавателя')} · ${result.room.count}/${result.room.target}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : t('Не удалось подключиться к комнате')); }
    finally { setBusy(false); }
  };

  const submitTest = async () => {
    if (!selectedAssignment || !submission || submissionInFlight.current) return;
    submissionInFlight.current = true;
    setBusy(true); setMessage('');
    try {
      const outgoing = selectedAssignment.questions.map((q: any) => {
        const value = answers[q.id];
        if (q.type === 'SINGLE_CHOICE') return { questionId: q.id, jsonValue: value || '' };
        if (q.type === 'MULTIPLE_CHOICE') return { questionId: q.id, jsonValue: Array.isArray(value) ? value : [] };
        if (q.type === 'NUMERIC') return { questionId: q.id, numericValue: value === '' || value == null ? undefined : Number(value) };
        return { questionId: q.id, textValue: value || '' };
      });
      const result = await request(`/student/assignments/${selectedAssignment.id}/submissions/${submission.id}/submit`, {
        method: 'POST', body: JSON.stringify({ answers: outgoing }),
      });
      setMessage(result.message);
      try { setStudentResult(await request(`/student/submissions/${submission.id}/result`)); }
      catch { setStudentResult({ assignmentTitle: selectedAssignment.title, score: result.totalScore, rank: null, top: [] }); }
      setSubmission(null); setSelectedAssignment(null); setAnswers({});
      lastAutosavedAnswers.current = {};
      writeStorage(window.sessionStorage, ATTEMPT_KEY, null);
      // A failed list refresh must not make a successful submission look failed.
      try {
        const [list, history] = await Promise.all([request('/student/assignments'), request('/student/results')]);
        setAvailable(list); setStudentHistory(history);
      } catch { /* Keep the submission confirmation. */ }
    } catch (error) {
      // The server may have finalized the deadline while this tab was offline.
      try {
        const result = await request(`/student/submissions/${submission.id}/result`);
        setStudentResult(result); setSubmission(null); setSelectedAssignment(null); setAnswers({});
        writeStorage(window.sessionStorage, ATTEMPT_KEY, null);
      } catch { setMessage(error instanceof Error ? error.message : 'Не удалось отправить ответы'); }
    }
    finally { submissionInFlight.current = false; setBusy(false); }
  };

  const returnSubmission = async (item: any) => {
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      await request(`/submissions/${item.id}/return`, { method: 'PATCH', body: JSON.stringify({
        feedback: submissionFeedback[item.id] !== undefined ? submissionFeedback[item.id].trim() : (item.feedback ?? 'Исправьте работу и отправьте повторно'),
      }) });
      setMessage('Работа возвращена ученику на исправление');
      setSelectedResults(await request(`/assignments/${selectedResults.assignment.id}/results`));
      await refreshStaff();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Не удалось вернуть работу'); }
    finally { setBusy(false); }
  };

  const reviseReturned = async (submissionId: string) => {
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      const reopened = await request(`/student/submissions/${submissionId}/reopen`, { method: 'POST', body: JSON.stringify({}) });
      const restored: Record<string, any> = {};
      for (const answer of reopened.answers || []) {
        const question = reopened.assignment.questions.find((q: any) => q.id === answer.questionId);
        if (!question) continue;
        if (question.type === 'NUMERIC') restored[answer.questionId] = answer.numericValue == null ? '' : String(answer.numericValue);
        else if (question.type === 'SINGLE_CHOICE' || question.type === 'MULTIPLE_CHOICE') restored[answer.questionId] = answer.jsonValue ?? (question.type === 'MULTIPLE_CHOICE' ? [] : '');
        else restored[answer.questionId] = answer.textValue ?? '';
      }
      setSelectedAssignment(reopened.assignment); setSubmission(reopened.submission); setAnswers(restored);
      setStudentResult(null); setView('student'); setDraftStatus('saved');
      lastAutosavedAnswers.current = {};
      writeStorage(window.sessionStorage, ATTEMPT_KEY, JSON.stringify({ userId: user?.id, assignment: reopened.assignment, submission: reopened.submission, answers: restored }));
      setMessage('Работа открыта для исправления. После изменений отправьте её повторно.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Не удалось открыть работу для исправления'); }
    finally { setBusy(false); }
  };

  const gradeSubmission = async (item: any) => {
    const answerRows = item.answers.filter((a: any) => isManualQuestion(a.question.type));
    if (!answerRows.length && item.status !== 'EXPIRED') { setMessage('В этой работе нет ответов, требующих ручной проверки'); return; }
    const values = [];
    for (const answer of answerRows) {
      const rawPoints = manualGrades[answer.id] ?? (answer.awardedPoints === null ? '' : String(answer.awardedPoints));
      if (rawPoints.trim() === '') { setMessage('Оцени каждый текстовый ответ: укажи баллы или нажми «Не засчитывать» для нуля.'); return; }
      const awardedPoints = Number(rawPoints);
      if (!validPoints(awardedPoints)) {
        setMessage('Укажите баллы от 0 до 10000, не более двух знаков после запятой'); return;
      }
      values.push({ answerId: answer.id, awardedPoints, teacherComment: manualComments[answer.id] ?? answer.teacherComment ?? undefined });
    }
    setBusy(true); setMessage('');
    try {
      await request(`/submissions/${item.id}/grade`, { method: 'PATCH', body: JSON.stringify({ answers: values, feedback: submissionFeedback[item.id] !== undefined ? submissionFeedback[item.id].trim() : (item.feedback ?? undefined) }) });
      const updated = await request(`/assignments/${selectedResults.assignment.id}/results`);
      setSelectedResults(updated);
      setManualGrades(old => Object.fromEntries(Object.entries(old).filter(([id]) => !answerRows.some((answer: any) => answer.id === id))));
      setManualComments(old => Object.fromEntries(Object.entries(old).filter(([id]) => !answerRows.some((answer: any) => answer.id === id))));
      setSubmissionFeedback(old => { const next = { ...old }; delete next[item.id]; return next; });
      setMessage('Оценка сохранена');
      await refreshStaff();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Не удалось сохранить оценку'); }
    finally { setBusy(false); }
  };

  const updateQuestion = (index: number, patch: Partial<QuestionDraft>) =>
    setQuestions(current => current.map((q, i) => i === index ? { ...q, ...patch } : q));
  const updateOption = (qi: number, oi: number, patch: Partial<OptionDraft>) =>
    setQuestions(current => current.map((q, i) => i === qi ? {
      ...q, options: q.options.map((o, j) => j === oi ? { ...o, ...patch } : {
        ...o, ...(patch.isCorrect && q.type === 'SINGLE_CHOICE' ? { isCorrect: false } : {}),
      }),
    } : q));
  const removeOption = (qi: number, oi: number) => setQuestions(current => current.map((q, i) => {
    if (i !== qi || q.options.length <= 2) return q;
    const options = q.options.filter((_, j) => j !== oi);
    if (q.type === 'SINGLE_CHOICE' && !options.some(option => option.isCorrect)) options[0].isCorrect = true;
    return { ...q, options };
  }));

  const resultsAnalytics = (() => {
    if (!selectedResults) return null;
    const submissions = selectedResults.submissions as any[];
    const finished = submissions.filter(item => item.submittedAt);
    const graded = finished.filter(item => item.totalScore !== null && item.totalScore !== undefined);
    const scoreRates = graded.map(item => automaticScoreRate(item.answers || [])).filter((rate): rate is number => rate !== null);
    const questionMap = new Map<string, { prompt: string; position: number; earned: number; possible: number; responses: number }>();
    for (const item of finished) for (const answer of item.answers || []) {
      if (isManualQuestion(answer.question.type)) continue;
      if (answer.awardedPoints === null || answer.awardedPoints === undefined) continue;
      const id = answer.questionId || answer.question?.id;
      if (!id) continue;
      const row = questionMap.get(id) || { prompt: answer.question.prompt, position: answer.question.position, earned: 0, possible: 0, responses: 0 };
      row.earned += Math.max(0, Number(answer.awardedPoints));
      row.possible += Math.max(0, Number(answer.question.points));
      row.responses++;
      questionMap.set(id, row);
    }
    const questions = [...questionMap.values()].sort((a, b) => a.position - b.position).map(row => ({ ...row, rate: row.possible ? Math.round(row.earned / row.possible * 100) : 0 }));
    const buckets = [0, 0, 0, 0];
    for (const rate of scoreRates) buckets[Math.min(3, Math.floor(rate / 25))]++;
    return { finished: finished.length, graded: scoreRates.length, average: scoreRates.length ? Math.round(scoreRates.reduce((a, b) => a + b, 0) / scoreRates.length) : null, questions, buckets };
  })();

  const deadlines = submission && selectedAssignment ? [
    selectedAssignment.timeLimitMinutes ? new Date(submission.startedAt).getTime() + selectedAssignment.timeLimitMinutes * 60000 : Infinity,
    submission.finishReason === 'RESUBMISSION' ? Infinity : selectedAssignment.dueAt ? new Date(selectedAssignment.dueAt).getTime() : Infinity,
  ] : [Infinity];
  const deadline = Math.min(...deadlines);
  const timeRemaining = Number.isFinite(deadline) ? Math.max(0, Math.ceil((deadline - clock) / 1000)) : null;

  const questionCountLabel = language === 'kk' ? 'сұрақ' : language === 'en' ? (questions.length === 1 ? 'question' : 'questions') : questions.length % 10 === 1 && questions.length % 100 !== 11 ? 'вопрос' : questions.length % 10 >= 2 && questions.length % 10 <= 4 && (questions.length % 100 < 12 || questions.length % 100 > 14) ? 'вопроса' : 'вопросов';
  const dateLocale = language === 'kk' ? 'kk-KZ' : language === 'en' ? 'en-US' : 'ru-RU';
  const languagePicker = <label className="languagePicker"><span>{t('Язык')}</span><select value={language} onChange={event => setLanguage(event.target.value as Language)} aria-label={t('Язык')}><option value="kk">Қазақша</option><option value="ru">Русский</option><option value="en">English</option></select></label>;
  const shouldPollLobby = isStaff && view === 'assignments' && assignments.some(item => item.status === 'PUBLISHED' && item.lobbyTarget && !item.roomStartedAt);

  useEffect(() => {
    if (!token || !isStaff || view !== 'assignments') return;
    const pollRooms = () => { void loadTestRooms(assignments); };
    pollRooms();
    const interval = window.setInterval(pollRooms, 5000);
    return () => window.clearInterval(interval);
  }, [token, isStaff, view, assignments]);

  useEffect(() => {
    const online = () => setOnlineRetry(value => value + 1);
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, []);

  useEffect(() => {
    if (!token || !submission?.id || user?.role !== 'STUDENT' || submission.status === 'WAITING') return;
    let cancelled = false;
    request(`/student/rooms/${submission.id}`).then(result => {
      if (cancelled) return;
        setSubmission({ ...result.submission, room: result.room });
      setSelectedAssignment(result.assignment);
      const saved = Object.fromEntries((result.answers || []).map((answer: any) => [
        answer.questionId, answer.jsonValue ?? (answer.numericValue === null ? answer.textValue ?? '' : String(answer.numericValue)),
      ]));
      setAnswers(current => ({ ...saved, ...current }));
    }).catch(() => { /* Keep the local checkpoint if the server is temporarily offline. */ });
    return () => { cancelled = true; };
  }, [token, submission?.id]);

  useEffect(() => {
    if (!token || submission?.status !== 'WAITING' || user?.role !== 'STUDENT') return;
    let cancelled = false;
    const poll = async () => {
      try {
        const result = await request(`/student/rooms/${submission.id}`);
        if (cancelled) return;
        setSubmission({ ...result.submission, room: result.room }); setSelectedAssignment(result.assignment);
        if (result.submission.status === 'IN_PROGRESS') {
          const restored = Object.fromEntries((result.answers || []).map((answer: any) => [answer.questionId, answer.jsonValue ?? answer.textValue ?? '']));
          setAnswers(restored); lastAutosavedAnswers.current = Object.fromEntries(Object.entries(restored).map(([id, value]) => [id, JSON.stringify(value)]));
          setMessage('');
        } else setMessage(`${t('Ожидаем запуск преподавателя')} · ${result.room.count}/${result.room.target}`);
      } catch { /* Poll again; temporary connection loss does not lose the room. */ }
    };
    void poll();
    const interval = window.setInterval(poll, 5000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [token, submission?.id, submission?.status]);

  useEffect(() => {
    if (!token || !submission?.id || submission.status !== 'IN_PROGRESS' || !selectedAssignment?.questions?.length || user?.role !== 'STUDENT') return;
    const timer = window.setTimeout(async () => {
      const changes: any[] = [];
      const snapshots: Record<string, string> = {};
      for (const question of selectedAssignment.questions) {
        const value = answers[question.id];
        const hasValue = value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0);
        const current = question.type === 'SINGLE_CHOICE'
          ? { jsonValue: value || '' }
          : question.type === 'MULTIPLE_CHOICE'
            ? { jsonValue: Array.isArray(value) ? value : [] }
            : question.type === 'NUMERIC'
              ? { numericValue: value === '' || value == null ? null : Number(value) }
              : { textValue: value || '' };
        const snapshot = JSON.stringify(current);
        if (lastAutosavedAnswers.current[question.id] === snapshot || (!hasValue && !(question.id in lastAutosavedAnswers.current))) continue;
        changes.push({ questionId: question.id, ...current }); snapshots[question.id] = snapshot;
      }
      if (!changes.length) return;
      setDraftStatus('saving');
      try {
        await request(`/student/submissions/${submission.id}/answers`, { method: 'PATCH', body: JSON.stringify({ answers: changes }) });
        lastAutosavedAnswers.current = { ...lastAutosavedAnswers.current, ...snapshots };
        setDraftStatus('saved');
      } catch {
        setDraftStatus('error');
        if (navigator.onLine) window.setTimeout(() => setOnlineRetry(value => value + 1), 4000);
      }
    }, 800);
    return () => window.clearTimeout(timer);
  }, [answers, onlineRetry, token, submission?.id, submission?.status, selectedAssignment?.id, user?.role]);

  useEffect(() => {
    if (!token || !submission?.id || submission.status !== 'IN_PROGRESS' || user?.role !== 'STUDENT') return;
    const sendEvent = (eventType: 'VISIBILITY_HIDDEN' | 'PAGE_HIDDEN' | 'VISIBILITY_RESTORED') => {
      void request(`/student/submissions/${submission.id}/proctor-events`, { method: 'POST', keepalive: eventType === 'PAGE_HIDDEN', body: JSON.stringify({ eventType }) }).then(result => {
        setSubmission((current: any) => current?.id === submission.id ? { ...current, proctorWarnings: result.warnings } : current);
        if (result.expired) {
          setSubmission(null); setSelectedAssignment(null); setAnswers({}); setStudentResult({ submissionId: submission.id, score: null }); writeStorage(window.sessionStorage, ATTEMPT_KEY, null);
          setMessage(t('Попытка завершена: три предупреждения о переключении вкладки. Сохранённые ответы проверены.'));
        } else if (result.warnings > 0 && eventType === 'VISIBILITY_HIDDEN') {
          setMessage(`${t('Предупреждения о переключении вкладки')}: ${result.warnings}/3`);
        }
      }).catch(() => { /* Browser focus events can be lost while offline; never block the student UI. */ });
    };
    const visibility = () => { if (document.visibilityState === 'hidden') sendEvent('VISIBILITY_HIDDEN'); };
    const restored = () => { if (document.visibilityState === 'visible') sendEvent('VISIBILITY_RESTORED'); };
    const pageHide = () => sendEvent('PAGE_HIDDEN');
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('visibilitychange', restored);
    window.addEventListener('pagehide', pageHide);
    if (document.visibilityState === 'visible') restored();
    return () => { document.removeEventListener('visibilitychange', visibility); document.removeEventListener('visibilitychange', restored); window.removeEventListener('pagehide', pageHide); };
  }, [token, submission?.id, submission?.status, user?.role]);

  useEffect(() => {
    if (timeRemaining === 0 && submission?.status === 'IN_PROGRESS' && selectedAssignment?.questions?.length) void submitTest();
  }, [timeRemaining, submission?.id, submission?.status, onlineRetry]);

  useEffect(() => {
    if (!token || user?.role !== 'STUDENT' || !studentResult?.submissionId || studentResult.score !== null || studentResult.status === 'RETURNED') return;
    const poll = async () => {
      try {
        const result = await request(`/student/submissions/${studentResult.submissionId}/result`);
        setStudentResult(result);
        if (result.score !== null) {
          try { setStudentHistory(await request('/student/results')); } catch { /* The visible result remains available. */ }
        }
      } catch { /* Keep the submitted result while the teacher is reviewing. */ }
    };
    const interval = window.setInterval(poll, 5000);
    return () => window.clearInterval(interval);
  }, [token, user?.role, studentResult?.submissionId, studentResult?.status, studentResult?.score]);

  useEffect(() => {
    if (!token || !shouldPollLobby) return;
    const interval = window.setInterval(() => { void refreshRoomSummaries().catch(() => {}); }, 5000);
    return () => window.clearInterval(interval);
  }, [token, shouldPollLobby]);

  if (!user) {
    return (
      <main className="loginShell">
        <section className="loginShowcase" aria-label="Zialy Urpaq мектебі">
          <div className="showcaseBrand"><span className="showcaseMark">ZU</span><span>Zialy Urpaq <small>МЕКТЕБІ</small></span></div>
          <div className="showcaseCopy"><span className="eyebrow">{t('УЧЕБНАЯ ПЛАТФОРМА')}</span><h2>{t('Всё для обучения.')}<br/><em>{t('В одном месте.')}</em></h2><p>{t('Создавайте задания, проверяйте работы и отслеживайте учебный прогресс.')}</p></div>
          <div className="showcaseTiles" aria-hidden="true"><span>01 <b>{t("Задания")}</b></span><span>02 <b>{t("Результаты")}</b></span><span>03 <b>{t("Прогресс")}</b></span></div>
          <div className="showcaseOrb" aria-hidden="true" />
        </section>
        <section className="loginCard">
          {languagePicker}
          <div className="brand loginBrand"><img className="brandLogo" src="/brand/zaily-urpaq-logo.jpg" alt="Zialy Urpaq мектебі" /></div>
          <span className="eyebrow">{t('УЧЕБНАЯ ПЛАТФОРМА')}</span>
          <h1>{t('Войти в систему')}</h1>
          <a className="roomLoginCard" href="/room"><span className="roomLoginIcon" aria-hidden="true">↗</span><span><strong>{t('Ученик? Войти в тест по коду комнаты')}</strong><small>{t('Код комнаты выдаёт преподаватель')}</small></span></a>
          <div className="loginSwitch" role="group" aria-label={t("Тип входа")}>
            <button type="button" className={loginMode === 'staff' ? 'selected' : ''} onClick={() => { setLoginMode('staff'); setMessage(''); }}>{t('Вход сотрудника')}</button>
            <button type="button" className={loginMode === 'student' ? 'selected' : ''} onClick={() => { setLoginMode('student'); setMessage(''); }}>{t('Ученик')} · {t('Общий код школы')}</button>
          </div>
          <p className="loginIntro">{t(loginMode === 'student' ? 'Введите общий код школы, имя и фамилию.' : 'Введите email и пароль, которые выдал администратор.')}</p>
          <form onSubmit={login} className="formStack">
            {loginMode === 'student' ? <>
              <label>{t("Общий код школы")}<input value={studentCode} onChange={e => setStudentCode(e.target.value)} required minLength={6} maxLength={64} autoComplete="one-time-code" /></label>
              <div className="formGrid"><label>{t('Имя')}<input value={studentFirstName} onChange={e => setStudentFirstName(e.target.value)} required maxLength={100} autoComplete="given-name" /></label><label>{t('Фамилия')}<input value={studentLastName} onChange={e => setStudentLastName(e.target.value)} required maxLength={100} autoComplete="family-name" /></label></div>
            </> : <>
              <label>Email<input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="username" /></label>
              <label>{t("Пароль")}<input type="password" value={password} onChange={e => setPassword(e.target.value)} required autoComplete="current-password" /></label>
            </>}
            <button className="primaryButton" disabled={busy || restoringSession}>{restoringSession ? t('Проверяем вход…') : busy ? t('Входим…') : t('Войти')}</button>
          </form>
          {message && <p className="notice" role="status">{t(message)}</p>}
          <p className="loginFoot">{t(loginMode === 'student' ? 'Ученикам нужен общий код школы. Его выдаёт учитель или администратор.' : 'Нет аккаунта сотрудника? Обратитесь к администратору школы.')}</p>
          {loginMode === 'staff' && <button className="schoolPortalLink" type="button" onClick={() => { setLoginMode('student'); setMessage(''); }}>{t('Войти в школьный кабинет по общему коду')}</button>}
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand"><img className="brandLogo" src="/brand/zaily-urpaq-logo.jpg" alt="Zialy Urpaq мектебі" /></div>
        <div className="sideLabel">{t('ПЛАТФОРМА')}</div>
        {isStaff ? <>
          <button className={`navItem ${view === 'overview' ? 'active' : ''}`} onClick={() => setView('overview')}>▦ <span>{t('Обзор')}</span></button>
          <button className={`navItem ${view === 'assignments' || view === 'create' ? 'active' : ''}`} onClick={() => setView('assignments')}>▤ <span>{t('Тесты и задания')}</span></button>
          <button className={`navItem ${view === 'results' ? 'active' : ''}`} onClick={() => setView('results')}>▥ <span>{t('Результаты')}</span></button>
          {user.role === 'ADMIN' && <><button className={`navItem ${view === 'users' ? 'active' : ''}`} onClick={() => setView('users')}>♙ <span>{t("Аккаунты")}</span></button><button className={`navItem ${view === 'school' ? 'active' : ''}`} onClick={() => setView('school')}>⌂ <span>{t('Классы и ученики')}</span></button></>}
        </> : <button className={`navItem active`} onClick={() => { if (submission) exitTest(); else setView('student'); }}>▤ <span>{t('Мои задания')}</span></button>}
        <div className="sidebarBottom"><div className="avatar">ZU</div><div><b>{user.firstName || t(isStaff ? 'Преподаватель' : 'Ученик')}</b><small>{t(isStaff ? 'Управление школой' : 'Личный аккаунт ученика')}</small></div></div>
        <button className="logoutButton" disabled={busy} aria-label={t('Выйти из системы ↗')} onClick={logout}>{t('Выйти из системы ↗')}</button>
      </aside>
      <section className="content" id="overview">
        <header className="topbar">
          <div><span className="eyebrow">{t(isStaff ? 'УЧЕБНАЯ ПЛАТФОРМА' : 'ЛИЧНЫЙ КАБИНЕТ УЧЕНИКА')} </span><h1>{t(view === 'create' ? 'Создать задание' : view === 'assignments' ? 'Тесты и задания' : view === 'results' ? 'Результаты' : view === 'student' ? 'Мои задания' : view === 'users' ? 'Аккаунты' : view === 'school' ? 'Классы и ученики' : 'Обзор')}</h1></div>
          <div className="topbarTools">{languagePicker}<span className="devBadge"><i /> {t(user.role === 'ADMIN' ? 'Администратор' : isStaff ? 'Преподаватель' : 'Ученик')}</span></div>
        </header>
        {message && <div className="notice globalNotice" role="status"><span>{t(message)}</span><button onClick={() => setMessage('')} aria-label={t("Закрыть уведомление")}>×</button></div>}
        {isStaff && view === 'overview' && <>
          <section className="welcome"><div><span className="welcomeTag">{t('Управление школой')}</span><h2>{t('Всё для обучения.')}<br/><em>{t('В одном месте.')}</em></h2><p>{t('Создавайте задания, проверяйте работы и отслеживайте учебный прогресс.')}</p></div><div className="welcomeArt" aria-hidden="true"><div className="artCircle">✳</div><div className="artCard"><span>{t("УЧЕБНЫЙ ПРОЦЕСС")}</span><b>{t("Планируй.")}</b><b>{t("Проверяй.")}</b><b className="artAccent">{t("Развивай.")}</b><div className="artLines"><i/><i/><i/></div></div></div></section>
          <div className="sectionHeading"><div><h3>{t('Рабочее пространство')}</h3><p>{t("Данные из подключённой базы")}</p></div><button className="primaryButton compact" onClick={() => setView('create')}>{t("+ Создать задание")}</button></div>
          <div className="statGrid">
            <article className="statCard"><div className="statIcon violet">▤</div><span>{t('Активные задания')}</span><strong>{dashboard.activeAssignments}</strong><small>{t("Опубликованные тесты")}</small></article>
            <article className="statCard"><div className="statIcon blue">▥</div><span>{t('Всего попыток')}</span><strong>{dashboard.totalSubmissions}</strong><small>{t("Сохранённые работы")}</small></article>
            <article className="statCard"><div className="statIcon orange">◷</div><span>{t('На проверке')}</span><strong>{dashboard.submissionsAwaitingReview}</strong><small>{t("Нужна проверка преподавателя")}</small></article>
            <article className="statCard"><div className="statIcon green">✓</div><span>{t('Проверенные работы')}</span><strong>{dashboard.gradedSubmissions}</strong><small>{t("Оценка выставлена")}</small></article>
          </div>
          {user.role === 'ADMIN' && <section className="panel accountLaunch"><div><span className="eyebrow">{t("АДМИНИСТРИРОВАНИЕ")}</span><h3>{t("Учётные записи сотрудников")}</h3><p>{t("Создавайте личные аккаунты преподавателей и меняйте общий код для учеников.")}</p><small>{accounts.length} {t("аккаунтов в списке")}</small></div><button className="primaryButton" onClick={() => setView('users')}>{t("Управлять доступом →")}</button></section>}
          <div className="lowerGrid">
            <article className="panel"><div className="panelHead"><div><h3>{t('Последние задания')}</h3><p>{t("Управление публикациями")}</p></div><button className="textButton" onClick={() => setView('assignments')}>{t("Все задания →")}</button></div>
              {assignments.slice(0, 4).map(a => <div className="milestone" key={a.id}><span className="milestoneIcon">▤</span><div><b>{a.title}</b><p>{a.subject?.name} · {a._count?.submissions ?? 0} {t("попыток")}</p></div><span className={`status ${a.status !== 'PUBLISHED' ? 'pending' : ''}`}>{t(a.status === 'PUBLISHED' ? 'Опубликовано' : 'Черновик')}</span></div>)}
              {!assignments.length && <p className="emptyState">{t("Пока нет заданий. Создай первое, чтобы ученики могли начать.")}</p>}
            </article>
            <article className="panel apiPanel"><div className="panelHead"><div><h3>{t('Состояние API')}</h3><p>{t("Backend и PostgreSQL")}</p></div><span className="apiGlyph">⌁</span></div><p className="apiHint">{t("Панель использует реальные данные сервера. Если соединение потеряно, появится сообщение об ошибке.")}</p><code>{apiUrl}/health</code><a className="apiLink" href={`${apiUrl}/health`} target="_blank" rel="noreferrer">{t("Открыть проверку API ↗")}</a></article>
          </div>
        </>}
        {isStaff && view === 'assignments' && <section className="panel workPanel">
          <div className="panelHead"><div><h3>{t('Тесты и задания')}</h3><p>{t("Создавай тесты и открывай результаты каждой попытки.")}</p></div><button className="primaryButton compact" onClick={() => setView('create')}>{t("+ Новое задание")}</button></div>
          <div className="roomManagerControls"><b>{t('Настройки новых комнат')}</b><label>{t('Участников в лобби')}<input type="number" min="1" max="40" value={roomTargetDraft} onChange={event => setRoomTargetDraft(event.target.value)} /></label><label>{t('Длительность, минут')}<input type="number" min="1" max="600" value={roomDurationDraft} onChange={event => setRoomDurationDraft(event.target.value)} placeholder={t('Без ограничения времени')} /></label></div>
          {Object.values(roomsByAssignment).flat().reduce((sum, room: any) => sum + (room.flaggedParticipants || 0), 0) > 0 && <p className="proctorNotice" role="status">{t('Предупреждения о списывании в комнатах')}: {Object.values(roomsByAssignment).flat().reduce((sum, room: any) => sum + (room.flaggedParticipants || 0), 0)}</p>}
          <div className="roomManagerControls"><b>{t('Аналитика комнаты')}</b><label>{t('Выберите комнату для аналитики')}<select value={selectedAnalyticsRoom} onChange={event => { setSelectedAnalyticsRoom(event.target.value); setRoomAnalytics(null); }}><option value="">—</option>{Object.values(roomsByAssignment).flat().map((room: any) => <option value={room.id} key={room.id}>{room.assignmentTitle} · {room.joinCode}</option>)}</select></label><button type="button" className="secondaryButton" disabled={!selectedAnalyticsRoom || busy} onClick={() => void loadRoomAnalytics()}>{t('Показать аналитику')}</button></div>
          {roomAnalytics && <section className="analyticsPanel panel"><div className="analyticsHeading"><div><h3>{roomAnalytics.assignmentTitle}</h3><p>{roomAnalytics.attemptCount} {t('завершённых попыток')}</p></div><span>{t('Аналитика комнаты')}</span></div><div className="analyticsKpis"><article><span>{t('Средний результат')}</span><strong>{roomAnalytics.summary.averageScore}/{roomAnalytics.summary.maximumScore}</strong><small>{roomAnalytics.summary.averagePercent}%</small></article><article><span>{t('Медианное время')}</span><strong>{roomAnalytics.summary.medianDurationSeconds === null ? '—' : `${Math.floor(roomAnalytics.summary.medianDurationSeconds / 60)}:${String(roomAnalytics.summary.medianDurationSeconds % 60).padStart(2, '0')}`}</strong><small>{t('мин.')}</small></article></div><div className="analyticsCard"><div className="analyticsCardHead"><h4>{t('Частые ошибки по вопросам')}</h4></div><div className="masteryChart">{roomAnalytics.questions.map((question: any) => <div className="masteryRow" key={question.questionId}><div className="masteryLabel"><b title={question.prompt}>{question.prompt}</b><span>{question.incorrect} / {question.answered} · {t('без ответа')} {question.unanswered}</span></div><div className="masteryTrack"><i className={question.accuracyPercent < 50 ? 'low' : question.accuracyPercent < 75 ? 'mid' : ''} style={{ width: `${question.accuracyPercent}%` }} /></div><strong>{question.accuracyPercent}%</strong></div>)}</div></div></section>}
          {assignments.map(a => <div className="assignmentGroup" key={a.id}><div className="assignmentRow">
            <div className="assignmentIcon">▤</div><div className="assignmentMain"><b>{a.title}</b><p>{a.subject?.name || t('Без предмета')} · {a.questions?.length || 0} {t("вопросов ·")} {a._count?.submissions ?? 0} {t("попыток")} · {a._count?.recipients ? `${t('Выбраны отдельные ученики')}: ${a._count.recipients}` : a.classId ? t('Весь класс') : t('Все ученики')}</p>
              {a.joinCode && <small className="roomCodeDisplay">{t('Код теста')}: <strong>{a.joinCode}</strong>{a.lobbyTarget ? ` · ${t('Лобби')} ${a.waitingCount ?? 0}/${a.lobbyTarget}` : ''}</small>}
            </div><span className={`status ${a.status !== 'PUBLISHED' ? 'pending' : ''}`}>{t(a.status === 'PUBLISHED' ? 'Опубликовано' : a.status === 'DRAFT' ? 'Черновик' : a.status)}</span>
            {a.lobbyTarget && a.status === 'PUBLISHED' && !a.roomStartedAt && <button type="button" className="primaryButton compact" disabled={busy || (a.waitingCount ?? 0) < a.lobbyTarget} onClick={() => launchRoom(a)}>{t('Запустить комнату')}</button>}
            {a.status === 'PUBLISHED' && <button type="button" className="secondaryButton" disabled={busy} onClick={() => createTestRoom(a)}>{t('Новая комната')}</button>}
            <button className="secondaryButton" disabled={busy} onClick={() => openResults(a)}>{t('Результаты')}</button>{a.status === 'DRAFT' && <button type="button" className="secondaryButton" disabled={busy} onClick={() => publishAssignment(a)}>{t('Опубликовать')}</button>}{user.role === 'ADMIN' && <button type="button" className="textButton dangerText" disabled={busy} onClick={() => deleteAssignment(a)}>{t("Удалить")}</button>}
          </div>{roomsByAssignment[a.id]?.map(room => <div className="testRoomCard" key={room.id}><div><span className="eyebrow">{t('Код комнаты')}</span><strong>{room.joinCode}</strong></div><span>{t(room.status === 'RUNNING' ? 'Идёт тест' : room.status === 'LOBBY' ? 'Ожидание' : room.status)}</span><span>{t('Участники')}: {room.count}/{room.lobbyTarget}</span>{room.status === 'LOBBY' && <button type="button" className="primaryButton compact" disabled={busy || room.count < 1} onClick={() => startTestRoom(room)}>{t('Запустить сейчас')}</button>}{room.status === 'RUNNING' && <button type="button" className="secondaryButton compact" onClick={() => setWatchingLiveRoom(current => current === room.id ? '' : room.id)}>{t(watchingLiveRoom === room.id ? 'Скрыть трансляцию' : 'Смотреть трансляцию')}</button>}{watchingLiveRoom === room.id && <div className="roomMonitorWrap"><TeacherScreenMonitor roomId={room.id} language={language} /></div>}</div>)}</div>)}
          {!assignments.length && <p className="emptyState">{t("Заданий пока нет.")}</p>}
        </section>}
        {user.role === 'ADMIN' && view === 'users' && <div className="accountWorkspace">
          <section className="panel accountFormPanel">
            <div className="panelHead"><div><h3>{t("Создать аккаунт преподавателя")}</h3><p>{t("Ученикам аккаунт не нужен: они входят по общему коду и ФИО.")}</p></div></div>
            <form className="formStack" onSubmit={createAccount}>
              <div className="formGrid"><label>{t('Имя')}<input value={accountFirstName} onChange={e => setAccountFirstName(e.target.value)} required maxLength={100} autoComplete="given-name" /></label><label>{t('Фамилия')}<input value={accountLastName} onChange={e => setAccountLastName(e.target.value)} required maxLength={100} autoComplete="family-name" /></label></div>
              <label>Email<input type="email" value={accountEmail} onChange={e => setAccountEmail(e.target.value)} required maxLength={254} autoComplete="off" /></label>
              <label>{t("Пароль")} <small>{t("Не менее 12 символов. Сообщите пароль пользователю безопасным способом.")}</small><input type="password" value={accountPassword} onChange={e => setAccountPassword(e.target.value)} required minLength={12} maxLength={128} autoComplete="new-password" /></label>
              <button className="primaryButton" disabled={busy}>{busy ? t('Создаём…') : t('Создать аккаунт преподавателя')}</button>
            </form>
          </section>
          <section className="panel accessCodePanel">
            <div className="panelHead"><div><h3>{t("Общий код входа учеников")}</h3><p>{t(studentAccessCodeConfigured ? 'Код настроен. Введите новый, чтобы заменить текущий.' : 'Код ещё не настроен. Задайте его, чтобы ученики могли войти.')}</p></div><span className={`accountState ${studentAccessCodeConfigured ? 'active' : 'inactive'}`}>{t(studentAccessCodeConfigured ? 'Настроен' : 'Не задан')}</span></div>
            <form className="formStack" onSubmit={saveStudentAccessCode}>
              <label>{t("Новый код")}<input type="text" value={studentAccessCodeInput} onChange={e => setStudentAccessCodeInput(e.target.value)} required minLength={6} maxLength={64} autoComplete="new-password" placeholder={t("Не менее 6 символов")} /></label>
              <small className="helperText">{t("После смены новый код понадобится для следующих входов. Ученики указывают имя и фамилию при каждом входе.")}</small>
              <button className="primaryButton" disabled={busy}>{busy ? t('Сохраняем…') : studentAccessCodeConfigured ? t('Сменить код') : t('Сохранить код')}</button>
            </form>
          </section>
          <section className="panel accountListPanel">
            <div className="panelHead"><div><h3>{t("Преподаватели")}</h3><p>{t("Личные аккаунты сотрудников школы")}</p></div><span className="builderCount">{accounts.length}</span></div>
            {accounts.length ? <div className="accountList">{accounts.map(account => <article className="accountRow" key={account.id}><div className="accountAvatar teacher">{account.firstName?.[0]}{account.lastName?.[0]}</div><div className="accountIdentity"><b>{account.lastName} {account.firstName}</b><span>{account.email}</span></div><span className="accountRole teacher">{t("Преподаватель")}</span><span className={`accountState ${account.isActive ? 'active' : 'inactive'}`}>{t(account.isActive ? 'Активен' : 'Отключён')}</span></article>)}</div> : <p className="emptyState">{t("Преподавателей пока нет. Создайте первую учётную запись.")}</p>}
            {accounts.length >= 200 && <p className="helperText">{t("Здесь показаны последние 200 аккаунтов.")}</p>}
          </section>
        </div>}
        {user.role === 'ADMIN' && view === 'school' && <div className="accountWorkspace">
          <section className="panel accountFormPanel">
            <div className="panelHead"><div><h3>Создать класс</h3><p>Добавьте класс, чтобы назначать задания группам учеников.</p></div></div>
            <form className="formStack" onSubmit={createSchoolClass}>
              <label>Название класса<input value={classNameDraft} onChange={e => setClassNameDraft(e.target.value)} required maxLength={80} placeholder="Например, 7А" /></label>
              <label>Учебный год<input value={academicYearDraft} onChange={e => setAcademicYearDraft(e.target.value)} required maxLength={20} placeholder="2026-2027" /></label>
              <button className="primaryButton" disabled={busy}>Создать класс</button>
            </form>
          </section>
          <section className="panel accessCodePanel">
            <div className="panelHead"><div><h3>Добавить ученика</h3><p>Ученик будет связан с выбранным классом и сможет войти по общему коду школы.</p></div></div>
            <form className="formStack" onSubmit={createSchoolStudent}>
              <div className="formGrid"><label>Имя<input value={newStudentFirstName} onChange={e => setNewStudentFirstName(e.target.value)} required maxLength={100} /></label><label>Фамилия<input value={newStudentLastName} onChange={e => setNewStudentLastName(e.target.value)} required maxLength={100} /></label></div>
              <label>Класс<select value={newStudentClassId} onChange={e => setNewStudentClassId(e.target.value)} required><option value="">Выберите класс</option>{schoolClasses.map((item: any) => <option value={item.id} key={item.id}>{item.name} · {item.academicYear}</option>)}</select></label>
              <label>Табельный номер <small>Необязательно</small><input value={newStudentNo} onChange={e => setNewStudentNo(e.target.value)} maxLength={40} /></label>
              <button className="primaryButton" disabled={busy || !schoolClasses.length}>Добавить ученика</button>
            </form>
          </section>
          <section className="panel accountListPanel">
            <div className="panelHead"><div><h3>Классы</h3><p>Классы и количество учеников</p></div><span className="builderCount">{schoolClasses.length}</span></div>
            {schoolClasses.length ? <div className="accountList">{schoolClasses.map((item: any) => <article className="accountRow" key={item.id}><div className="accountAvatar teacher">К</div><div className="accountIdentity"><b>{item.name}</b><span>{item.academicYear}</span></div><span className="accountState active">{item._count?.students ?? 0} учеников</span></article>)}</div> : <p className="emptyState">Классов пока нет. Создайте первый класс.</p>}
          </section>
          <section className="panel accountListPanel">
            <div className="panelHead"><div><h3>Ученики</h3><p>Список учеников, связанных с классами</p></div><span className="builderCount">{schoolStudents.length}</span></div>
            {schoolStudents.length ? <div className="accountList">{schoolStudents.map((item: any) => <article className="accountRow" key={item.id}><div className="accountAvatar">{item.user.firstName?.[0]}{item.user.lastName?.[0]}</div><div className="accountIdentity"><b>{item.user.lastName} {item.user.firstName}</b><span>{item.studentNo || 'Без табельного номера'}</span></div><span className="accountRole teacher">{item.schoolClass?.name || 'Без класса'}</span><span className="accountState active">{item.user.isActive ? 'Активен' : 'Отключён'}</span></article>)}</div> : <p className="emptyState">Учеников пока нет. Добавьте ученика в список.</p>}
          </section>
        </div>}
        {isStaff && view === 'create' && <section className="panel workPanel">
          <div className="panelHead"><div><h3>{t('Конструктор задания')}</h3><p>{t("Сначала предмет и название, затем вопросы и настройки прохождения.")}</p></div><span className="builderCount">{questions.length} {questionCountLabel}</span></div>
          <form className="formStack" onSubmit={createAssignment}>
            <div className="wordImportPanel">
              <div><b>{t('Импорт из Word')}</b><p>{t('Загрузите заполненный шаблон DOCX — вопросы появятся в конструкторе для проверки.')}</p></div>
              <a className="secondaryButton" href="/templates/zaily-urpaq-test-template.docx" download>{t('Скачать шаблон')}</a>
              <label className="primaryButton wordImportButton">{importingWord ? t('Загружаем…') : t('Загрузить .docx')}<input type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={importWordTemplate} disabled={importingWord} /></label>
            </div>
            <div className="builderBasics">
              <label className="builderSubject">{t('Предмет')}<input value={subjectName} onChange={e => setSubjectName(e.target.value)} required maxLength={120} placeholder={t("Например, Математика")} /></label>
              <label>{t('Класс')}<select value={assignmentClassId} onChange={async e => {
                const classId = e.target.value;
                setAssignmentClassId(classId);
                setAssignmentRoster([]);
                setAssignmentStudentIds([]);
                if (!classId) return;
                try {
                  const roster = await request(`/school/assignment-roster?classId=${encodeURIComponent(classId)}`);
                  setAssignmentRoster(roster);
                } catch (error) {
                  setMessage(error instanceof Error ? error.message : 'Не удалось загрузить учеников класса');
                }
              }}><option value="">{t('Все классы')}</option>{schoolClasses.map((item: any) => <option value={item.id} key={item.id}>{item.name} · {item.academicYear}</option>)}</select><small>Выбранный класс увидит это задание. Если не выбирать класс, задание будет доступно всем ученикам без привязки к классу.</small></label>
              {assignmentClassId && <div className="assignmentStudentPicker">
                <div className="assignmentStudentPickerHead"><b>{t('Кому назначить')}</b><small>{assignmentStudentIds.length ? <>{t('Выбрано учеников')}: {assignmentStudentIds.length}</> : t('Если не выбирать учеников, задание получит весь класс.')}</small></div>
                {assignmentRoster.length ? <div className="assignmentStudentRoster">{assignmentRoster.map((student: any) => <label className="assignmentStudentOption" key={student.id}>
                  <input type="checkbox" checked={assignmentStudentIds.includes(student.id)} onChange={event => setAssignmentStudentIds(current => event.target.checked ? [...current, student.id] : current.filter(id => id !== student.id))} />
                  <span>{student.user.lastName} {student.user.firstName}</span>
                  {student.studentNo && <small>{student.studentNo}</small>}
                </label>)}</div> : <small>{t('В выбранном классе нет активных учеников.')}</small>}
              </div>}
              <label className="builderTitle">{t('Название задания')}<input value={title} onChange={e => setTitle(e.target.value)} required maxLength={200} placeholder={t("Например, Дроби: контрольная работа")} /></label>
            </div>
            <div className="builderSectionHeading"><span>{t("Вопросы")}</span><small>{t("Сформулируйте вопрос, выберите тип ответа и укажите баллы.")}</small></div>
            {questions.map((q, qi) => <div className="questionEditor" key={qi}>
              <div className="questionEditorHead"><b><span className="builderQuestionNumber">{String(qi + 1).padStart(2, '0')}</span>{t("Вопрос")} {qi + 1}</b>{questions.length > 1 && <button type="button" className="textButton dangerText" onClick={() => setQuestions(old => old.filter((_, i) => i !== qi))}>{t("Удалить вопрос")}</button>}</div>
              <label>{t("Текст вопроса")}<textarea value={q.prompt} onChange={e => updateQuestion(qi, { prompt: e.target.value })} required maxLength={5000} rows={2} placeholder={t("Сформулируйте вопрос для ученика")} /></label>
              <div className="formGrid"><label>{t("Тип ответа")}<select value={q.type} onChange={e => {
                const type = e.target.value as QuestionDraft['type'];
                updateQuestion(qi, {
                  type,
                  ...(type === 'SINGLE_CHOICE' ? { options: q.options.map((o, i) => ({ ...o, isCorrect: i === Math.max(0, q.options.findIndex(x => x.isCorrect)) })) } : {}),
                });
              }}>
                <option value="SINGLE_CHOICE">{t("Один правильный вариант")}</option><option value="MULTIPLE_CHOICE">{t("Несколько правильных вариантов")}</option><option value="NUMERIC">{t("Числовой ответ с автопроверкой")}</option><option value="SHORT_TEXT">{t("Короткий текст — проверяет преподаватель")}</option><option value="LONG_TEXT">{t("Развёрнутый ответ — проверяет преподаватель")}</option>
              </select></label>{!['SHORT_TEXT', 'LONG_TEXT'].includes(q.type) && <label>{t("Максимум баллов")}<input type="number" min="0.01" max="10000" step="0.01" value={q.points} onChange={e => updateQuestion(qi, { points: Number(e.target.value) })} required /></label>}</div>
              {q.type === 'NUMERIC' && <div className="formGrid"><label>{t('Правильный числовой ответ')}<input type="number" step="any" value={q.correctValue} onChange={e => updateQuestion(qi, { correctValue: Number(e.target.value) })} required /></label><label>{t('Допустимая погрешность')}<input type="number" min="0" step="any" value={q.tolerance} onChange={e => updateQuestion(qi, { tolerance: Number(e.target.value) })} required /></label></div>}
              {(q.type === 'SINGLE_CHOICE' || q.type === 'MULTIPLE_CHOICE') && <div className="optionsEditor"><div className="optionsTitle">{t("Варианты ответов")} <small>{t("Отметьте правильный вариант")}</small></div>
                {q.options.map((o, oi) => <div className="optionDraft" key={oi}><input type={q.type === 'SINGLE_CHOICE' ? 'radio' : 'checkbox'} name={`correct-${qi}`} checked={o.isCorrect} onChange={e => updateOption(qi, oi, { isCorrect: e.target.checked })} aria-label={language === 'kk' ? `${oi + 1}-нұсқа — дұрыс жауап` : language === 'en' ? `Option ${oi + 1} — correct answer` : `Вариант ${oi + 1} — правильный ответ`} /><input maxLength={500} value={o.text} onChange={e => updateOption(qi, oi, { text: e.target.value })} placeholder={language === 'kk' ? `${oi + 1}-нұсқа` : language === 'en' ? `Option ${oi + 1}` : `Вариант ${oi + 1}`} required /><button type="button" className="removeOptionButton" onClick={() => removeOption(qi, oi)} disabled={q.options.length <= 2} title={q.options.length <= 2 ? t('Нужно оставить минимум два варианта') : t('Удалить вариант')} aria-label={language === 'kk' ? `${oi + 1}-нұсқаны жою` : language === 'en' ? `Remove option ${oi + 1}` : `Удалить вариант ${oi + 1}`}>×</button></div>)}
                <button type="button" className="textButton" disabled={q.options.length >= 100} onClick={() => updateQuestion(qi, { options: [...q.options, { text: '', isCorrect: false }] })}>{t("+ Добавить вариант")}</button>
              </div>}
              {['SHORT_TEXT', 'LONG_TEXT'].includes(q.type) && <p className="helperText">{t('Баллы за текстовый ответ преподаватель выставляет при проверке.')}</p>}
            </div>)}
            <button type="button" className="secondaryButton addQuestion" disabled={questions.length >= 200} onClick={() => setQuestions(old => [...old, newQuestion()])}>{t("+ Добавить вопрос")}</button>
            <div className="builderSectionHeading"><span>{t("Дополнительные настройки")}</span><small>{t("Ограничения применяются ко всему тесту.")}</small></div>
              <label>{t('Описание')}<textarea maxLength={5000} value={description} onChange={e => setDescription(e.target.value)} rows={2} placeholder={t('Необязательное описание для учеников')} /></label>
            <div className="formGrid builderSettings"><label>{t("Открыть задание с") }<input type="datetime-local" value={availableFrom} onChange={e => setAvailableFrom(e.target.value)} /></label><label>{t("Срок сдачи") }<input type="datetime-local" value={dueAt} min={availableFrom || undefined} onChange={e => setDueAt(e.target.value)} /></label><label>{t("Лимит времени, минут")}<input type="number" min="1" max="600" value={timeLimit} onChange={e => setTimeLimit(e.target.value)} placeholder={t("Без лимита")} /></label><label>{t("Попытки на весь тест для одного ФИО")}<input type="number" min="1" max="100" value={maxAttempts} onChange={e => setMaxAttempts(e.target.value)} required /><small>{t("Считается каждое запущенное прохождение теста целиком.")}</small></label><label>{t('Размер лобби, учеников')}<input type="number" min="1" max="2000" value={lobbyTarget} onChange={e => setLobbyTarget(e.target.value)} placeholder={t('Без лобби')} /><small>{t('Пусто — тест запускается сразу после входа ученика.')}</small></label></div>
            <div className="builderToggles"><label><input type="checkbox" checked={shuffleQuestions} onChange={e => setShuffleQuestions(e.target.checked)} />{t('Перемешивать вопросы для каждого ученика')}</label><label><input type="checkbox" checked={shuffleOptions} onChange={e => setShuffleOptions(e.target.checked)} />{t('Перемешивать варианты ответов')}</label></div>
            <div className="formActions"><button type="button" className="secondaryButton" onClick={() => setView('assignments')}>{t('Отмена')}</button><button className="primaryButton" disabled={busy}>{busy ? t('Сохраняем…') : t('Сохранить и опубликовать')}</button></div>
          </form>
        </section>}
        {isStaff && view === 'results' && <section className="panel workPanel">
          {!selectedResults ? <><div className="panelHead"><div><h3>{t("Результаты попыток")}</h3><p>{t("Выбери задание, чтобы открыть ответы учеников.")}</p></div></div>{assignments.map(a => <div className="assignmentRow" key={a.id}><div className="assignmentMain"><b>{a.title}</b><p>{a.subject?.name}</p></div><button className="secondaryButton" disabled={busy} onClick={() => openResults(a)}>{t("Открыть результаты")}</button></div>)}</> : <>
            <div className="panelHead"><div><h3>{selectedResults.assignment.title}</h3><p>{selectedResults.submissions.length} {t("сохранённых попыток")}</p></div><div className="formActions"><button className="secondaryButton" disabled={busy} onClick={exportResultsDatabase}>{language === 'kk' ? 'SQLite дерекқорын жүктеу' : language === 'en' ? 'Download SQLite database' : 'Скачать базу SQLite'}</button><button className="secondaryButton" disabled={busy} onClick={exportResultsCsv}>{t('Экспорт результатов CSV')}</button><button className="secondaryButton" disabled={busy} onClick={() => setSelectedResults(null)}>{t("← Все задания")}</button></div></div>
            <button className="secondaryButton" type="button" onClick={() => setMonitorOpen(value => !value)}>{language === 'kk' ? 'Тестті бақылау' : language === 'en' ? 'Live test monitor' : 'Наблюдение за тестом'} {monitorOpen ? '−' : '+'}</button>
            {monitorOpen && <TeacherMonitor key={selectedResults.assignment.id} token={token} assignmentId={selectedResults.assignment.id} language={language} />}
            {resultsAnalytics && <section className="analyticsPanel" aria-label={t("Аналитика результатов")}>
              <div className="analyticsHeading"><div><span className="eyebrow">{t('ОТЧЁТ ПО КЛАССУ')}</span><h3>{t('Аналитика результатов')}</h3><p>{t('Сводка помогает увидеть общий прогресс и вопросы, требующие повторения.')}</p></div><span className="analyticsIcon" aria-hidden="true">↗</span></div>
              <div className="analyticsKpis"><article><span>{t('Отправлено работ')}</span><strong>{resultsAnalytics.finished}</strong><small>{t('из')} {selectedResults.submissions.length} {t('попыток')}</small></article><article><span>{t('Средний результат автопроверки')}</span><strong>{resultsAnalytics.average === null ? '—' : `${resultsAnalytics.average}%`}</strong><small>{t('среди оценённых работ ·')} {resultsAnalytics.graded}</small></article><article><span>{t('Автоматических ответов оценено')}</span><strong>{resultsAnalytics.questions.reduce((sum, item) => sum + item.responses, 0)}</strong><small>{t('по всем вопросам')}</small></article></div>
              <div className="analyticsCharts">
                <article className="analyticsCard"><div className="analyticsCardHead"><div><h4>{t('Успеваемость по вопросам')}</h4><p>{t('Доля набранных баллов среди оценённых ответов')}</p></div><span>0–100%</span></div>
                  {resultsAnalytics.questions.length ? <div className="masteryChart">{resultsAnalytics.questions.map((item, index) => <div className="masteryRow" key={`${item.position}-${index}`}><div className="masteryLabel"><b>{t('Вопрос')} {item.position}</b><span title={item.prompt}>{item.prompt}</span></div><div className="masteryTrack" role="img" aria-label={`${t('Вопрос')} ${item.position}: ${item.rate}% ${t('баллов')}`}><i className={item.rate < 50 ? 'low' : item.rate < 75 ? 'mid' : ''} style={{ width: `${item.rate}%` }} /></div><strong>{item.rate}%</strong></div>)}</div> : <p className="analyticsEmpty">{t('Процентные диаграммы доступны для оценённых вопросов с автоматической проверкой.')}</p>}
                </article>
                <article className="analyticsCard"><div className="analyticsCardHead"><div><h4>{t('Распределение результатов')}</h4><p>{t('Доля от максимального балла по попытке')}</p></div></div>
                  {resultsAnalytics.graded ? <div className="distributionChart">{resultsAnalytics.buckets.map((count, index) => { const labels = ['0–24%', '25–49%', '50–74%', '75–100%']; const percent = Math.round(count / resultsAnalytics.graded * 100); return <div className="distributionColumn" key={labels[index]}><span>{count}</span><div className="distributionTrack"><i style={{ height: `${Math.max(percent, count ? 6 : 0)}%` }} /></div><b>{labels[index]}</b></div>; })}</div> : <p className="analyticsEmpty">{t('Процентные диаграммы доступны для оценённых вопросов с автоматической проверкой.')}</p>}
                </article>
              </div>
              {<p className="analyticsNote">{t('Проценты рассчитаны по вопросам с автоматической проверкой. Баллы за текстовые ответы входят в итоговую оценку.')}</p>}
            </section>}
            {selectedResults.submissions.map((s: any) => <article className="resultCard" key={s.id}>
              <div className="resultHead"><div><b>{s.studentFirstName} {s.studentLastName}</b><p>{t('Попытка №')}{s.attemptNo} {t("· Начало:")} {new Date(s.startedAt).toLocaleString(dateLocale)} {t("· Отправлено:")} {s.submittedAt ? new Date(s.submittedAt).toLocaleString(dateLocale) : t('не отправлено')}</p></div><div className="resultScore"><strong>{s.totalScore === null ? t(s.submittedAt ? 'На проверке' : 'В процессе') : Number(s.totalScore)}</strong><small>{t('баллов')}</small></div></div>
              {s.proctorWarnings > 0 && <div className="proctorLog"><b>{t('Предупреждения о переключении вкладки')}: {s.proctorWarnings}/3</b>{s.proctorEvents?.map((event: any) => <span key={event.id}>{event.eventType === 'VISIBILITY_HIDDEN' ? t('Вкладка была скрыта') : t('Страница была закрыта')} · {new Date(event.createdAt).toLocaleTimeString(dateLocale)}</span>)}</div>}
              <div className="answerList">{s.answers.map((a: any) => <div className="answerItem" key={a.id}>
                <b>{a.question.position}. {a.question.prompt}</b>
                <p>{answerText(a, t('Ответ не дан'))}</p>
                {a.question.options.length > 0 && <small>{t("Правильные варианты:")} {a.question.options.filter((o: any) => o.isCorrect).map((o: any) => o.text).join(', ') || t('не заданы')}</small>}
                <span className="answerPoints">{t("Баллы:")} {a.awardedPoints === null ? t('не выставлены') : Number(a.awardedPoints)}{!isManualQuestion(a.question.type) && <> / {Number(a.question.points)}</>}</span>
                {['SHORT_TEXT', 'LONG_TEXT', 'MATCHING', 'FILL_BLANKS', 'FILE_UPLOAD'].includes(a.question.type) && <div className="manualGradeEditor">
                  <div className="manualGradeInfo"><b>{t("Оценка преподавателя")}</b><small>{t('Можно выставить от 0 до 10000 баллов.')} {t('Балл будет начислен после проверки.')}</small></div>
                  <div className="manualGradeControls">
                    <label>{t('Баллы')}<input type="number" min="0" max={10000} step="0.01" disabled={busy} value={manualGrades[a.id] ?? (a.awardedPoints === null ? '' : String(a.awardedPoints))} onChange={e => setManualGrades(old => ({ ...old, [a.id]: e.target.value }))} aria-label={`${t('Баллы')} ${t('Вопрос')} ${a.question.position}, ${t('максимум')} 10000`} placeholder={t('Введите баллы')} /></label>
                    <button type="button" className="secondaryButton gradeFullButton" disabled={busy} onClick={() => setManualGrades(old => ({ ...old, [a.id]: '1' }))}>{t('Засчитать · 1 балл')}</button>
                    <button type="button" className="secondaryButton gradeZeroButton" disabled={busy} onClick={() => setManualGrades(old => ({ ...old, [a.id]: '0' }))}>{t("Не засчитывать · 0")}</button>
                    <label className="teacherCommentField">Комментарий к ответу<textarea maxLength={5000} disabled={busy} value={manualComments[a.id] ?? a.teacherComment ?? ''} onChange={e => setManualComments(old => ({ ...old, [a.id]: e.target.value }))} placeholder="Комментарий для ученика" /></label>
                  </div>
                </div>}
              </div>)}</div>
              {(s.status === 'EXPIRED' || s.answers.some((a: any) => isManualQuestion(a.question.type))) && <div className="manualReviewFooter"><div><b>{t("Проверка работы")}</b><p>{t(s.answers.some((a: any) => isManualQuestion(a.question.type)) ? 'Введите баллы за каждый текстовый ответ, затем сохраните оценку.' : 'Работа отправлена после окончания времени. Проверьте ответы и подтвердите оценку.')}</p><label className="teacherCommentField">Общий комментарий к работе<textarea maxLength={10000} disabled={busy} value={submissionFeedback[s.id] ?? s.feedback ?? ''} onChange={e => setSubmissionFeedback(old => ({ ...old, [s.id]: e.target.value }))} placeholder="Обратная связь для ученика" /></label></div><button className="primaryButton" disabled={busy} onClick={() => gradeSubmission(s)}>{busy ? t('Сохраняем…') : s.status === 'GRADED' ? t('Сохранить изменения') : t('Сохранить оценку')}</button></div>}
              <div className="resultFoot"><span className={`status ${s.status === 'GRADED' ? '' : 'pending'}`}>{t(({ IN_PROGRESS: 'В процессе', SUBMITTED: 'Отправлено', UNDER_REVIEW: 'На проверке', GRADED: 'Проверено', EXPIRED: 'Время истекло', RETURNED: 'Возвращено' } as Record<string, string>)[s.status] || s.status)}</span>{s.feedback && <span className="muted">{s.feedback}</span>}{['UNDER_REVIEW', 'GRADED', 'EXPIRED'].includes(s.status) && <button type="button" className="secondaryButton" disabled={busy} onClick={() => returnSubmission(s)}>{t('Вернуть на исправление')}</button>}</div>
            </article>)}
            {!selectedResults.submissions.length && <p className="emptyState">{t("Попыток пока нет.")}</p>}
          </>}
        </section>}
        {!isStaff && view === 'student' && !selectedAssignment && !submission && !studentResult && <StudentRoomV2 language={language} firstName={user.firstName || ''} lastName={user.lastName || ''} />}
        {!isStaff && view === 'student' && !selectedAssignment && !submission && !studentResult && <section className="panel workPanel">
          <div className="panelHead"><div><h3>{t('Доступные задания')}</h3><p>{user.firstName} {user.lastName}{t(', введите код теста, который сообщил преподаватель.')}</p></div></div>
          <form className="roomJoinForm" onSubmit={startTest}><label>{t('Код теста')}<input autoComplete="one-time-code" value={roomCode} onChange={event => setRoomCode(event.target.value.toUpperCase())} required minLength={6} maxLength={16} /></label><button className="primaryButton" disabled={busy}>{busy ? t('Подключаемся…') : t('Подключиться к тесту')}</button></form>
          {available.map(a => <div className="studentAssignment" key={a.id}><div className="assignmentIcon">▤</div><div className="assignmentMain"><b>{a.title}</b><p>{a.subject.name} · {a._count.questions} {t("вопросов ·")} {a.timeLimitMinutes ? `${a.timeLimitMinutes} ${t('мин.')}` : t('Без лимита времени')} {t("· До")} {a.dueAt ? new Date(a.dueAt).toLocaleString(dateLocale) : t('без срока')}</p>{a.description && <small>{a.description}</small>}</div></div>)}
          {!available.length && <p className="emptyState">{t("Сейчас нет опубликованных доступных заданий.")}</p>}
          <div className="panelHead studentHistoryHead"><div><h3>{t('История результатов')}</h3><p>{t('Ранее отправленные работы и оценки')}</p></div></div>
          {studentHistory.map((item: any) => <article className="studentAssignment" key={item.submissionId}>
            <div className="assignmentIcon">✓</div>
            <div className="assignmentMain"><b>{item.assignmentTitle}</b><p>{item.subjectName} · {t('Попытка №')}{item.attemptNo} · {item.submittedAt ? new Date(item.submittedAt).toLocaleString(dateLocale) : t('Отправлено')}</p>
              <small>{item.score === null ? t('Ожидает проверки') : `${item.score} ${t('баллов')}`}{item.feedback ? ` · ${item.feedback}` : ''}</small>
            </div>
            <button className="secondaryButton" disabled={busy} onClick={() => openStudentResult(item.submissionId)}>{t('Посмотреть')}</button>
          </article>)}
          {!studentHistory.length && <p className="emptyState">{t('Здесь появятся отправленные работы и отзывы преподавателя.')}</p>}
        </section>}
        {!isStaff && studentResult && <section className="panel workPanel studentResultPanel">
          <div className="panelHead"><div><h3>{t('Результат теста')}</h3><p>{studentResult.assignmentTitle}</p></div><button className="secondaryButton" onClick={() => setStudentResult(null)}>{t('К заданиям')}</button></div>
          {studentResult.finishReason === 'PROCTORING_VIOLATION_LIMIT' && <p className="proctorNotice" role="status">{t('Попытка завершена: три предупреждения о переключении вкладки. Сохранённые ответы проверены.')}</p>}
          {studentResult.score === null && <p className="helperText">{t('Текстовые ответы проверяет преподаватель. Результат обновится автоматически после проверки.')}</p>}
          <div className="studentResultKpis"><article><span>{t('Баллы')}</span><strong>{studentResult.score ?? '—'}</strong></article><article><span>{t('Место в рейтинге')}</span><strong>{studentResult.rank ? `#${studentResult.rank}` : '—'}</strong></article><article><span>{t('Правильных ответов')}</span><strong>{studentResult.correctCount ?? '—'}</strong></article><article><span>{t('Время прохождения')}</span><strong>{Math.floor((studentResult.durationMs || 0) / 60000)}:{String(Math.floor(((studentResult.durationMs || 0) % 60000) / 1000)).padStart(2, '0')}</strong></article></div>
          {studentResult.status === 'RETURNED' && <div className="manualReviewFooter"><div><b>{t('Работа возвращена на исправление')}</b><p>{t('Исправьте ответы и отправьте работу повторно.')}</p></div><button className="primaryButton" disabled={busy} onClick={() => reviseReturned(studentResult.submissionId)}>{t('Исправить работу')}</button></div>}
          {studentResult.feedback && <div className="manualReviewFooter"><div><b>{t('Комментарий преподавателя')}</b><p>{studentResult.feedback}</p></div></div>}
          {studentResult.answers?.length > 0 && <section className="studentAnswerReview" aria-label={t('Проверка ответов')}>
            <h4>{t('Ответы и комментарии')}</h4>
            {studentResult.answers.map((answer: any, index: number) => {
              const value = answer.numericValue !== null && answer.numericValue !== undefined
                ? String(answer.numericValue)
                : Array.isArray(answer.jsonValue)
                  ? answer.jsonValue.map((id: string) => answer.question.options.find((option: any) => option.id === id)?.text ?? id).join(', ')
                  : typeof answer.jsonValue === 'string'
                    ? answer.question.options.find((option: any) => option.id === answer.jsonValue)?.text ?? answer.jsonValue
                    : answer.textValue || '—';
              return <article className="studentAnswerReviewRow" key={answer.question.id}>
                <b>{index + 1}. {answer.question.prompt}</b>
                <p>{t('Ваш ответ')}: {value}</p>
                <p>{t('Баллы')}: {answer.awardedPoints ?? '—'}{answer.question.points > 0 ? ` / ${answer.question.points}` : ''}</p>
                {!['SHORT_TEXT', 'LONG_TEXT'].includes(answer.question.type) && answer.isCorrect !== null && <span className={`status ${answer.isCorrect ? '' : 'pending'}`}>{answer.isCorrect ? t('Зачтено') : t('Не зачтено')}</span>}
                {answer.teacherComment && <p className="muted">{t('Комментарий к ответу')}: {answer.teacherComment}</p>}
              </article>;
            })}
          </section>}
          <h4>{t('Топ учеников')}</h4>{studentResult.top?.length ? studentResult.top.map((item: any) => <div className="leaderboardRow" key={item.rank}><b>#{item.rank}</b><span>{item.lastName} {item.firstName}</span><span>{item.score} {t('баллов')}</span><span>{item.correctCount} {t('правильных')}</span></div>) : <p className="emptyState">{t('Таблица лидеров появится после оценивания результатов.')}</p>}
        </section>}
        {!isStaff && submission?.status === 'IN_PROGRESS' && <StudentMonitor key={submission.id} token={token} submissionId={submission.id} language={language} />}
        {!isStaff && selectedAssignment && submission?.status === 'WAITING' && <section className="panel workPanel waitingRoomPanel">
          <div className="waitingRoomIcon">◷</div><span className="eyebrow">{t('Лобби')}</span><h3>{t('Ожидание запуска теста')}</h3><p>{selectedAssignment.title}</p><strong>{submission.room?.count || 1} / {submission.room?.target || '—'}</strong><small>{t('Преподаватель запустит тест, когда соберётся нужное количество учеников.')}</small><button className="secondaryButton" onClick={exitTest}>{t('Выйти из теста')}</button>
        </section>}
        {!isStaff && selectedAssignment && submission && submission.status === 'IN_PROGRESS' && <section className="panel workPanel">
          <div className="panelHead"><div><h3>{selectedAssignment.title}</h3><p>{t('Попытка №')}{submission.attemptNo} {t("· Ученик:")} {user.firstName} {user.lastName}</p></div><span className="status">{timeRemaining !== null ? timeRemaining === 0 ? t('Время истекло') : `${t('Осталось')} ${Math.floor(timeRemaining / 60)}:${String(timeRemaining % 60).padStart(2, '0')}` : t('Без лимита')}</span></div>
          <p className="helperText">{t('Ответы сохранены на сервере автоматически.')} · {draftStatus === 'saving' ? t('Сохраняем…') : draftStatus === 'error' ? t('Нет связи: черновик сохранён в этой вкладке.') : t('Сохранено')}</p>
          <p className="proctorNotice">{t('Предупреждения о переключении вкладки')}: {submission.proctorWarnings || 0}/3</p>
          {selectedAssignment.questions.map((q: any, qi: number) => <div className="studentQuestion" key={q.id} data-question-id={q.id}><div className="questionNumber">{qi + 1}</div><div className="studentQuestionBody"><b>{q.prompt}</b><small>{isManualQuestion(q.type) ? t('Баллы за текстовый ответ преподаватель выставляет при проверке.') : <>{Number(q.points)} {t('балл(ов) ·')} {t(q.required ? 'Обязательный вопрос' : 'Необязательный')}</>}</small>
            {q.type === 'SINGLE_CHOICE' && q.options.map((o: any) => <label className="studentOption" key={o.id}><input type="radio" name={q.id} checked={answers[q.id] === o.id} onChange={() => setAnswers(old => ({ ...old, [q.id]: o.id }))} />{o.text}</label>)}
            {q.type === 'MULTIPLE_CHOICE' && q.options.map((o: any) => <label className="studentOption" key={o.id}><input type="checkbox" checked={(answers[q.id] || []).includes(o.id)} onChange={e => setAnswers(old => ({ ...old, [q.id]: e.target.checked ? [...(old[q.id] || []), o.id] : (old[q.id] || []).filter((id: string) => id !== o.id) }))} />{o.text}</label>)}
            {q.type === 'NUMERIC' && <input type="number" step="any" value={answers[q.id] ?? ''} onChange={e => setAnswers(old => ({ ...old, [q.id]: e.target.value }))} placeholder={t("Введи число")} />}
            {['SHORT_TEXT', 'LONG_TEXT'].includes(q.type) && <textarea maxLength={20000} rows={q.type === 'LONG_TEXT' ? 5 : 2} value={answers[q.id] ?? ''} onChange={e => setAnswers(old => ({ ...old, [q.id]: e.target.value }))} placeholder={t("Твой ответ")} />}
          </div></div>)}
          <div className="formActions"><button className="secondaryButton" disabled={busy} onClick={exitTest}>{t("Выйти из теста")}</button><button className="primaryButton" disabled={busy} onClick={submitTest}>{busy ? t('Отправляем…') : t('Отправить ответы')}</button></div>
        </section>}
        <footer><strong>Zialy Urpaq мектебі</strong><span>·</span> {t("Учебная платформа")} <span>·</span> {t("Реальные данные из PostgreSQL")}</footer>
      </section>
    </main>
  );
}
