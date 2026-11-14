'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const storageKey = 'careslot.apiKey';
  const apiBase = '/api';
  const zone = 'Africa/Lagos';
  const dateFormat = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false });
  const slots = new Map();
  const cooldowns = new Map();
  let apiKey = '', currentSlots = [], selected = null, booking = null;
  let attempt = null, submitting = false, cancelling = false, loadingSlots = false, lookingUp = false;
  let slotRequest = 0, requests = 0, cooldownTimer = null;

  function message(id, text = '', kind = '') {
    const target = $(id);
    target.textContent = text;
    target.className = `message${kind ? ` ${kind}` : ''}`;
  }
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function validDate(value) { return value && Number.isFinite(Date.parse(value)); }
  function day(value) { return validDate(value) ? dateFormat.format(new Date(value)) : 'Time unavailable'; }
  function time(value) { return validDate(value) ? timeFormat.format(new Date(value)) : 'Unavailable'; }
  function schedule(slot) {
    return `${day(slot.start)}, ${time(slot.start)}–${time(slot.end)} WAT`;
  }
  function remaining() {
    const email = $('patient-email').value.trim().toLowerCase();
    return Math.max(0, Math.ceil(((cooldowns.get(email) || 0) - Date.now()) / 1000));
  }
  function hasText(id) { return $(id).value.trim().length > 0; }
  function validBookingDetails() {
    const name = $('patient-name').value.trim();
    const email = $('patient-email').value.trim();
    return name.length > 0 && name.length <= 200 && email.length <= 254 &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && $('patient-email').validity.valid;
  }
  function updateControls() {
    const busy = requests > 0 || loadingSlots || submitting || cancelling || lookingUp;
    const keyReady = hasText('api-key');
    const slotReady = !!selected && usable(selected);
    const detailsReady = validBookingDetails();
    const referenceReady = hasText('booking-id');
    const wait = remaining();
    $('connect-button').disabled = !keyReady || busy;
    $('provider').disabled = !apiKey || busy;
    // Provider is optional: an empty filter must still be able to show all slots.
    $('filter-button').disabled = !apiKey || busy;
    $('refresh-button').disabled = !apiKey || busy;
    $('slot-options').disabled = !apiKey || busy;
    $('booking-fields').disabled = !apiKey || !slotReady || busy;
    $('book-button').disabled = !apiKey || !slotReady || !detailsReady || busy || wait > 0;
    $('book-button').textContent = submitting ? 'Confirming…' : wait ? `Try again in ${wait}s` : 'Confirm appointment';
    $('booking-id').disabled = !apiKey || busy;
    $('lookup-button').disabled = !apiKey || !referenceReady || busy;
    $('lookup-button').textContent = lookingUp ? 'Finding…' : 'Find booking';
    $('cancel-button').disabled = !booking || booking.status !== 'confirmed' || busy;
    $('cancel-yes').disabled = !booking || booking.status !== 'confirmed' || busy;
    $('cancel-no').disabled = cancelling;
    $('cancel-yes').textContent = cancelling ? 'Cancelling…' : 'Yes, cancel appointment';
    $('access-ready-hint').textContent = busy ? 'Wait for the current request to finish.' : keyReady ? 'API key entered. You can connect.' : 'Enter your API key to enable Connect.';
    $('booking-ready-hint').textContent = !apiKey ? 'Connect with your API key first.' :
      !slotReady ? 'Choose an available appointment first.' :
      !hasText('patient-name') ? 'Enter your full name to continue.' :
      !hasText('patient-email') ? 'Enter your email address to continue.' :
      !detailsReady ? 'Enter a valid email address, for example alex@example.com. Name and email must fit their field limits.' :
      wait > 0 ? `Wait ${wait} seconds before trying again with this email.` :
      busy ? 'Wait for the current request to finish.' : 'All required details are filled. You can confirm your appointment.';
    $('lookup-ready-hint').textContent = !apiKey ? 'Connect with your API key first.' :
      !referenceReady ? 'Enter a booking reference to enable Find booking.' :
      busy ? 'Wait for the current request to finish.' : 'Booking reference entered. You can look it up.';
  }
  class ApiError extends Error {
    constructor(text, status, retryAfter) { super(text); this.status = status; this.retryAfter = retryAfter; }
  }
  async function request(url, options = {}) {
    if (!apiKey) throw new ApiError('Connect with your API key first.', 401);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    requests++;
    updateControls();
    try {
      const response = await fetch(apiBase + url, {
        method: options.method || 'GET',
        headers: { Accept: 'application/json', 'X-API-Key': apiKey, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}) },
        ...(options.body ? { body: options.body } : {}),
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'same-origin'
      });
      let data;
      try { data = await response.json(); } catch (_) { data = null; }
      if (!response.ok) {
        const raw = response.headers.get('Retry-After');
        const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : raw ? Math.max(0, Math.ceil((Date.parse(raw) - Date.now()) / 1000)) : 60;
        throw new ApiError(data && typeof data.error === 'string' ? data.error : `Request failed (${response.status}).`, response.status, Number.isFinite(seconds) ? seconds : 60);
      }
      if (!data || typeof data !== 'object') throw new Error('The API returned an unreadable response.');
      return data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new Error(error.name === 'AbortError' ? 'The request timed out. Check your connection and try again.' : 'Could not complete the request. Check your connection and try again.');
    } finally {
      clearTimeout(timeout);
      requests--;
      updateControls();
    }
  }
  function errorText(error) {
    if (error.status === 401) return 'API key not accepted. Check your key and reconnect.';
    if (error.status === 429) return `Too many requests. Try again in ${error.retryAfter} seconds.`;
    return error.message;
  }
  function cacheSlots(list) {
    if (!Array.isArray(list)) throw new Error('The API did not return a slots array.');
    list.forEach(slot => slots.set(slot.id, slot));
  }
  function usable(slot) {
    return slot.available === true && validDate(slot.start) && Date.parse(slot.start) > Date.now();
  }
  function renderSelection() {
    const target = $('selected-slot');
    target.replaceChildren();
    if (!selected) {
      target.append(element('span', 'muted', 'No time selected'), element('p', '', 'Choose an available appointment to get started.'));
    } else {
      target.append(element('strong', '', selected.provider), element('p', '', schedule(selected)));
    }
    updateControls();
  }
  function renderSlots() {
    const list = $('slots-list');
    list.replaceChildren();
    const count = currentSlots.filter(usable).length;
    $('slot-count').textContent = `${count} available appointment${count === 1 ? '' : 's'}${$('provider').value.trim() ? ' for this provider' : ''}`;
    if (!currentSlots.length) {
      const empty = element('div', 'empty-state');
      empty.append(element('h3', '', 'No appointments found'), element('p', '', 'Try another exact provider name or refresh the schedule.'));
      list.append(empty);
      return;
    }
    if (!count) message('slots-message', 'No future appointments are available in this schedule. Try a different provider or refresh.');
    currentSlots.forEach(slot => {
      const available = usable(slot);
      const label = element('label', `slot-option${available ? '' : ' unavailable'}`);
      const radio = element('input');
      radio.type = 'radio'; radio.name = 'slot'; radio.value = slot.id;
      radio.disabled = !available; radio.checked = selected?.id === slot.id;
      const status = available ? 'Available' : Date.parse(slot.start) <= Date.now() ? 'Past' : 'Unavailable';
      radio.setAttribute('aria-label', `${slot.provider}, ${schedule(slot)}, ${status}`);
      const content = element('div', 'slot-content');
      content.append(element('div', 'slot-provider', slot.provider), element('div', 'slot-date', day(slot.start)), element('div', 'slot-time', `${time(slot.start)}–${time(slot.end)} WAT`));
      radio.addEventListener('change', () => {
        selected = slot;
        attempt = null;
        message('booking-message');
        renderSelection();
      });
      label.append(radio, content, element('span', 'slot-label', status));
      list.append(label);
    });
  }
  async function loadSlots() {
    const version = ++slotRequest;
    loadingSlots = true;
    $('slots-list').setAttribute('aria-busy', 'true');
    message('slots-message', 'Loading appointment times…');
    updateControls();
    const provider = $('provider').value.trim();
    try {
      const data = await request(`/slots${provider ? `?${new URLSearchParams({ provider })}` : ''}`);
      if (version !== slotRequest) return false;
      cacheSlots(data.slots);
      currentSlots = data.slots;
      if (selected) {
        selected = currentSlots.find(slot => slot.id === selected.id && usable(slot)) || null;
        if (!selected) attempt = null;
      }
      message('slots-message');
      renderSlots();
      renderSelection();
      if (booking) renderBooking(false);
      return true;
    } catch (error) {
      if (version !== slotRequest) return false;
      // Do not leave stale times bookable after a failed refresh.
      currentSlots = []; selected = null;
      $('slots-list').replaceChildren(element('div', 'empty-state', 'The schedule could not be loaded. Refresh to try again.'));
      $('slot-count').textContent = 'Schedule unavailable';
      renderSelection();
      message('slots-message', errorText(error), 'error');
      return false;
    } finally {
      if (version === slotRequest) {
        loadingSlots = false;
        $('slots-list').setAttribute('aria-busy', 'false');
        updateControls();
      }
    }
  }
  function addDetail(label, value, className = '') {
    const group = element('div');
    group.append(element('dt', '', label), element('dd', className, value));
    $('result-details').append(group);
  }
  function renderBooking(focus = true) {
    $('booking-result').hidden = false;
    $('result-status').textContent = booking.status;
    $('result-status').className = `status-badge${booking.status === 'cancelled' ? ' cancelled' : ''}`;
    $('result-details').replaceChildren();
    addDetail('Booking reference', booking.id, 'reference');
    addDetail('Name', booking.name);
    addDetail('Email', booking.email);
    const slot = slots.get(booking.slot_id);
    addDetail('Provider', slot ? slot.provider : 'Unavailable');
    addDetail('Appointment · WAT (UTC+1)', slot ? schedule(slot) : `Time unavailable. Slot reference: ${booking.slot_id}`);
    addDetail('Booked at · WAT (UTC+1)', `${day(booking.created_at)}, ${time(booking.created_at)}`);
    $('cancel-actions').hidden = booking.status !== 'confirmed';
    $('cancel-confirm').hidden = true;
    $('cancel-button').hidden = false;
    if (focus) $('booking-result').focus();
  }
  function newIdempotencyKey() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  $('access-form').addEventListener('submit', async event => {
    event.preventDefault();
    const key = $('api-key').value.trim();
    updateControls();
    if ($('connect-button').disabled) return;
    apiKey = key;
    slots.clear(); currentSlots = []; selected = null; booking = null; attempt = null;
    $('booking-result').hidden = true;
    message('booking-message'); message('lookup-message'); message('result-message');
    try {
      if ($('remember-key').checked) sessionStorage.setItem(storageKey, key);
      else sessionStorage.removeItem(storageKey);
    } catch (_) {
      $('remember-key').checked = false;
      message('access-message', 'Session storage is unavailable. Your key will stay in memory only.');
    }
    renderSelection();
    message('access-message', 'Connecting…');
    const loaded = await loadSlots();
    message('access-message', loaded ? 'Connected. Choose an appointment below.' : 'Connection could not be verified. Check the schedule message below.', loaded ? 'success' : 'error');
    $('connect-button').textContent = 'Reconnect';
  });
  ['api-key', 'booking-id'].forEach(id => {
    ['input', 'change'].forEach(event => $(id).addEventListener(event, updateControls));
  });
  $('remember-key').addEventListener('change', () => {
    if (!$('remember-key').checked) {
      try { sessionStorage.removeItem(storageKey); } catch (_) { /* Memory remains available. */ }
    }
  });
  $('filter-form').addEventListener('submit', event => { event.preventDefault(); loadSlots(); });
  $('refresh-button').addEventListener('click', loadSlots);
  ['patient-name', 'patient-email'].forEach(id => {
    ['input', 'change'].forEach(event => $(id).addEventListener(event, () => {
      attempt = null;
      message('booking-message');
      updateControls();
    }));
  });
  $('booking-form').addEventListener('submit', async event => {
    event.preventDefault();
    updateControls();
    if ($('book-button').disabled) return;
    const name = $('patient-name').value.trim();
    const email = $('patient-email').value.trim().toLowerCase();
    if (!name || !email) { message('booking-message', 'Enter a name and a valid email address.', 'error'); return; }
    const body = JSON.stringify({ slot_id: selected.id, name, email });
    if (!attempt || attempt.body !== body) attempt = { body, key: newIdempotencyKey() };
    submitting = true;
    $('booking-form').setAttribute('aria-busy', 'true');
    message('booking-message', 'Confirming your appointment…');
    updateControls();
    try {
      booking = await request('/bookings', { method: 'POST', body, idempotencyKey: attempt.key });
      attempt = null;
      $('booking-id').value = booking.id;
      message('result-message'); message('lookup-message');
      renderBooking();
      message('booking-message', 'Appointment confirmed. Save the booking reference shown below.', 'success');
      selected = null;
      renderSelection();
      await loadSlots();
    } catch (error) {
      if (error.status === 409) {
        attempt = null;
        message('booking-message', 'That appointment was just booked. The schedule is being refreshed. Please choose another time.', 'error');
        await loadSlots();
      } else if (error.status === 429) {
        cooldowns.set(email, Date.now() + error.retryAfter * 1000);
        message('booking-message', errorText(error), 'error');
        if (!cooldownTimer) cooldownTimer = setInterval(() => {
          updateControls();
          if ([...cooldowns.values()].every(until => until <= Date.now())) { clearInterval(cooldownTimer); cooldownTimer = null; }
        }, 1000);
      } else {
        if (error.status) attempt = null;
        message('booking-message', error.status ? errorText(error) : `${errorText(error)} The outcome is unconfirmed. Submit the same details again to safely retry with the same booking request key.`, 'error');
        if (error.status === 400 || error.status === 404) await loadSlots();
      }
    } finally {
      submitting = false;
      $('booking-form').setAttribute('aria-busy', 'false');
      updateControls();
    }
  });
  $('lookup-form').addEventListener('submit', async event => {
    event.preventDefault();
    const id = $('booking-id').value.trim();
    updateControls();
    if ($('lookup-button').disabled) return;
    lookingUp = true;
    $('lookup-form').setAttribute('aria-busy', 'true');
    $('booking-result').hidden = true;
    message('lookup-message', 'Finding your booking…');
    message('result-message');
    updateControls();
    try {
      booking = await request(`/bookings/${encodeURIComponent(id)}`);
      let warning = '';
      if (!slots.has(booking.slot_id)) {
        try { const data = await request('/slots'); cacheSlots(data.slots); }
        catch (_) { warning = 'Booking found, but its appointment time could not be loaded. Try the lookup again to refresh it.'; }
      }
      renderBooking();
      message('lookup-message', warning || 'Booking found.', warning ? 'error' : 'success');
    } catch (error) {
      booking = null;
      message('lookup-message', error.status === 404 ? 'No booking found with that reference. Check the ID and try again.' : errorText(error), 'error');
    } finally {
      lookingUp = false;
      $('lookup-form').setAttribute('aria-busy', 'false');
      updateControls();
    }
  });
  $('cancel-button').addEventListener('click', () => {
    $('cancel-confirm').hidden = false; $('cancel-button').hidden = true; $('cancel-yes').focus();
  });
  $('cancel-no').addEventListener('click', () => {
    $('cancel-confirm').hidden = true; $('cancel-button').hidden = false; $('cancel-button').focus();
  });
  $('cancel-yes').addEventListener('click', async () => {
    if (!booking || cancelling) return;
    cancelling = true;
    message('result-message', 'Cancelling appointment…');
    updateControls();
    try {
      booking = await request(`/bookings/${encodeURIComponent(booking.id)}`, { method: 'DELETE' });
      renderBooking();
      message('result-message', 'Appointment cancelled. This time is now available again.', 'success');
      await loadSlots();
    } catch (error) {
      if (error.status === 409) {
        try {
          booking = await request(`/bookings/${encodeURIComponent(booking.id)}`);
          renderBooking();
          message('result-message', 'This appointment was already cancelled. Its current status is shown above.');
          await loadSlots();
        } catch (lookupError) { message('result-message', errorText(lookupError), 'error'); }
      } else message('result-message', `${errorText(error)}${error.status ? '' : ' Look up this booking to check whether cancellation completed before trying again.'}`, 'error');
    } finally { cancelling = false; updateControls(); }
  });
  try {
    const saved = sessionStorage.getItem(storageKey);
    if (saved) { $('api-key').value = saved; $('remember-key').checked = true; message('access-message', 'A key was restored for this tab. Select Connect to use it.'); }
  } catch (_) { /* Session storage is optional. */ }
  updateControls();
})();
