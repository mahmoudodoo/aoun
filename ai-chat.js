// ai-chat.js — Shared AI chat with 3-tier fallback + strict Arabic-only enforcement.
// 1) OpenRouter primary model (with native fallback array, max 3)
// 2) Sequential retry across all listed models
// 3) Local Arabic Q&A database (health_qa.json)
// Plus: persists every conversation to Supabase `ai_chats` table.

(function (window) {
  // ⚠️ Replace with your real OpenRouter key
  const CONFIG = {
    OPENROUTER_KEY: 'sk-or-v1-REPLACE_ME',
    // Models with strong Arabic capability come FIRST.
    MODELS: [
      'qwen/qwen-2.5-72b-instruct:free',          // excellent Arabic
      'meta-llama/llama-3.3-70b-instruct:free',   // strong Arabic
      'google/gemini-2.0-flash-exp:free',         // good Arabic
      'qwen/qwen-2.5-7b-instruct:free',
      'mistralai/mistral-7b-instruct:free',
      'google/gemma-2-9b-it:free',
    ],
  };

  // Bilingual + extremely explicit so even small models obey.
  const SYSTEM_PROMPT =
    'أنت مساعد صحي ذكي اسمه "عَوْن". ' +
    'قاعدة صارمة لا يجوز خرقها أبداً: يجب أن تجيب باللغة العربية الفصحى فقط. ' +
    'حتى إذا كتب المستخدم بالإنجليزية أو بأي لغة أخرى، افهم سؤاله ولكن أجب دائماً بالعربية. ' +
    'لا تستخدم أي كلمات إنجليزية في إجابتك (إلا أسماء أدوية أو مصطلحات طبية معروفة). ' +
    'أجب بشكل مختصر جداً (2 إلى 3 أسطر كحد أقصى). ' +
    'قدّم نصائح صحية عامة، ولا تُغني إجاباتك عن استشارة الطبيب.\n\n' +
    'STRICT SYSTEM RULE (DO NOT VIOLATE): You MUST respond in ARABIC ONLY. ' +
    'Never use English or any other language in your replies, regardless of what language the user writes in. ' +
    'Keep answers very short (2-3 lines max). Provide general health advice only.';

  // Reminder appended to every user message — final guard against language drift.
  const ARABIC_REMINDER = '\n\n(تذكير: أجب باللغة العربية فقط.)';

  const _history = [{ role: 'system', content: SYSTEM_PROMPT }];
  let _qa = [];
  let _qaLoaded = false;

  // ---------------- Local Q&A ----------------
  async function loadQA() {
    if (_qaLoaded) return;
    try {
      const res = await fetch('health_qa.json');
      const list = await res.json();
      _qa = list.map((e) => {
        const normQ = normalize(e.q || '');
        const tokens = new Set(
          normQ.split(' ').filter((w) => w.length >= 2).map(stem)
        );
        return { q: e.q, a: e.a, normQ, tokens };
      });
      _qaLoaded = true;
      console.log('📚 Loaded ' + _qa.length + ' Q&A entries');
    } catch (e) {
      console.warn('QA load failed:', e);
    }
  }

  function normalize(text) {
    text = text.replace(/[\u064B-\u0652\u0670\u0640]/g, '');
    text = text.replace(/[إأآا]/g, 'ا');
    text = text.replace(/ى/g, 'ي');
    text = text.replace(/ؤ/g, 'و');
    text = text.replace(/ئ/g, 'ي');
    text = text.replace(/ة/g, 'ه');
    text = text.replace(/[?؟!.،,\-_:;]/g, ' ');
    return text.toLowerCase().trim().replace(/\s+/g, ' ');
  }

  function stem(word) {
    if (word.startsWith('ال') && word.length > 3) word = word.substr(2);
    while (word.length > 2 && /^[وفبلك]/.test(word)) word = word.substr(1);
    return word;
  }

  function findLocalAnswer(question) {
    if (_qa.length === 0) return null;
    const normUser = normalize(question);
    const userTokens = new Set(
      normUser.split(' ').filter((w) => w.length >= 2).map(stem)
    );
    if (userTokens.size === 0) return null;

    let bestScore = 0;
    let best = null;

    for (const e of _qa) {
      if (e.tokens.size === 0) continue;
      let common = 0;
      for (const t of userTokens) if (e.tokens.has(t)) common++;
      let score =
        (common / userTokens.size) * 0.7 + (common / e.tokens.size) * 0.3;
      if (e.normQ.includes(normUser) || normUser.includes(e.normQ))
        score += 0.25;
      if (score > bestScore) {
        bestScore = score;
        best = e;
      }
    }
    return best && bestScore >= 0.35 ? best.a : null;
  }

  // ---------------- Language detection ----------------
  // Returns true if the response is mostly NOT Arabic (likely English).
  function isNotArabic(text) {
    if (!text) return false;
    const cleaned = text.replace(/[\d\s.,!?؟،:;()\-_'"+*\/]/g, '');
    if (cleaned.length < 5) return false;
    const arabicCount = (cleaned.match(/[\u0600-\u06FF]/g) || []).length;
    const latinCount = (cleaned.match(/[a-zA-Z]/g) || []).length;
    // If less than 60% of letters are Arabic, treat as wrong-language reply.
    return arabicCount / Math.max(1, arabicCount + latinCount) < 0.6;
  }

  // ---------------- OpenRouter ----------------
  async function callModel(key, primaryModel, fallbackModels, extraSystem) {
    const messages = _history.slice();
    if (extraSystem) {
      messages.push({ role: 'system', content: extraSystem });
    }

    const body = {
      model: primaryModel,
      messages: messages,
      max_tokens: 240,
      temperature: 0.4, // lower = more compliant with the system rule
    };
    if (fallbackModels && fallbackModels.length) body.models = fallbackModels;

    try {
      const res = await fetch(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + key,
            'HTTP-Referer': window.location.origin || 'https://aoun.app',
            'X-OpenRouter-Title': 'Aoun Health Web',
            'X-Title': 'Aoun Health Web',
          },
          body: JSON.stringify(body),
        }
      );
      if (res.status !== 200) {
        return { ok: false, status: res.status, body: await res.text() };
      }
      const data = await res.json();
      const content =
        data.choices && data.choices[0] && data.choices[0].message
          ? (data.choices[0].message.content || '').trim()
          : '';
      return { ok: true, status: 200, content, model: data.model || primaryModel };
    } catch (e) {
      return { ok: false, status: null, error: String(e) };
    }
  }

  async function tryOpenRouter() {
    const key = CONFIG.OPENROUTER_KEY;
    if (!key || key.indexOf('REPLACE_ME') !== -1)
      return { reply: null, lastStatus: null };

    let lastStatus = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      for (let i = 0; i < CONFIG.MODELS.length; i++) {
        const primary = CONFIG.MODELS[i];
        const fallbacks = CONFIG.MODELS.slice(i + 1, i + 4); // max 3

        let result = await callModel(key, primary, fallbacks);
        lastStatus = result.status;

        if (!result.ok) {
          console.warn('OpenRouter ' + primary + ' -> ' + result.status);
          if (result.status === 401 || result.status === 402 || result.status === 403) {
            return { reply: null, lastStatus };
          }
          continue;
        }

        let content = result.content;

        // Language guard — if model replied in English, retry once with
        // an extra system message demanding Arabic.
        if (content && isNotArabic(content)) {
          console.warn('⚠️ Reply not in Arabic, retrying with stricter prompt:', content.substring(0, 60));
          const retry = await callModel(
            key,
            primary,
            fallbacks,
            'IMPORTANT: Your previous answer used the wrong language. ' +
              'Translate it into Arabic now and respond ONLY in Arabic (العربية). ' +
              'لا تستعمل الإنجليزية إطلاقاً.'
          );
          if (retry.ok && retry.content && !isNotArabic(retry.content)) {
            content = retry.content;
          } else if (retry.ok && retry.content) {
            // Still wrong? skip this model.
            continue;
          }
        }

        if (content) {
          console.log('✅ AI reply via ' + (result.model || primary));
          return { reply: content, lastStatus };
        }
      }
      if (attempt === 0) await new Promise((r) => setTimeout(r, 800));
    }
    return { reply: null, lastStatus };
  }

  // ---------------- Persistence ----------------
  async function saveExchange(sb, userMsg, reply, source) {
    if (!sb) return;
    try {
      const sess = await sb.auth.getSession();
      const userId =
        sess && sess.data && sess.data.session
          ? sess.data.session.user.id
          : null;
      if (!userId) return;
      await sb.from('ai_chats').insert([
        { user_id: userId, role: 'user', content: userMsg, source },
        { user_id: userId, role: 'assistant', content: reply, source },
      ]);
    } catch (e) {
      console.warn('save chat error:', e);
    }
  }

  async function loadHistory(sb, limit) {
    limit = limit || 50;
    try {
      const sess = await sb.auth.getSession();
      const userId =
        sess && sess.data && sess.data.session
          ? sess.data.session.user.id
          : null;
      if (!userId) return [];
      const { data } = await sb
        .from('ai_chats')
        .select('role, content, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: true })
        .limit(limit);
      return data || [];
    } catch (e) {
      console.warn('load chat history:', e);
      return [];
    }
  }

  // ---------------- Public API ----------------
  async function ask(userMsg, sb) {
    await loadQA();

    // Push user message WITH the Arabic reminder appended (invisible to user
    // since we only display the original text in the UI).
    _history.push({ role: 'user', content: userMsg + ARABIC_REMINDER });

    const { reply: orReply } = await tryOpenRouter();

    let reply, source;
    if (orReply) {
      reply = orReply;
      source = 'openrouter';
    } else {
      const local = findLocalAnswer(userMsg);
      if (local) {
        reply = local;
        source = 'local_qa';
        console.log('📚 Reply from local Q&A');
      } else {
        reply =
          'عذراً، المساعد غير متاح حالياً ولم أجد إجابة محفوظة. ' +
          'حاول صياغة السؤال بطريقة أخرى أو استشر طبيبك.';
        source = 'fallback';
      }
    }

    // Final safety net: if for any reason we still have a non-Arabic reply,
    // append a small Arabic note so the user sees something sensible.
    if (isNotArabic(reply) && source !== 'fallback') {
      console.warn('⚠️ Final reply still not Arabic, switching to fallback note');
      reply =
        'عذراً، تعذر الحصول على رد بالعربية الآن. حاول مرة أخرى أو أعد صياغة سؤالك.';
      source = 'fallback';
    }

    _history.push({ role: 'assistant', content: reply });
    if (_history.length > 20) _history.splice(1, _history.length - 18);

    saveExchange(sb, userMsg, reply, source);
    return reply;
  }

  function speak(text) {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ar-SA';
    u.rate = 1;
    u.pitch = 1;
    window.speechSynthesis.speak(u);
  }

  function stopSpeaking() {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }

  function resetConversation() {
    _history.splice(1, _history.length);
  }

  // Pre-load Q&A in background so the first question is fast
  loadQA();

  window.AounAIChat = {
    ask,
    speak,
    stopSpeaking,
    loadHistory,
    resetConversation,
  };
})(window);