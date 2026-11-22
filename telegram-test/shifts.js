function createShiftBoard({ getMode, showPage, escapeHtml, toast }) {
  const byId = id => document.getElementById(id);
  const form = byId('createForm');
  const publish = byId('shiftPublish');
  const createStatus = byId('shiftCreateStatus');
  const filter = byId('shiftFilter');
  const actions = document.querySelector('main');
  const dialog = byId('shiftActionDialog');
  const dialogForm = byId('shiftActionForm');
  const dialogReason = byId('shiftActionReason');
  const dialogStars = byId('shiftActionStars');
  const dialogError = byId('shiftActionError');
  const dialogSubmit = byId('shiftActionSubmit');
  const dialogBack = byId('shiftActionBack');
  const platforms = { ozon: 'Ozon', wildberries: 'Wildberries', yandex_market: 'Яндекс Маркет' };
  const shiftStatus = {
    open: 'Открыта', confirmed: 'Исполнитель выбран', completed: 'Завершена',
    cancelled: 'Смена отменена', needs_replacement: 'Сотрудник отказался'
  };
  const applicationStatus = {
    pending: 'Отклик отправлен', selected: 'Вы выбраны', not_selected: 'Выбран другой исполнитель',
    closed: 'Приём откликов завершён', cancelled: 'Смена отменена',
    withdrawn: 'Отклик отозван', declined: 'Вы отказались от смены'
  };
  const completionStatus = {
    pending: 'Ожидает подтверждения сотрудника', confirmed: 'Выполнение подтверждено',
    disputed: 'Есть спор по смене', awaiting_request: 'Ожидает отметки руководителем', legacy: 'Завершена до введения подтверждений'
  };
  const versionedDisputeActions = new Set([
    'withdraw_dispute', 'reply_dispute', 'comment_dispute', 'accept_dispute'
  ]);
  const success = {
    apply: 'Отклик отправлен.', confirm: 'Исполнитель выбран.', request_completion: 'Запрос на подтверждение отправлен.',
    confirm_completion: 'Выполнение смены подтверждено.', dispute_completion: 'Сообщение о споре сохранено.',
    review: 'Отзыв сохранён.',
    withdraw_dispute: 'Спор отозван. Подтвердить выполнение можно отдельным действием.',
    reply_dispute: 'Ответ руководителя сохранён.',
    comment_dispute: 'Ваш ответ сохранён. Спор остаётся открытым.',
    accept_dispute: 'Предложение принято. Спор закрыт, выполнение ещё нужно подтвердить.',
    cancel: 'Смена отменена.', withdraw: 'Отклик отозван.', decline: 'Вы отказались от смены.',
    reopen: 'Смена снова открыта для откликов.'
  };
  const errors = {
    manager_profile_required: 'Сначала сохраните анкету руководителя в разделе «Профиль».',
    worker_profile_required: 'Сначала сохраните анкету сотрудника в разделе «Профиль».',
    cannot_apply_to_own_shift: 'На свою смену откликнуться нельзя.',
    shift_not_found: 'Смена недоступна.',
    application_not_found: 'Этот отклик недоступен.',
    shift_not_open: 'Смена уже закрыта для этого действия.',
    shift_not_ready_to_complete: 'Смену можно завершить после окончания работы.',
    shift_terminal: 'Смена завершена или отменена.',
    application_inactive: 'Этот отклик уже отозван или сотрудник отказался.',
    application_already_selected: 'Вас уже назначили. Чтобы снять назначение, откажитесь от смены.',
    application_not_selected: 'Назначение больше не действует.',
    shift_already_started: 'Смена уже началась. Повторно открыть поиск нельзя.',
    shift_state_changed: 'Статус смены изменился. Проверьте его перед повторным действием.',
    completion_client_update: 'Перезапустите Mini App, чтобы загрузить новую версию.',
    completion_under_review: 'Смена ожидает подтверждения или по ней заявлен спор.',
    completion_disputed: 'По смене заявлен спор. Подтверждение приостановлено.',
    completion_request_required: 'Руководитель ещё не отметил смену выполненной.',
    dispute_reason_required: 'Опишите спорную ситуацию.',
    dispute_not_open: 'Этот спор уже закрыт. Обновите страницу.',
    dispute_offer_required: 'Новое предложение руководителя отсутствует.',
    dispute_message_required: 'Введите сообщение до 500 символов.',
    stale_dispute_offer: 'Предложение или спор изменились. Проверьте последнюю запись.',
    dispute_request_conflict: 'Это действие уже отправлено с другими данными.',
    invalid_dispute_version: 'Обновите страницу, чтобы открыть текущий спор.',
    review_self_forbidden: 'Оценивать свой аккаунт нельзя.',
    review_completion_required: 'Отзыв можно оставить после подтверждения смены обеими сторонами.',
    review_already_exists: 'Вы уже оставили отзыв об этой смене.',
    invalid_shift_time: 'Укажите будущее время начала и другое время окончания.',
    invalid_request: 'Проверьте поля формы и попробуйте ещё раз.'
  };

  let request = null;
  let view = null;
  let loadVersion = 0;
  let page = 0;
  let mine = 'outgoing';
  let respondents = null;
  let filters = {};
  let pendingCreate = null;
  let publishing = false;
  let mutating = false;
  let confirmation = null;

  byId('demoListings').hidden = true;
  byId('liveListings').hidden = false;
  byId('demoShifts').hidden = true;
  byId('liveShifts').hidden = false;
  byId('demoLocation').hidden = true;
  byId('demoLocation').disabled = true;
  byId('liveLocation').hidden = false;
  byId('shiftTimeHint').hidden = false;
  byId('homeDataLabel').textContent = '';
  publish.textContent = 'Опубликовать смену';
  byId('shiftCreateHint').textContent = 'Укажите условия, которые увидят сотрудники. Личные контакты храните в анкете.';

  function lockCreate(locked) {
    byId('primaryAction').disabled = locked;
    byId('liveLocation').disabled = locked;
    for (const input of form.querySelectorAll('input, select, textarea, button')) input.disabled = locked;
  }
  lockCreate(true);

  function button(action, label, id = '', extra = '', heading = '') {
    return `<button type="button" class="btn secondary" data-shift-action="${action}" data-id="${escapeHtml(id)}" data-extra="${escapeHtml(extra)}" data-heading="${escapeHtml(heading)}">${escapeHtml(label)}</button>`;
  }

  function message(text, controls = '') {
    return `<div class="card empty">${escapeHtml(text)}${controls ? `<div class="shift-actions">${controls}</div>` : ''}</div>`;
  }

  function dateTime(shift) {
    const options = { timeZone: shift.time_zone, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' };
    const format = new Intl.DateTimeFormat('ru-RU', options);
    return `${format.format(new Date(shift.starts_at))} — ${format.format(new Date(shift.ends_at))}`;
  }

  function historyLine(label, date, reason) {
    if (!date) return '';
    const time = new Date(date).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
    return `<p class="small">${escapeHtml(label)} · ${escapeHtml(time)}${reason ? ` · ${escapeHtml(reason)}` : ''}</p>`;
  }

  function shiftCard(shift, type) {
    let info = '';
    let controls = '';
    const open = shift.status === 'open';
    const future = Date.parse(shift.starts_at) > Date.now();

    const finishing = ['pending', 'disputed'].includes(shift.completion_state);
    if (type === 'browse') {
      if (shift.can_apply) controls = button('apply', 'Откликнуться', shift.id);
      else if (shift.applied) info = 'Отклик отправлен';
      else if (shift.inactive_application) info = applicationStatus[shift.inactive_application];
      else if (shift.own_shift) info = 'Ваше объявление';
      else controls = button('profile', 'Заполнить анкету сотрудника');
    } else if (type === 'owned') {
      controls = button('respondents', `Отклики (${shift.application_count})`, shift.id, '', `${shift.city} · ${shift.pickup_point}`);
      if (shift.status !== 'completed' && shift.status !== 'cancelled' && !finishing) {
        controls += button('cancel', 'Отменить смену', shift.id,
          shift.confirmed_application_id ?? shift.replacement_application_id ?? '', shift.status);
      }
      if (shift.can_reopen) controls += button('reopen', 'Снова открыть поиск', shift.id, shift.replacement_application_id);
      if (shift.can_request_completion) controls += button('request_completion', 'Отметить выполненной', shift.id);
      if (shift.can_reply_dispute && shift.dispute_round_id) {
        controls += button('reply_dispute', 'Ответить на спор', shift.id, shift.dispute_round_id);
      }
      if (open && !future) info = 'Приём откликов завершён';
      if (shift.status === 'needs_replacement' && !shift.can_reopen) {
        info = 'Смена уже началась. Повторно открыть поиск нельзя.';
      }
    } else if (type === 'outgoing') {
      info = applicationStatus[shift.application_status];
      if (shift.can_withdraw) controls = button('withdraw', 'Отозвать отклик', shift.id, shift.application_id);
      if (shift.can_decline && !finishing) controls = button('decline', 'Отказаться от смены', shift.id, shift.application_id);
      if (shift.can_confirm_completion) controls += button('confirm_completion', 'Подтвердить выполнение', shift.id);
      if (shift.can_dispute_completion) controls += button('dispute_completion', 'Сообщить о споре', shift.id);
      if (shift.dispute_round_id) {
        if (shift.can_comment_dispute) controls += button('comment_dispute', 'Написать по спору', shift.id, shift.dispute_round_id);
        if (shift.can_accept_dispute && shift.dispute_offer_id) {
          controls += button('accept_dispute', 'Принять предложение', shift.id, shift.dispute_round_id, shift.dispute_offer_id);
        }
        if (shift.can_withdraw_dispute) controls += button('withdraw_dispute', 'Отозвать спор', shift.id, shift.dispute_round_id);
      }
      const connected = !shift.withdrawn_at && !shift.declined_at && (
        shift.status === 'open' || shift.status === 'needs_replacement' || shift.application_status === 'selected'
      );
      if (connected) controls += socialChatButton(shift.id, shift.application_id, 'Руководитель смены');
    } else if (shift.can_review) {
      controls = button('review', 'Оставить отзыв', shift.id, '', shift.viewer_role);
    }

    const status = completionStatus[shift.completion_state] ?? shiftStatus[shift.status];
    const disputeHistory = Array.isArray(shift.dispute_events) ? shift.dispute_events.map(event => {
      const labels = { opened: 'Спор открыт сотрудником', manager_reply: 'Ответ руководителя',
        worker_comment: 'Ответ сотрудника', withdrawn: 'Спор отозван сотрудником',
        accepted: 'Предложение принято сотрудником' };
      return historyLine(labels[event.action] ?? 'Действие по спору', event.created_at, event.message);
    }).join('') : '';
    const history = type === 'work_history';
    const duration = history ? `${Math.floor(shift.minutes / 60)} ч ${shift.minutes % 60} мин` : '';
    return `<article class="card shift-card">
      <div class="between"><span class="platform">${escapeHtml(platforms[shift.platform])}</span><span class="tag">${escapeHtml(status)}</span></div>
      <div class="name" style="margin-top:8px">${escapeHtml(dateTime(shift))}</div>
      <div class="details">${escapeHtml(shift.city)} · ${escapeHtml(shift.district)} · ${escapeHtml(shift.pickup_point)}</div>
      ${history ? `<div class="details">Продолжительность · ${escapeHtml(duration)}</div><div class="small">Согласованная оплата</div>` : ''}
      <div class="price">${escapeHtml(Number(shift.pay_rubles).toLocaleString('ru-RU'))} ₽</div>
      ${history ? '<p class="small">Выплата не подтверждена.</p>' : ''}
      ${shift.review ? `<p class="small">Ваш отзыв · ${escapeHtml(shift.review.stars)} из 5${shift.review.comment ? ` · ${escapeHtml(shift.review.comment)}` : ''}</p>` : ''}
      ${shift.dispute_reason && !disputeHistory ? `<p class="small">Причина спора · ${escapeHtml(shift.dispute_reason)}</p>` : ''}
      ${disputeHistory ? `<div class="small"><strong>История спора</strong></div>${disputeHistory}` : ''}
      ${shift.notes ? `<p class="small">${escapeHtml(shift.notes)}</p>` : ''}
      ${info ? `<div class="name">${escapeHtml(info)}</div>` : ''}
      ${historyLine('Отклик отозван', shift.withdrawn_at)}
      ${historyLine('Отказ от смены', shift.declined_at, shift.decline_reason)}
      ${historyLine('Смена отменена', shift.cancelled_at, shift.cancellation_reason)}
      ${controls ? `<div class="shift-actions">${controls}</div>` : ''}
    </article>`;
  }

  function socialChatButton(shiftId, applicationId, peer) {
    if (!shiftId || !applicationId) return '';
    return `<button type="button" class="btn ghost" data-social-action="shift-chat" data-social-shift="${escapeHtml(shiftId)}" data-social-application="${escapeHtml(applicationId)}" data-social-peer="${escapeHtml(peer)}">Написать по смене</button>`;
  }

  function respondentCard(entry) {
    const controls = (entry.can_confirm ? button('confirm', 'Выбрать исполнителя', respondents.id, entry.id) : '') +
      (!entry.withdrawn_at && !entry.declined_at && (entry.selected || entry.can_confirm)
        ? socialChatButton(respondents.id, entry.id, entry.name) : '');
    return `<article class="card shift-card">
      <div class="name">${escapeHtml(entry.name)}</div>
      <div class="details">${escapeHtml(entry.city)} · ${escapeHtml(entry.district)} · ${escapeHtml(entry.experience)}</div>
      ${entry.selected ? '<span class="tag">Исполнитель выбран</span>' : ''}
      ${historyLine('Назначение', entry.assigned_at)}
      ${historyLine('Отклик отозван', entry.withdrawn_at)}
      ${historyLine('Сотрудник отказался', entry.declined_at, entry.decline_reason)}
      ${controls ? `<div class="shift-actions">${controls}</div>` : ''}
    </article>`;
  }

  async function readPage(number = 0) {
    if (!view) return;
    const { action, target, input } = view;
    const active = request;
    const version = ++loadVersion;
    page = number;
    if (!active) {
      target.innerHTML = message('Для просмотра войдите через Telegram.');
      return;
    }
    target.innerHTML = message('Загружаем данные…');
    try {
      const response = await active(action, { ...input, page });
      if (loadVersion !== version) return;
      if (!response.ok || !Array.isArray(response.data?.items)) {
        target.innerHTML = message(errors[response.data?.error] ?? 'Не удалось загрузить данные.', button('reload', 'Повторить'));
        return;
      }
      const { items } = response.data;
      const refresh = button('reload', 'Обновить');
      const list = items.slice(0, 30).map(item => action === 'respondents' ? respondentCard(item) : shiftCard(item, action));
      const empty = { browse: 'Подходящих смен пока нет.', owned: 'У вас пока нет объявлений.', outgoing: 'У вас пока нет откликов.', respondents: 'На эту смену пока нет откликов.', work_history: 'Завершённых смен пока нет.' };
      const pager = (page > 0 ? button('previous', 'Предыдущая') : '') + refresh +
        (items.length > 30 ? button('next', 'Следующая') : '');
      target.innerHTML = (list.join('') || message(empty[action])) + `<div class="shift-actions">${pager}</div>`;
    } catch {
      if (loadVersion === version) target.innerHTML = message('Проверьте интернет и повторите загрузку.', button('reload', 'Повторить'));
    }
  }

  async function loadReputation(role = document.querySelector('[data-profile-role][aria-pressed="true"]').dataset.profileRole) {
    const target = byId('profileReputation');
    const active = request;
    const version = ++loadVersion;
    const heading = `<h3>Рейтинг и отзывы · ${role === 'worker' ? 'сотрудник' : 'руководитель'}</h3>`;
    target.innerHTML = heading + `<p>${active ? 'Загружаем рейтинг…' : 'Рейтинг доступен после входа.'}</p>`;
    if (!active) return;
    try {
      const response = await active('reputation', {});
      if (loadVersion !== version) return;
      const value = response.data?.[role];
      if (!response.ok || !Array.isArray(value?.reviews)) throw new Error('Reputation unavailable');
      const average = value.average === null ? '—' : Number(value.average).toLocaleString('ru-RU', {
        minimumFractionDigits: 1, maximumFractionDigits: 1
      });
      target.innerHTML = heading + `<div class="profile-stats">
        <div class="stat"><strong>${escapeHtml(average)}</strong><span>Оценка из 5</span></div>
        <div class="stat"><strong>${escapeHtml(value.review_count)}</strong><span>Отзывов</span></div>
        <div class="stat"><strong>${escapeHtml(value.completed_count)}</strong><span>Подтверждённых смен</span></div>
      </div>` + (value.reviews.length
        ? value.reviews.map(review => historyLine(`${review.stars} из 5`, review.created_at, review.comment)).join('')
        : '<p class="muted">Пока нет отзывов.</p>');
    } catch {
      if (loadVersion === version) target.innerHTML = heading +
        '<p>Не удалось загрузить рейтинг.</p>' + button('reputation', 'Повторить');
    }
  }

  for (const control of document.querySelectorAll('[data-profile-role]')) {
    control.addEventListener('click', () => loadReputation(control.dataset.profileRole));
  }

  function show(id) {
    ++loadVersion;
    view = null;
    if (id === 'homePage') {
      const worker = getMode() === 'worker';
      filter.hidden = !worker;
      for (const control of filter.elements) control.disabled = !request;
      view = { action: worker ? 'browse' : 'owned', target: byId('shiftResults'), input: worker ? filters : {} };
    } else if (id === 'shiftsPage') {
      view = { action: mine, target: byId('myShiftResults'), input: {} };
    } else if (id === 'profilePage') {
      loadReputation();
    } else if (id === 'respondentsPage' && respondents) {
      byId('respondentsTitle').textContent = respondents.heading;
      view = { action: 'respondents', target: byId('respondentsResults'), input: { shift_id: respondents.id } };
    }
    if (view) readPage();
  }

  filter.addEventListener('submit', event => {
    event.preventDefault();
    filters = Object.fromEntries(new FormData(filter));
    filters.platform ||= null;
    show('homePage');
  });

  function showMine(next) {
    mine = next;
    for (const [id, active] of [['myApplications', next === 'outgoing'], ['myListings', next === 'owned'], ['myHistory', next === 'work_history']]) {
      byId(id).classList.toggle('active', active);
      byId(id).setAttribute('aria-pressed', String(active));
    }
    show('shiftsPage');
  }
  byId('myApplications').addEventListener('click', () => showMine('outgoing'));
  byId('myListings').addEventListener('click', () => showMine('owned'));
  byId('myHistory').addEventListener('click', () => showMine('work_history'));
  byId('backFromRespondents').addEventListener('click', () => showPage(respondents?.back ?? 'shiftsPage'));

  function askConfirmation(action, input, context) {
    confirmation = { action, input };
    dialogForm.reset();
    dialogError.textContent = '';
    byId('shiftStarsField').hidden = action !== 'review';
    byId('shiftReasonField').hidden = ['confirm_completion', 'withdraw_dispute', 'accept_dispute'].includes(action);
    byId('shiftReasonLabel').textContent = action === 'review' ? 'Отзыв (необязательно)'
      : action === 'dispute_completion' ? 'Причина спора'
      : ['reply_dispute', 'comment_dispute'].includes(action) ? 'Сообщение' : 'Причина (необязательно)';
    dialogStars.required = action === 'review';
    dialogReason.required = ['dispute_completion', 'reply_dispute', 'comment_dispute'].includes(action);
    if (action === 'decline') {
      byId('shiftActionTitle').textContent = 'Отказаться от смены?';
      byId('shiftActionWarning').textContent =
        'Вы больше не будете исполнителем. Руководитель увидит отказ и указанную причину.';
    } else if (action === 'confirm_completion') {
      byId('shiftActionTitle').textContent = 'Подтвердить выполнение?';
      byId('shiftActionWarning').textContent = 'Смена попадёт в историю, и обе стороны смогут оставить отзыв.';
    } else if (action === 'dispute_completion') {
      byId('shiftActionTitle').textContent = 'Сообщить о споре';
      byId('shiftActionWarning').textContent = 'Руководитель увидит причину. До решения спора завершение и отзывы недоступны.';
    } else if (action === 'withdraw_dispute') {
      byId('shiftActionTitle').textContent = 'Отозвать спор?';
      byId('shiftActionWarning').textContent = 'Спор останется в истории. Если руководитель уже отметил работу, вы отдельно сможете подтвердить её выполнение. Выплата автоматически не подтверждается.';
    } else if (action === 'accept_dispute') {
      byId('shiftActionTitle').textContent = 'Принять предложение руководителя?';
      byId('shiftActionWarning').textContent = 'Спор будет закрыт, но факт выполнения смены потребуется подтвердить отдельно. Выплата автоматически не подтверждается.';
    } else if (action === 'reply_dispute') {
      byId('shiftActionTitle').textContent = 'Ответить на спор';
      byId('shiftActionWarning').textContent = 'Сотрудник увидит ваш ответ и сможет принять предложение или продолжить обсуждение. Только сотрудник закрывает спор.';
    } else if (action === 'comment_dispute') {
      byId('shiftActionTitle').textContent = 'Ответить руководителю';
      byId('shiftActionWarning').textContent = 'Ваш ответ сохранится в истории. Спор останется открытым.';
    } else if (action === 'review') {
      byId('shiftActionTitle').textContent = context === 'manager' ? 'Оценить сотрудника' : 'Оценить руководителя';
      byId('shiftActionWarning').textContent = 'Получатель увидит оценку и текст. Отзыв сохраняется один раз.';
    } else {
      byId('shiftActionTitle').textContent = 'Отменить смену?';
      byId('shiftActionWarning').textContent = context === 'confirmed'
        ? 'На смену уже назначен сотрудник. Отмена снимет назначение и закроет смену.'
        : 'Смена исчезнет из поиска. Отклики останутся в истории.';
    }
    dialog.showModal();
  }

  function closeConfirmation() {
    if (dialog.open) dialog.close();
    confirmation = null;
    dialogForm.reset();
    dialogError.textContent = '';
  }

  dialogBack.addEventListener('click', closeConfirmation);
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    if (!mutating) closeConfirmation();
  });
  dialogForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!confirmation) return;
    const { action, input } = confirmation;
    const text = dialogReason.value.trim();
    const details = action === 'review' ? { stars: Number(dialogStars.value), comment: text }
      : ['confirm_completion', 'withdraw_dispute', 'accept_dispute'].includes(action) ? {}
      : ['reply_dispute', 'comment_dispute'].includes(action) ? { message: text } : { reason: text };
    if (['dispute_completion', 'reply_dispute', 'comment_dispute'].includes(action) && !text) {
      dialogError.textContent = 'Опишите спорную ситуацию.';
      return;
    }
    mutate(action, { ...input, ...details }, dialogSubmit);
  });

  async function mutate(action, input, control) {
    if (!request || mutating) return;
    const active = request;
    const activeView = view;
    const fromDialog = control === dialogSubmit;
    const report = message => {
      if (fromDialog && dialog.open) dialogError.textContent = message;
      else toast(message);
    };
    mutating = true;
    control.disabled = true;
    if (fromDialog) {
      dialogReason.disabled = true;
      dialogStars.disabled = true;
      dialogBack.disabled = true;
      dialogError.textContent = '';
    }
    try {
      const response = await active(action, input);
      if (request !== active) return;
      const saved = response.ok && response.data?.saved === true;
      const refresh = saved || response.status === 409 || response.status === 404;
      if (refresh && fromDialog) closeConfirmation();
      report(saved ? (response.data.replayed ? 'Действие уже было выполнено.' : success[action])
        : errors[response.data?.error] ?? 'Действие не подтверждено. Попробуйте ещё раз.');
      if (view === activeView && refresh) readPage(page);
    } catch {
      if (request === active) report('Действие не подтверждено. Проверьте интернет и повторите.');
    } finally {
      mutating = false;
      control.disabled = false;
      if (fromDialog) {
        dialogReason.disabled = false;
        dialogStars.disabled = false;
        dialogBack.disabled = false;
      }
    }
  }

  actions.addEventListener('click', event => {
    const control = event.target.closest('[data-shift-action]');
    if (!control || !request) return;
    const { shiftAction: action, id, extra, heading } = control.dataset;
    if (action === 'reputation') {
      loadReputation();
      return;
    }
    if (action === 'reload' || action === 'previous' || action === 'next') {
      readPage(page + ({ previous: -1, next: 1 }[action] ?? 0));
      return;
    }
    if (action === 'profile') {
      showPage('profilePage');
      return;
    }
    if (action === 'respondents') {
      respondents = { id, heading, back: document.querySelector('.page.active').id };
      showPage('respondentsPage');
      return;
    }
    if (mutating) return;
    const input = { shift_id: id };
    if (versionedDisputeActions.has(action)) {
      input.round_id = extra;
      input.request_id = crypto.randomUUID();
      if (action === 'accept_dispute') input.offer_id = heading;
    } else if (action === 'cancel') input.expected_application_id = extra || null;
    else if (extra) input.application_id = extra;
    if (['decline', 'cancel', 'confirm_completion', 'dispute_completion', 'review',
      'withdraw_dispute', 'reply_dispute', 'comment_dispute', 'accept_dispute'].includes(action)) {
      askConfirmation(action, input, heading);
    }
    else mutate(action, input, control);
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!request || publishing) return;
    const value = id => byId(id).value.trim();
    const active = request;
    const data = {
      platform: Object.keys(platforms).find(code => platforms[code] === value('newPlatform')),
      city: value('newCity'), district: value('newLiveDistrict'), pickup_point: value('newAddress'),
      date: value('newDate'), start_time: value('newStart'), end_time: value('newEnd'),
      time_zone: value('newZone'), pay_rubles: Number(value('newPrice')), notes: value('newNote')
    };
    const fingerprint = JSON.stringify(data);
    if (pendingCreate?.fingerprint !== fingerprint) pendingCreate = { fingerprint, id: crypto.randomUUID() };
    publishing = true;
    lockCreate(true);
    createStatus.textContent = 'Публикуем смену…';
    try {
      const response = await active('create', { ...data, request_id: pendingCreate.id });
      if (request !== active) return;
      if (!response.ok || !response.data?.id) {
        createStatus.textContent = errors[response.data?.error] ?? 'Публикация не подтверждена. Попробуйте ещё раз.';
        return;
      }
      pendingCreate = null;
      form.reset();
      createStatus.textContent = '';
      if (byId('createPage').classList.contains('active')) showPage('homePage');
      else if (view?.action === 'owned') readPage();
      toast('Смена опубликована.');
    } catch {
      if (request === active) createStatus.textContent = 'Публикация не подтверждена. Проверьте интернет и повторите.';
    } finally {
      publishing = false;
      if (request === active) lockCreate(false);
    }
  });

  show('homePage');
  return {
    show,
    connect(send) {
      request = send;
      lockCreate(false);
      show(document.querySelector('.page.active').id);
    },
    disconnect() {
      request = null;
      respondents = null;
      pendingCreate = null;
      closeConfirmation();
      form.reset();
      createStatus.textContent = '';
      lockCreate(true);
      for (const id of ['shiftResults', 'myShiftResults', 'respondentsResults', 'respondentsTitle']) {
        byId(id).textContent = '';
      }
      byId('profileReputation').textContent = 'Рейтинг доступен после входа.';
      const active = document.querySelector('.page.active').id;
      if (active === 'respondentsPage' || active === 'createPage') showPage('homePage');
      else show(active);
    }
  };
}
