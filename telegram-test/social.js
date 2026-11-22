'use strict';

function createSocialBoard({ getMode, showPage, toast }) {
  const byId = id => document.getElementById(id);
  const platformNames = { ozon: 'Ozon', wildberries: 'Wildberries', yandex_market: 'Яндекс Маркет' };
  const workNames = { single: 'Разовые смены', permanent: 'Постоянная работа' };
  const errorLabels = {
    actor_missing_manager_profile: 'Сохраните анкету руководителя, чтобы открыть каталог.',
    manager_profile_required: 'Сохраните анкету руководителя, чтобы открыть каталог.',
    actor_missing_worker_profile: 'Сохраните анкету сотрудника, чтобы включить её в каталог.',
    worker_profile_required: 'Сохраните анкету сотрудника, чтобы включить её в каталог.',
    blocked: 'Переписка ограничена.',
    forbidden: 'Это действие недоступно.',
    not_found: 'Запись недоступна или уже изменена.',
    contact_already_decided: 'Запрос уже обработан. Обновите список.',
    contact_already_rejected: 'Этот запрос уже отклонён.',
    idempotency_conflict: 'Очистите поле, снова введите сообщение и повторите отправку.',
    rate_limited: 'Слишком много действий. Подождите перед повторной попыткой.',
    invalid_request: 'Проверьте заполнение формы.',
    service_unavailable: 'Сервис временно недоступен. Попробуйте ещё раз.'
  };

  const filterForm = byId('pilotCatalogFilters');
  const catalogItems = byId('pilotCatalogItems');
  const settingsForm = byId('pilotSettings');
  const settingsFields = byId('pilotSettingsFields');
  const messageField = byId('pilotMessage');
  const sendButton = byId('pilotSend');
  const history = byId('pilotChatHistory');
  const reportDialog = byId('pilotReportDialog');
  const inboxStatus = byId('pilotChatsStatus');
  const chatStatus = byId('pilotChatStatus');

  let request = null;
  let page = null;
  let catalogPage = 0;
  let catalogFilter = {};
  let catalogVersion = 0;
  let inboxVersion = 0;
  let connectionPage = 0;
  let threadPage = 0;
  let thread = null;
  let preferences = null;
  let settingsBusy = false;
  let reportTarget = null;
  let reportBusy = false;
  let loadingInbox = false;
  let pollTimer;
  const contactRequests = new Set();
  const unreadThreads = new Set();

  const element = (tag, className, text) => {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  };

  function button(label, activate, className = 'btn secondary') {
    const control = element('button', className, label);
    control.type = 'button';
    control.addEventListener('click', () => activate(control));
    return control;
  }

  function status(target, message, error = false) {
    target.toggleAttribute('data-error', error);
    if (target.textContent !== message) target.textContent = message;
  }

  function failed(error) {
    const key = error?.code;
    return Object.hasOwn(errorLabels, key)
      ? errorLabels[key] : 'Не удалось выполнить действие. Проверьте сеть и попробуйте ещё раз.';
  }

  async function call(active, action, input = {}) {
    const response = await active(action, input);
    if (!response.ok || !response.data) {
      throw Object.assign(new Error('Social API rejected request'), { code: response.data?.error });
    }
    return response.data;
  }

  function setContent(target, items, draw, fallback) {
    target.replaceChildren(...(items.length ? items.map(draw) : [element('p', 'muted', fallback)]));
  }

  function contactCard(worker) {
    const card = element('article', 'card pilot-panel');
    card.append(element('h3', 'name', worker.name));
    const locations = [worker.city, worker.district].filter(Boolean).join(' · ');
    const platforms = Array.isArray(worker.platforms) ? worker.platforms.map(code => platformNames[code]).filter(Boolean) : [];
    const formats = Array.isArray(worker.work_types) ? worker.work_types.map(code => workNames[code]).filter(Boolean) : [];
    card.append(element('p', 'details', [locations, ...platforms, worker.experience, ...formats].filter(Boolean).join(' · ')));
    if (worker.description) card.append(element('p', 'pilot-text', worker.description));
    const rating = worker.average == null ? 'Пока нет отзывов'
      : `Оценка ${Number(worker.average).toLocaleString('ru-RU')} из 5 · Отзывов: ${worker.review_count}`;
    card.append(element('p', 'small', `${rating} · Подтверждённых смен: ${worker.completed_count ?? 0}`));
    const actions = element('div', 'pilot-toolbar');
    const requested = contactRequests.has(worker.catalog_id);
    const requestButton = button(requested ? 'Запрос отправлен' : 'Запросить связь', async control => {
      const active = request;
      if (!active) return;
      control.disabled = true;
      try {
        const result = await call(active, 'request_contact', { catalog_id: worker.catalog_id });
        if (request !== active) return;
        if (!result.saved) throw new Error('Contact request unconfirmed');
        contactRequests.add(worker.catalog_id);
        control.textContent = 'Запрос отправлен';
        toast('Запрос на связь отправлен.');
      } catch (error) {
        if (request !== active) return;
        control.disabled = false;
        toast(failed(error));
      }
    });
    requestButton.disabled = requested;
    actions.append(requestButton, button('Пожаловаться', () => openReport({ catalog_id: worker.catalog_id }), 'btn ghost'));
    card.append(actions);
    return card;
  }

  async function loadCatalog() {
    const active = request;
    const version = ++catalogVersion;
    const managerMode = getMode() === 'manager';
    filterForm.hidden = !managerMode;
    byId('pilotCatalogMode').hidden = managerMode;
    byId('pilotCatalogPaging').hidden = true;
    catalogItems.replaceChildren();
    const targetStatus = byId('pilotCatalogStatus');
    status(targetStatus, managerMode && !active ? 'Войдите через Telegram для доступа к каталогу.' : '');
    if (!active || !managerMode) return;
    status(targetStatus, 'Загружаем каталог…');
    try {
      const data = await call(active, 'catalog', { ...catalogFilter, page: catalogPage });
      if (request !== active || page !== 'searchPage' || version !== catalogVersion) return;
      setContent(catalogItems, data.items, contactCard, 'По этим фильтрам сотрудники не найдены.');
      status(targetStatus, '');
      byId('pilotCatalogPrevious').disabled = catalogPage === 0;
      byId('pilotCatalogNext').disabled = !data.has_more;
      byId('pilotCatalogPaging').hidden = catalogPage === 0 && !data.has_more;
    } catch (error) {
      if (request === active && version === catalogVersion) status(targetStatus, failed(error), true);
    }
  }

  filterForm.addEventListener('submit', event => {
    event.preventDefault();
    catalogFilter = Object.fromEntries(Array.from(new FormData(filterForm),
      ([key, value]) => [key, value.trim()]).filter(([, value]) => value));
    catalogPage = 0;
    loadCatalog();
  });
  byId('pilotCatalogPrevious').addEventListener('click', () => { catalogPage -= 1; loadCatalog(); });
  byId('pilotCatalogNext').addEventListener('click', () => { catalogPage += 1; loadCatalog(); });

  function applyPreferences(value) {
    preferences = value;
    byId('pilotVisibility').checked = value.visible === true;
    byId('pilotNotify').checked = value.notifications_enabled === true;
    byId('pilotPublicDescription').value = value.description ?? '';
  }

  async function loadSettings() {
    const active = request;
    const target = byId('pilotSettingsStatus');
    if (!active || settingsBusy) return;
    const retry = byId('pilotSettingsRetry');
    settingsBusy = true;
    retry.hidden = true;
    settingsFields.disabled = true;
    status(target, 'Загружаем настройки…');
    try {
      const value = await call(active, 'settings');
      if (request !== active) return;
      applyPreferences(value);
      settingsFields.disabled = false;
      status(target, '');
    } catch (error) {
      if (request !== active) return;
      retry.hidden = false;
      status(target, failed(error), true);
    } finally {
      if (request === active) settingsBusy = false;
    }
  }

  byId('pilotSettingsRetry').addEventListener('click', loadSettings);
  settingsForm.addEventListener('submit', async event => {
    event.preventDefault();
    const active = request;
    if (!active || !preferences || settingsBusy) return;
    const values = {
      visible: byId('pilotVisibility').checked,
      description: byId('pilotPublicDescription').value.trim(),
      notifications_enabled: byId('pilotNotify').checked
    };
    const changes = Object.fromEntries(Object.entries(values)
      .filter(([name, value]) => value !== (preferences[name] ?? (name === 'description' ? '' : false))));
    const target = byId('pilotSettingsStatus');
    if (!Object.keys(changes).length) {
      status(target, 'Настройки сохранены.');
      return;
    }
    settingsBusy = true;
    settingsFields.disabled = true;
    status(target, 'Сохраняем настройки…');
    try {
      const value = await call(active, 'save_settings', changes);
      if (request !== active) return;
      applyPreferences(value);
      status(target, 'Настройки сохранены.');
    } catch (error) {
      if (request === active) status(target, failed(error), true);
    } finally {
      if (request === active) {
        settingsBusy = false;
        settingsFields.disabled = false;
      }
    }
  });

  const connectionStateLabels = { pending: 'Ожидает ответа', accepted: 'Принят', rejected: 'Отклонён', blocked: 'Заблокирован' };
  function connectionCard(connection) {
    const card = element('article', 'card pilot-panel');
    card.append(element('h3', 'name', connection.name));
    card.append(element('p', 'small', `${connection.direction === 'incoming' ? 'Входящий запрос' : 'Отправленный запрос'} · ${connectionStateLabels[connection.status] ?? 'Обработан'}`));
    const actions = element('div', 'pilot-toolbar');
    if (connection.status === 'pending' && connection.direction === 'incoming') {
      const decide = async (decision, control) => {
        const active = request;
        if (!active || actions.dataset.busy) return;
        actions.dataset.busy = 'true';
        control.disabled = true;
        try {
          const value = await call(active, 'decide_contact', { request_id: connection.request_id, decision });
          if (request !== active) return;
          if (!value.saved) throw new Error('Decision unconfirmed');
          if (value.thread_id && decision === 'accept') openThread(value.thread_id, connection.name);
          else loadInbox();
        } catch (error) {
          if (request === active) status(inboxStatus, failed(error), true);
        } finally {
          delete actions.dataset.busy;
          control.disabled = false;
        }
      };
      actions.append(
        button('Принять запрос', control => decide('accept', control)),
        button('Отклонить', control => decide('reject', control), 'btn ghost'),
        button('Заблокировать', control => decide('block', control), 'btn ghost')
      );
    }
    if (connection.status === 'accepted' && connection.thread_id) {
      actions.append(button('Открыть диалог', () => openThread(connection.thread_id, connection.name)));
    }
    if (connection.blocked_by_me && !connection.thread_id) {
      actions.append(button('Разблокировать', async control => {
        const active = request;
        if (!active) return;
        control.disabled = true;
        try {
          const value = await call(active, 'unblock', { request_id: connection.request_id });
          if (request !== active) return;
          if (!value.saved) throw new Error('Unblock unconfirmed');
          loadInbox();
        } catch (error) {
          if (request === active) status(inboxStatus, failed(error), true);
        } finally {
          control.disabled = false;
        }
      }, 'btn ghost'));
    }
    actions.append(button('Пожаловаться', () => openReport({ request_id: connection.request_id }), 'btn ghost'));
    card.append(actions);
    return card;
  }

  function threadCard(entry) {
    const card = element('article', 'card pilot-panel');
    card.append(element('h3', 'name', entry.name));
    if (entry.unread_count) card.append(element('p', 'pilot-badge', `Непрочитанных: ${entry.unread_count}`));
    if (entry.blocked || entry.can_send === false) card.append(element('p', 'small', 'Отправка сообщений ограничена.'));
    const actions = element('div', 'pilot-toolbar');
    actions.append(button('Открыть диалог', () => openThread(entry.thread_id, entry.name)));
    card.append(actions);
    return card;
  }

  function updateList(id, entries, draw, fallback) {
    const target = byId(id);
    const signature = JSON.stringify(entries);
    if (target.dataset.signature === signature) return;
    setContent(target, entries, draw, fallback);
    target.dataset.signature = signature;
  }

  function setUnread(items) {
    unreadThreads.clear();
    for (const thread of items) {
      if (Number(thread.unread_count) > 0) unreadThreads.add(thread.thread_id);
    }
    byId('pilotUnreadBadge').hidden = unreadThreads.size === 0;
  }

  async function loadInbox() {
    const active = request;
    if (!active || loadingInbox || document.hidden) return;
    const version = ++inboxVersion;
    loadingInbox = true;
    if (!byId('pilotConnections').dataset.signature && page === 'messagesPage' && !thread) {
      status(inboxStatus, 'Загружаем чаты…');
    }
    try {
      const [connections, threads] = await Promise.all([
        call(active, 'connections', { page: connectionPage }),
        call(active, 'threads', { page: threadPage })
      ]);
      if (request !== active || version !== inboxVersion || page !== 'messagesPage' || thread) return;
      updateList('pilotConnections', connections.items, connectionCard, 'Запросов на связь пока нет.');
      updateList('pilotThreadList', threads.items, threadCard, 'Диалогов пока нет.');
      byId('pilotPreviousConnections').hidden = connectionPage === 0;
      byId('pilotPreviousThreads').hidden = threadPage === 0;
      byId('pilotMoreConnections').hidden = !connections.has_more;
      byId('pilotMoreThreads').hidden = !threads.has_more;
      if (threadPage === 0) setUnread(threads.items);
      status(inboxStatus, '');
    } catch (error) {
      if (request === active && version === inboxVersion && page === 'messagesPage' && !thread) {
        status(inboxStatus, failed(error), true);
      }
    } finally {
      if (version === inboxVersion) loadingInbox = false;
    }
  }

  byId('pilotChatRefresh').addEventListener('click', loadInbox);
  function moveInbox(changePage) {
    if (loadingInbox) return;
    changePage();
    loadInbox();
  }
  byId('pilotPreviousConnections').addEventListener('click', () => moveInbox(() => { connectionPage -= 1; }));
  byId('pilotMoreConnections').addEventListener('click', () => moveInbox(() => { connectionPage += 1; }));
  byId('pilotPreviousThreads').addEventListener('click', () => moveInbox(() => { threadPage -= 1; }));
  byId('pilotMoreThreads').addEventListener('click', () => moveInbox(() => { threadPage += 1; }));

  function renderMessages(current, prepend = false) {
    const height = history.scrollHeight;
    const wasAtEnd = height - history.scrollTop - history.clientHeight < 48;
    updateList('pilotChatHistory', current.messages, item => {
      const bubble = element('article', `pilot-message${item.mine ? ' pilot-message--mine' : ''}`);
      bubble.append(element('p', 'pilot-text', item.body));
      const stamp = new Date(item.created_at);
      if (Number.isFinite(stamp.valueOf())) {
        const time = element('time', 'small', stamp.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }));
        time.dateTime = stamp.toISOString();
        bubble.append(time);
      }
      return bubble;
    }, 'Сообщений пока нет.');
    if (prepend) history.scrollTop += history.scrollHeight - height;
    else if (wasAtEnd) history.scrollTop = history.scrollHeight;
  }

  function showComposerState(current) {
    const locked = !current.ready || current.blocked || current.canSend === false;
    messageField.disabled = locked;
    sendButton.disabled = locked || current.sending;
    byId('pilotBlock').hidden = !current.ready || (current.blocked && !current.blockedByMe);
    byId('pilotBlock').textContent = current.blockedByMe ? 'Разблокировать' : 'Заблокировать';
  }

  async function loadMessages({ older = false, afterMutation = false } = {}) {
    const active = request;
    const current = thread;
    if (!active || !current || document.hidden) return;
    if (current.loading) {
      if (afterMutation) current.reload = true;
      return;
    }
    const before = older ? current.messages[0]?.message_id : null;
    if (older && !before) return;
    current.loading = true;
    if (!current.ready) status(chatStatus, 'Загружаем сообщения…');
    try {
      const value = await call(active, 'messages', { thread_id: current.id, ...(before ? { before } : {}) });
      if (request !== active || thread !== current || page !== 'messagesPage') return;
      const merged = new Map();
      const ordered = older ? [...value.items, ...current.messages] : [...current.messages, ...value.items];
      ordered.forEach(item => merged.set(item.message_id, item));
      current.messages = Array.from(merged.values());
      current.ready = true;
      current.blocked = value.blocked === true;
      current.blockedByMe = value.blocked_by_me === true;
      current.canSend = value.can_send !== false;
      if (before || current.hasMore === null) current.hasMore = value.has_more === true;
      byId('pilotOlder').hidden = !current.hasMore;
      renderMessages(current, older);
      showComposerState(current);
      if (current.blocked || !current.canSend) status(chatStatus, 'Отправка сообщений ограничена.');
      else if (chatStatus.textContent === 'Отправка сообщений ограничена.' ||
          chatStatus.textContent === 'Загружаем сообщения…') status(chatStatus, '');
      const latest = value.items.at(-1)?.message_id;
      if (latest && !before && current.lastRead !== latest) {
        try {
          await call(active, 'mark_read', { thread_id: current.id, message_id: latest });
          current.lastRead = latest;
          if (request === active) {
            unreadThreads.delete(current.id);
            byId('pilotUnreadBadge').hidden = unreadThreads.size === 0;
          }
        } catch {
          // The next poll retries the read acknowledgement.
        }
      }
    } catch (error) {
      if (request === active && thread === current && page === 'messagesPage') {
        if (error.code === 'not_found' || error.code === 'forbidden') {
          current.ready = false;
          current.messages = [];
          history.replaceChildren();
          delete history.dataset.signature;
          byId('pilotOlder').hidden = true;
          showComposerState(current);
        }
        status(chatStatus, failed(error), true);
      }
    } finally {
      current.loading = false;
      if (current.reload && thread === current && page === 'messagesPage') {
        current.reload = false;
        loadMessages();
      }
    }
  }

  function openThread(id, name) {
    if (!request || !id) return;
    thread = { id, name: name || 'Диалог', messages: [], hasMore: null };
    history.replaceChildren();
    delete history.dataset.signature;
    messageField.value = '';
    status(chatStatus, '');
    showPage('messagesPage');
    messageField.focus({ preventScroll: true });
  }

  byId('pilotBackToChats').addEventListener('click', () => {
    thread = null;
    messageField.value = '';
    show('messagesPage');
  });
  byId('pilotOlder').addEventListener('click', () => loadMessages({ older: true }));
  byId('pilotComposer').addEventListener('submit', async event => {
    event.preventDefault();
    const active = request;
    const current = thread;
    const body = messageField.value.trim();
    if (!active || !current?.ready || current.sending || current.blocked || current.canSend === false || !body) return;
    current.sending = true;
    if (current.pending?.body !== body) current.pending = { body, request_id: crypto.randomUUID() };
    showComposerState(current);
    status(chatStatus, '');
    try {
      const value = await call(active, 'send_message', { thread_id: current.id, ...current.pending });
      if (request !== active || thread !== current) return;
      if (!value.saved) throw new Error('Message unconfirmed');
      current.pending = null;
      if (messageField.value.trim() === body) messageField.value = '';
      status(chatStatus, 'Сообщение отправлено.');
      loadMessages({ afterMutation: true });
    } catch (error) {
      if (request === active && thread === current) {
        if (error.code === 'blocked' || error.code === 'forbidden') loadMessages({ afterMutation: true });
        status(chatStatus, failed(error), true);
      }
    } finally {
      if (request === active && thread === current) {
        current.sending = false;
        showComposerState(current);
      }
    }
  });

  byId('pilotBlock').addEventListener('click', async event => {
    const active = request;
    const current = thread;
    if (!active || !current?.ready || current.blocking) return;
    current.blocking = true;
    const control = event.currentTarget;
    control.disabled = true;
    const blocking = !current.blockedByMe;
    try {
      const value = await call(active, blocking ? 'block' : 'unblock', { thread_id: current.id });
      if (request !== active || thread !== current) return;
      if (!value.saved) throw new Error('Block action unconfirmed');
      current.ready = false;
      showComposerState(current);
      status(chatStatus, blocking ? 'Собеседник заблокирован.' : 'Блокировка снята.');
      loadMessages({ afterMutation: true });
    } catch (error) {
      if (request === active && thread === current) status(chatStatus, failed(error), true);
    } finally {
      current.blocking = false;
      control.disabled = false;
    }
  });

  function openReport(target) {
    if (!request || reportBusy) return;
    reportTarget = target;
    byId('pilotReportForm').reset();
    status(byId('pilotReportStatus'), '');
    reportDialog.showModal();
  }
  byId('pilotReportThread').addEventListener('click', () => {
    if (thread) openReport({ thread_id: thread.id });
  });
  byId('pilotCloseReport').addEventListener('click', () => reportDialog.close());
  reportDialog.addEventListener('cancel', event => {
    if (reportBusy) event.preventDefault();
  });
  reportDialog.addEventListener('close', () => {
    reportTarget = null;
    byId('pilotReportForm').reset();
  });
  byId('pilotReportForm').addEventListener('submit', async event => {
    event.preventDefault();
    const active = request;
    const reason = byId('pilotReportReason').value.trim();
    if (!active || !reportTarget || !reason || reportBusy) return;
    const controls = [byId('pilotReportReason'), byId('pilotSubmitReport'), byId('pilotCloseReport')];
    reportBusy = true;
    controls.forEach(control => { control.disabled = true; });
    try {
      const result = await call(active, 'report', { ...reportTarget, reason });
      if (request !== active) return;
      if (!result.saved) throw new Error('Report unconfirmed');
      reportDialog.close();
      toast('Жалоба отправлена.');
    } catch (error) {
      if (request === active) status(byId('pilotReportStatus'), failed(error), true);
    } finally {
      reportBusy = false;
      controls.forEach(control => { control.disabled = false; });
    }
  });

  document.querySelector('main').addEventListener('click', async event => {
    const control = event.target.closest('[data-social-action="shift-chat"]');
    const active = request;
    if (!control || !active || control.disabled) return;
    control.disabled = true;
    const returnPage = page;
    try {
      const value = await call(active, 'shift_thread', {
        shift_id: control.dataset.socialShift,
        application_id: control.dataset.socialApplication
      });
      if (request === active && page === returnPage) openThread(value.thread_id, control.dataset.socialPeer);
    } catch (error) {
      if (request === active) toast(failed(error));
    } finally {
      control.disabled = false;
    }
  });

  function refreshChat() {
    if (page === 'messagesPage' && request && !document.hidden) {
      if (thread) loadMessages();
      else loadInbox();
    }
  }

  function show(next) {
    if (page === 'messagesPage' && next !== page) {
      ++inboxVersion;
      loadingInbox = false;
    }
    page = next;
    if (next === 'searchPage') loadCatalog();
    if (next === 'profilePage' && !preferences && !settingsBusy) loadSettings();
    if (next !== 'messagesPage') return;
    byId('pilotInbox').hidden = !!thread;
    byId('pilotConversation').hidden = !thread;
    status(inboxStatus, request ? '' : 'Войдите через Telegram для доступа к чатам.');
    if (thread) {
      byId('pilotPeer').textContent = thread.name;
      showComposerState(thread);
    }
    refreshChat();
  }

  document.addEventListener('visibilitychange', refreshChat);
  byId('pilotDemoSearch').hidden = true;
  byId('pilotDemoMessages').hidden = true;
  byId('pilotCatalog').hidden = false;
  byId('pilotChats').hidden = false;
  settingsForm.hidden = false;

  return {
    show,
    connect(run) {
      request = run;
      show(document.querySelector('.page.active')?.id ?? 'homePage');
      clearInterval(pollTimer);
      pollTimer = setInterval(refreshChat, 8_000);
      const active = request;
      call(active, 'threads', { page: 0 }).then(value => {
        if (request === active && page !== 'messagesPage') setUnread(value.items);
      }).catch(() => {});
    },
    disconnect() {
      request = null;
      preferences = null;
      settingsBusy = false;
      reportBusy = false;
      reportTarget = null;
      thread = null;
      ++catalogVersion;
      ++inboxVersion;
      loadingInbox = false;
      contactRequests.clear();
      clearInterval(pollTimer);
      catalogFilter = {};
      catalogPage = 0;
      connectionPage = 0;
      threadPage = 0;
      filterForm.reset();
      settingsForm.reset();
      messageField.value = '';
      messageField.disabled = true;
      sendButton.disabled = true;
      byId('pilotReportForm').reset();
      if (reportDialog.open) reportDialog.close();
      settingsFields.disabled = true;
      status(byId('pilotSettingsStatus'), 'Войдите через Telegram для изменения настроек.');
      status(chatStatus, '');
      byId('pilotSettingsRetry').hidden = true;
      byId('pilotCatalogPaging').hidden = true;
      byId('pilotMoreConnections').hidden = true;
      byId('pilotMoreThreads').hidden = true;
      byId('pilotPreviousConnections').hidden = true;
      byId('pilotPreviousThreads').hidden = true;
      byId('pilotPeer').textContent = '';
      for (const id of ['pilotConnections', 'pilotThreadList', 'pilotCatalogItems', 'pilotChatHistory']) {
        const target = byId(id);
        target.replaceChildren();
        delete target.dataset.signature;
      }
      setUnread([]);
      show(page);
    }
  };
}
