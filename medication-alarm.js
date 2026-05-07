// medication-alarm.js — Shared medication reminder.
// Runs on every page where it's included. Plays time_for_medication.mp3,
// shows browser + in-page modal, and inserts a row in `notifications`.

(function () {
  const SB_URL = 'https://binqgggvhbbxetasomhv.supabase.co';
  const SB_KEY =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJpbnFnZ2d2aGJieGV0YXNvbWh2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUzMjQ1MzYsImV4cCI6MjA5MDkwMDUzNn0.oav0nAJDdPJRpx5qNTY7eA7xqIBi9xqCPsJuRDeloe4';

  let _sb = null;
  let _userId = null;
  let _audio = null;
  const _firedToday = new Set();
  let _lastDayKey = '';

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  ready(async () => {
    if (typeof supabase === 'undefined') return;
    _sb = supabase.createClient(SB_URL, SB_KEY);
    const {
      data: { session },
    } = await _sb.auth.getSession();
    if (!session) return;
    _userId = session.user.id;

    _audio = new Audio('time_for_medication.mp3');
    _audio.preload = 'auto';
    _audio.volume = 1.0;

    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }

    checkMedications();
    setInterval(checkMedications, 30 * 1000);
    console.log('💊 Medication alarm service started');
  });

  async function checkMedications() {
    if (!_sb || !_userId) return;

    const now = new Date();
    const dayKey = now.getFullYear() + '-' + now.getMonth() + '-' + now.getDate();
    if (_lastDayKey !== dayKey) {
      _firedToday.clear();
      _lastDayKey = dayKey;
    }

    // JS getDay() 0=Sunday … 6=Saturday
    const daysAr = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
    const todayAr = daysAr[now.getDay()];
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const currentTime = hh + ':' + mm;

    try {
      const { data: persons } = await _sb
        .from('persons')
        .select('id, person_name')
        .eq('user_id', _userId);
      if (!persons || !persons.length) return;

      for (const p of persons) {
        const { data: meds } = await _sb
          .from('medications')
          .select('id, name, dose, times, days, active')
          .eq('person_id', p.id)
          .eq('active', true);
        if (!meds) continue;

        for (const med of meds) {
          if (med.days && med.days.length && med.days.indexOf(todayAr) === -1) continue;
          if (!med.times || med.times.indexOf(currentTime) === -1) continue;

          const key = med.id + '-' + currentTime;
          if (_firedToday.has(key)) continue;
          _firedToday.add(key);

          fireAlarm(med, p, currentTime);
        }
      }
    } catch (e) {
      console.warn('Med check error:', e);
    }
  }

  async function fireAlarm(med, person, time) {
    console.log('🔔 Medication alarm:', med.name, 'for', person.person_name, '@', time);

    // 1) Audio
    try {
      _audio.currentTime = 0;
      const playPromise = _audio.play();
      if (playPromise !== undefined) {
        playPromise.catch((e) => console.warn('audio play (autoplay blocked?):', e));
      }
    } catch (e) {
      console.warn('audio play err:', e);
    }

    // 2) Browser notification
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        const n = new Notification('💊 وقت الدواء', {
          body: person.person_name + ': ' + med.name + (med.dose ? ' - ' + med.dose : ''),
          icon: 'slogan1.jpg',
          tag: 'med-' + med.id + '-' + time,
        });
        n.onclick = () => { window.focus(); n.close(); };
      } catch (e) {}
    }

    // 3) Save to Supabase notifications
    try {
      await _sb.from('notifications').insert([
        {
          user_id: _userId,
          person_id: person.id,
          title: '💊 وقت الدواء: ' + med.name,
          body:
            'حان وقت تناول ' +
            med.name +
            (med.dose ? ' (' + med.dose + ')' : '') +
            ' للفرد ' +
            person.person_name,
          type: 'medication',
          severity: 'info',
          is_read: false,
          data: { med_id: med.id, time, person_id: person.id },
        },
      ]);
    } catch (e) {
      console.warn('notif save:', e);
    }

    // 4) In-page modal
    showMedAlert(med, person);

    // Refresh badge if available
    if (window.refreshNotifBadge) window.refreshNotifBadge();
  }

  function showMedAlert(med, person) {
    if (document.getElementById('med-alert-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'med-alert-overlay';
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99999;' +
      'display:flex;align-items:center;justify-content:center;' +
      'animation:medFadeIn .3s;font-family:Tajawal,sans-serif';

    overlay.innerHTML =
      '<style>' +
      '@keyframes medFadeIn{from{opacity:0}to{opacity:1}}' +
      '@keyframes medSlideIn{from{opacity:0;transform:translateY(20px) scale(.95)}to{opacity:1;transform:translateY(0) scale(1)}}' +
      '@keyframes medPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.08)}}' +
      '</style>' +
      '<div style="background:white;border-radius:24px;padding:32px;max-width:380px;text-align:center;' +
      'box-shadow:0 20px 60px rgba(0,0,0,.3);animation:medSlideIn .4s">' +
      '<div style="font-size:60px;margin-bottom:12px;animation:medPulse 1.2s infinite">💊</div>' +
      '<h2 style="color:#406E8F;font-size:22px;font-weight:900;margin:0 0 8px">وقت الدواء!</h2>' +
      '<p style="color:#0a2a52;font-size:18px;font-weight:800;margin:0 0 4px">' + escapeHtml(med.name) + '</p>' +
      (med.dose ? '<p style="color:#888;font-size:14px;margin:0 0 8px">' + escapeHtml(med.dose) + '</p>' : '') +
      '<p style="color:#666;font-size:13px;margin:0 0 20px">للفرد: ' + escapeHtml(person.person_name) + '</p>' +
      '<button id="med-alert-ok" style="background:#406E8F;color:white;border:none;border-radius:50px;' +
      'padding:12px 32px;font-size:14px;font-weight:800;cursor:pointer;font-family:inherit">' +
      '✓ تم، سأتناوله الآن</button>' +
      '</div>';

    document.body.appendChild(overlay);
    document.getElementById('med-alert-ok').onclick = () => {
      overlay.remove();
      try { _audio.pause(); _audio.currentTime = 0; } catch (e) {}
    };
    setTimeout(() => { if (overlay.parentNode) overlay.remove(); }, 60000);
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }
})();