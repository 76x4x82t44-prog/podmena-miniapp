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
  const success = {
    apply: 'Отклик отправлен.', confirm: 'Исполнитель выбран.', complete: 'Смена завершена.',
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

    if (type === 'browse') {
      if (shift.can_apply) controls = button('apply', 'Откликнуться', shift.id);
      else if (shift.applied) info = 'Отклик отправлен';
      else if (shift.inactive_application) info = applicationStatus[shift.inactive_application];
      else if (shift.own_shift) info = 'Ваше объявление';
      else controls = button('profile', 'Заполнить анкету сотрудника');
    } else if (type === 'owned') {
      controls = button('respondents', `Отклики (${shift.application_count})`, shift.id, '', `${shift.city} · ${shift.pickup_point}`);
      if (shift.status !== 'completed' && shift.status !== 'cancelled') {
        controls += button('cancel', 'Отменить смену', shift.id,
          shift.confirmed_application_id ?? shift.replacement_application_id ?? '', shift.status);
      }
      if (shift.can_reopen) controls += button('reopen', 'Снова открыть поиск', shift.id, shift.replacement_application_id);
      if (shift.status === 'confirmed' && Date.parse(shift.ends_at) <= Date.now()) {
        controls += button('complete', 'Завершить смену', shift.id);
      }
      if (open && !future) info = 'Приём откликов завершён';
      if (shift.status === 'needs_replacement' && !shift.can_reopen) {
        info = 'Смена уже началась. Повторно открыть поиск нельзя.';
      }
    } else {
      info = applicationStatus[shift.application_status];
      if (shift.can_withdraw) controls = button('withdraw', 'Отозвать отклик', shift.id, shift.application_id);
      if (shift.can_decline) controls = button('decline', 'Отказаться от смены', shift.id, shift.application_id);
    }

    return `<article class="card shift-card">
      <div class="between"><span class="platform">${escapeHtml(platforms[shift.platform])}</span><span class="tag">${escapeHtml(shiftStatus[shift.status])}</span></div>
      <div class="name" style="margin-top:8px">${escapeHtml(dateTime(shift))}</div>
      <div class="details">${escapeHtml(shift.city)} · ${escapeHtml(shift.district)} · ${escapeHtml(shift.pickup_point)}</div>
      <div class="price">${escapeHtml(Number(shift.pay_rubles).toLocaleString('ru-RU'))} ₽</div>
      ${shift.notes ? `<p class="small">${escapeHtml(shift.notes)}</p>` : ''}
      ${info ? `<div class="name">${escapeHtml(info)}</div>` : ''}
      ${historyLine('Отклик отозван', shift.withdrawn_at)}
      ${historyLine('Отказ от смены', shift.declined_at, shift.decline_reason)}
      ${historyLine('Смена отменена', shift.cancelled_at, shift.cancellation_reason)}
      ${controls ? `<div class="shift-actions">${controls}</div>` : ''}
    </article>`;
  }

  function respondentCard(entry) {
    return `<article class="card shift-card">
      <div class="name">${escapeHtml(entry.name)}</div>
      <div class="details">${escapeHtml(entry.city)} · ${escapeHtml(entry.district)} · ${escapeHtml(entry.experience)}</div>
      ${entry.selected ? '<span class="tag">Исполнитель выбран</span>' : ''}
      ${historyLine('Назначение', entry.assigned_at)}
      ${historyLine('Отклик отозван', entry.withdrawn_at)}
      ${historyLine('Сотрудник отказался', entry.declined_at, entry.decline_reason)}
      ${entry.can_confirm ? `<div class="shift-actions">${button('confirm', 'Выбрать исполнителя', respondents.id, entry.id)}</div>` : ''}
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
      const empty = { browse: 'Подходящих смен пока нет.', owned: 'У вас пока нет объявлений.', outgoing: 'У вас пока нет откликов.', respondents: 'На эту смену пока нет откликов.' };
      const pager = (page > 0 ? button('previous', 'Предыдущая') : '') + refresh +
        (items.length > 30 ? button('next', 'Следующая') : '');
      target.innerHTML = (list.join('') || message(empty[action])) + `<div class="shift-actions">${pager}</div>`;
    } catch {
      if (loadVersion === version) target.innerHTML = message('Проверьте интернет и повторите загрузку.', button('reload', 'Повторить'));
    }
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
    for (const [id, active] of [['myApplications', next === 'outgoing'], ['myListings', next === 'owned']]) {
      byId(id).classList.toggle('active', active);
      byId(id).setAttribute('aria-pressed', String(active));
    }
    show('shiftsPage');
  }
  byId('myApplications').addEventListener('click', () => showMine('outgoing'));
  byId('myListings').addEventListener('click', () => showMine('owned'));
  byId('backFromRespondents').addEventListener('click', () => showPage(respondents?.back ?? 'shiftsPage'));

  function askConfirmation(action, input, shiftStatus) {
    confirmation = { action, input };
    dialogForm.reset();
    dialogError.textContent = '';
    if (action === 'decline') {
      byId('shiftActionTitle').textContent = 'Отказаться от смены?';
      byId('shiftActionWarning').textContent =
        'Вы больше не будете исполнителем. Руководитель увидит отказ и указанную причину.';
    } else {
      byId('shiftActionTitle').textContent = 'Отменить смену?';
      byId('shiftActionWarning').textContent = shiftStatus === 'confirmed'
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
    mutate(action, { ...input, reason: dialogReason.value.trim() }, dialogSubmit);
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
        dialogBack.disabled = false;
      }
    }
  }

  actions.addEventListener('click', event => {
    const control = event.target.closest('[data-shift-action]');
    if (!control || !request) return;
    const { shiftAction: action, id, extra, heading } = control.dataset;
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
    if (action === 'cancel') input.expected_application_id = extra || null;
    else if (extra) input.application_id = extra;
    if (action === 'decline' || action === 'cancel') askConfirmation(action, input, heading);
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
      const active = document.querySelector('.page.active').id;
      if (active === 'respondentsPage' || active === 'createPage') showPage('homePage');
      else show(active);
    }
  };
}
